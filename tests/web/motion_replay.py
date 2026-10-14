"""Scripted play for checking how the figures move (issue #58), before the engine plays it.

Serves the match page with a feed that follows docs/protocol.md: a hello, a snapshot
every two steps of a small copy of the engine's movement (60 steps a second), touches
and, with --decisions, decision messages. Players face one way while they move another,
as the engine's `face` points let them. Stations round the left half each repeat one kind
of movement, and the right half plays a passage with the ball, each team attacking its
own way: a dribble, a sprint knocking the ball on (touch kind "knock"), a diagonal carry,
a defender jockeying, a shield, a pass out wide, a cross, a standing tackle and a lofted
through ball. A probe added to the page pins the camera on a station or a player and
measures foot sliding and lockstep (tests/web/motion-probe.mjs).

    uv run python tests/web/motion_replay.py               # scripted play, port 8796
    uv run python tests/web/motion_replay.py --decisions   # as model players, with decisions
    uv run python tests/web/motion_replay.py --live        # a real keyless match, with the probe
    uv run python tests/web/motion_replay.py --ref develop # the page as committed there, to compare

Open http://127.0.0.1:8796/ and press h for the probe's keys. Every page that connects
gets play from the start. This is a tool for looking, not a test: pytest and
node --test collect neither file.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import math
import mimetypes
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

HERE = Path(__file__).parent
WEB = HERE.parent.parent / "src" / "decision_pitch" / "web"
PROBE = HERE / "motion-probe.mjs"

# The engine's movement and ball, as src/decision_pitch/physics.py and match.py have them
# with the `face` points of issue #57. Kept in step with them by hand.
STEP = 1 / 60
SNAPSHOT_EVERY = 2
TOP_SPEED = 7.5
ACCELERATION = 4.0
TURN_RATE = 9.0  # rad/s standing; a running player turns more slowly
SIDE_SPEED = 4.0  # m/s: the fastest a player moves keeping its facing well away from its way
SIDE_TURN = 3.0
DIAGONAL = 0.5  # cosine: a way within 60 degrees of the point faced is run without turning
PLAYER_RADIUS = 0.4
CONTROL = 0.75
CONTROL_HEIGHT = 0.9
DRIBBLE = 0.6
KICK_RECOVERY = 0.25
RECENT_TOUCHES = 0.1
KNOCK = 3.5  # m/s faster than the runner that a sprint knocks the ball on
BALL_RADIUS = 0.11
GRAVITY = 9.81
DRAG = 0.013
ROLLING = 1.2
BOUNCE = 0.55
GRIP = 0.85
SETTLE = 1.0
WALK, JOG, DRIBBLE_SPEED = 1.5, 5.0, 6.0

PITCH = {"length": 105, "width": 68, "goalWidth": 7.32, "goalHeight": 2.44}
COLOURS = (
    {"shirt": "#1f5fbf", "shorts": "#ffffff", "keeper": "#f2c230"},
    {"shirt": "#e0562b", "shorts": "#1b1b1b", "keeper": "#3fbf6f"},
)


def wrap(angle: float) -> float:
    return (angle + math.pi) % (2 * math.pi) - math.pi


@dataclass
class Body:
    id: int
    team: int
    name: str
    position: str = "MF"
    x: float = 0.0
    y: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    heading: float = 0.0
    # (x, y, speed, face): run to (x, y) at up to `speed` keeping `face` (a point) in view
    # where the engine would; None stands still.
    command: tuple | None = None
    kick: tuple | None = None  # (angle, speed, loft, kind) to play once it has the ball
    takes_ball: bool = False  # only the players in the passage may take the ball
    decision: str | None = None

    @property
    def speed(self) -> float:
        return math.hypot(self.vx, self.vy)

    def place(self, x: float, y: float, heading: float = 0.0) -> None:
        self.x, self.y, self.heading, self.vx, self.vy = x, y, heading, 0.0, 0.0


@dataclass
class Ball:
    x: float = 0.0
    y: float = 0.0
    z: float = BALL_RADIUS
    vx: float = 0.0
    vy: float = 0.0
    vz: float = 0.0


def _turn(p: Body, angle: float) -> float:
    turn = wrap(angle - p.heading)
    most = TURN_RATE / (1 + p.speed / 3) * STEP
    p.heading = wrap(p.heading + max(-most, min(most, turn)))
    return turn


def _keeps_facing(p: Body, travel: float, look: float, want: float) -> bool:
    if math.cos(travel - look) > DIAGONAL:
        return True
    running = math.cos(travel - p.heading) > math.cos(look - p.heading)
    return want <= (SIDE_TURN if running else SIDE_SPEED)


def step_player(p: Body) -> None:
    tx, ty, speed, face = p.command or (p.x, p.y, 0.0, None)
    dx, dy = tx - p.x, ty - p.y
    dist = math.hypot(dx, dy)
    want, way = 0.0, p.heading
    look = None if face is None else math.atan2(face[1] - p.y, face[0] - p.x)
    if speed > 0 and dist > 0.05:
        want = min(speed, TOP_SPEED, math.sqrt(2 * ACCELERATION * dist))
        travel = math.atan2(dy, dx)
        if look is not None and _keeps_facing(p, travel, look, want):
            _turn(p, look)
            way = travel
            off = math.cos(travel - p.heading)
            want = min(want, SIDE_SPEED + (want - SIDE_SPEED) * max(0.0, off))
        else:
            turn = _turn(p, travel)
            way = p.heading
            want *= max(0.0, math.cos(turn))  # slow down to turn
    elif look is not None:
        _turn(p, look)
    ax, ay = want * math.cos(way) - p.vx, want * math.sin(way) - p.vy
    change = math.hypot(ax, ay)
    if change > ACCELERATION * STEP:
        ax, ay = ax / change * ACCELERATION * STEP, ay / change * ACCELERATION * STEP
    p.vx += ax
    p.vy += ay
    p.x += p.vx * STEP
    p.y += p.vy * STEP


def separate(bodies: list[Body]) -> None:
    for i, p in enumerate(bodies):
        for q in bodies[i + 1 :]:
            dx, dy = q.x - p.x, q.y - p.y
            dist = math.hypot(dx, dy)
            if dist >= 2 * PLAYER_RADIUS:
                continue
            nx, ny = (dx / dist, dy / dist) if dist > 0 else (1.0, 0.0)
            push = (2 * PLAYER_RADIUS - dist) / 2
            p.x, p.y, q.x, q.y = p.x - nx * push, p.y - ny * push, q.x + nx * push, q.y + ny * push


def step_ball(b: Ball, dt: float = STEP) -> None:
    if b.z <= BALL_RADIUS and b.vz == 0:
        h = math.hypot(b.vx, b.vy)
        if h > 0:
            keep = max(0.0, h - (ROLLING + DRAG * h * h) * dt) / h
            b.vx, b.vy = b.vx * keep, b.vy * keep
    else:
        b.vz -= GRAVITY * dt
        k = DRAG * math.sqrt(b.vx**2 + b.vy**2 + b.vz**2) * dt
        b.vx, b.vy, b.vz = b.vx - k * b.vx, b.vy - k * b.vy, b.vz - k * b.vz
    b.x, b.y, b.z = b.x + b.vx * dt, b.y + b.vy * dt, b.z + b.vz * dt
    if b.z < BALL_RADIUS:
        b.z = BALL_RADIUS
        if b.vz < -SETTLE:
            b.vz, b.vx, b.vy = -b.vz * BOUNCE, b.vx * GRIP, b.vy * GRIP
        else:
            b.vz = 0.0


def flight(x: float, y: float, angle: float, speed: float, loft: float, seconds: float = 4.0):
    """Where a ball kicked from (x, y) first comes down to a playable height, and when."""
    b = Ball(
        x,
        y,
        BALL_RADIUS + (0.01 if loft > 0 else 0.0),
        speed * math.cos(loft) * math.cos(angle),
        speed * math.cos(loft) * math.sin(angle),
        speed * math.sin(loft),
    )
    t = 0.0
    while t < seconds:
        step_ball(b)
        t += STEP
        if b.vz < 0 and b.z <= CONTROL_HEIGHT - 0.1:
            break
    return b.x, b.y, t


def lofted(x: float, y: float, tx: float, ty: float, loft: float) -> tuple[float, float]:
    """The angle and speed that drop a ball kicked at `loft` near (tx, ty)."""
    angle = math.atan2(ty - y, tx - x)
    want = math.hypot(tx - x, ty - y)
    low, high = 3.0, 30.0
    for _ in range(30):
        mid = (low + high) / 2
        fx, fy, _ = flight(x, y, angle, mid, loft)
        low, high = (mid, high) if math.hypot(fx - x, fy - y) < want else (low, mid)
    return angle, (low + high) / 2


def ahead_of(p: Body, command: tuple, seconds: float) -> tuple[float, float]:
    """Where `p` will be after `seconds` of `command`."""
    copy = Body(0, 0, "", x=p.x, y=p.y, vx=p.vx, vy=p.vy, heading=p.heading, command=command)
    for _ in range(round(seconds / STEP)):
        step_player(copy)
    return copy.x, copy.y


# A station's program is a list of legs, (how long, what to do), played over and over. How
# long is seconds or until(player, world, seconds into the leg). What to do, made by go()
# and stand(), gives the step's command from the player, the world, the seconds into the
# leg and the player's offset from the station's first, so neighbours keep side by side.
def go(x: float, y: float, speed: float, face=None):
    return lambda p, w, u, off: (x + off[0], y + off[1], speed, w.point(face))


def stand(face=None):
    return lambda p, w, u, off: (p.x, p.y, 0.0, w.point(face))


def near(x: float, y: float, within: float = 1.2, longest: float = 12.0):
    return lambda p, w, u: math.hypot(p.x - x, p.y - y) < within or u > longest


@dataclass
class Station:
    name: str
    shows: str
    centre: tuple[float, float]
    bodies: list[Body]
    program: list
    decision: str = "support"
    leg: int = 0
    since: float = 0.0
    starts: list[tuple[float, float, float]] = field(default_factory=list)  # x, y, heading

    def direct(self, world: World) -> None:
        until, _ = self.program[self.leg]
        done = until(self.bodies[0], world, self.since) if callable(until) else self.since >= until
        if done:
            self.leg = (self.leg + 1) % len(self.program)
            self.since = 0.0
        _, act = self.program[self.leg]
        x0, y0, _ = self.starts[0]
        for body, (x, y, _) in zip(self.bodies, self.starts, strict=True):
            body.command = act(body, world, self.since, (x - x0, y - y0))
            body.decision = self.decision
        self.since += STEP


def shuttle(a: tuple, b: tuple, speeds: tuple, face=None, rest: float = 1.0) -> list:
    """From `a` to `b` and back at each of `speeds` in turn, resting at each end."""
    legs = []
    for speed in speeds:
        for x, y in (a, b):
            legs += [(near(x, y, 0.3), go(x, y, speed, face)), (rest, stand(face))]
    return legs


def compass(cx: float, cy: float, reach: float, speed: float, face) -> list:
    """Out and back along each of the eight directions round a fixed facing (here -y)."""
    legs = []
    for k in range(8):
        a = -math.pi / 2 + k * math.pi / 4  # forward is -y, then anticlockwise
        legs += [
            (
                near(cx + reach * math.cos(a), cy + reach * math.sin(a), 0.3),
                go(cx + reach * math.cos(a), cy + reach * math.sin(a), speed, face),
            ),
            (0.6, stand(face)),
            (near(cx, cy, 0.3), go(cx, cy, speed, face)),
            (0.6, stand(face)),
        ]
    return legs


class World:
    """The players, the ball and who has it, stepped like the engine."""

    def __init__(self, decisions: bool = False) -> None:
        self.t = 0.0
        self.ball = Ball()
        self.owner: int | None = None
        self.touches: list[dict] = []
        self.recovering: dict[int, float] = {}
        self.decisions = decisions
        # Home (1 to 11) attacks towards +x, away (12 to 22) towards -x.
        names = [
            "Keeper",
            "Lock 1",
            "Lock 2",
            "Lock 3",
            "Lock 4",
            "Lock 5",
            "Strafe",
            "Compass walk",
            "Dribbler",
            "Winger",
            "Striker",
            "Keeper",
            "Backpedal",
            "Defender",
            "Compass jog",
            "Turn",
            "Curve",
            "Cut",
            "Pace",
            "Idle",
            "Runner",
            "Drift",
        ]
        self.bodies = [Body(i, 0 if i <= 11 else 1, names[i - 1], "GK" if i in (1, 12) else "MF") for i in range(1, 23)]
        self.bench = [Body(i, 0 if i <= 24 else 1, f"Bench {i}", "MF") for i in range(23, 27)]
        b = {body.id: body for body in self.bodies}
        ball = "ball"

        def towards(x: float) -> tuple[float, float]:
            return (x, -1000.0)  # facing the near touchline, where the cameras are

        self.stations = [
            Station(
                "strafe",
                "side-steps left and right facing the near touchline, at 1.4, 3.5 and 4 m/s",
                (-44, 22),
                [b[7]],
                shuttle((-39, 22), (-49, 22), (1.4, 3.5, 4.0), towards(-44)),
            ),
            Station(
                "backpedal",
                "backs off facing -x and comes forward again, at 1.4, 2.5 and 3.5 m/s",
                (-30, 22),
                [b[13]],
                shuttle((-24, 22), (-34, 22), (1.4, 2.5, 3.5), (-80.0, 22.0)),
                "mark",
            ),
            Station(
                "turn",
                "turns on the spot: 90 degrees, 180 degrees, 45 degrees and small adjustments, at the engine's 9 rad/s",
                (-17, 22),
                [b[16]],
                [
                    (1.6, stand((-17 + 10 * math.cos(a), 22 + 10 * math.sin(a))))
                    for a in (
                        -math.pi / 2,
                        0.0,
                        math.pi,
                        -math.pi / 2,
                        -math.pi / 4,
                        -math.pi / 2 + 0.3,
                        -math.pi / 2,
                        math.pi / 2,
                    )
                ],
                decision="hold",
            ),
            Station(
                "drift",
                "drifts slowly (0.3 to 1.2 m/s) facing the ball, as players settling into shape do",
                (-7, 22),
                [b[22]],
                [
                    (near(-7 + dx, 22 + dy, 0.2, 5), go(-7 + dx, 22 + dy, s, ball))
                    for dx, dy, s in ((1.5, 0, 0.4), (1.5, 1.5, 0.8), (-1, 1, 1.2), (-1.5, -1, 0.6), (0, 0, 0.3))
                ],
            ),
            Station(
                "compass-walk",
                "walks out and back in all eight directions, always facing the near touchline",
                (-44, 6),
                [b[8]],
                compass(-44, 6, 3.0, 1.4, towards(-44)),
            ),
            Station(
                "compass-jog",
                "jogs out and back in all eight directions at 4 m/s, always facing the near touchline",
                (-28, 6),
                [b[15]],
                compass(-28, 6, 7.0, 4.0, towards(-28)),
            ),
            Station(
                "cut",
                "runs at 6 m/s and cuts sharply: 90 degrees, 120 degrees and a 45-degree jink, facing its way",
                (-12, 6),
                [b[18]],
                [(near(x, y), go(x, y, 6.0)) for x, y in ((-6, 0), (-6, 12), (-18, 2), (-12, 12), (-18, 12), (-6, 6))],
            ),
            Station(
                "curve",
                "runs round a 5 m circle at about 5 and 6 m/s, leaning in, then stops and runs it the other way",
                (-14, -7),
                [b[17]],
                [
                    (10.0, lambda p, w, u, off: w.circle(p, (-14, -7), 5.0, 5.0, 1)),
                    (8.0, lambda p, w, u, off: w.circle(p, (-14, -7), 5.0, 7.0, 1)),
                    (2.0, stand()),
                    (8.0, lambda p, w, u, off: w.circle(p, (-14, -7), 5.0, 6.0, -1)),
                    (2.0, stand()),
                ],
            ),
            Station(
                "idle",
                "stands still facing the ball: two goalkeepers and an outfield player",
                (-44, -6),
                [b[1], b[12], b[20]],
                [(30.0, stand(ball))],
                decision="hold",
            ),
            Station(
                "pace",
                "speeds up and stops over 42 m, at 7.5, 5, 3 and 1.5 m/s",
                (-28, -18),
                [b[19]],
                shuttle((-8, -18), (-50, -18), (7.5, 5.0, 3.0, 1.5), rest=1.5),
                "press",
            ),
            Station(
                "lockstep",
                "five neighbours 2 m apart do the same thing at once: stand, jog 4 m/s, stand, walk 1.5, stand",
                (-34, -28),
                [b[2], b[3], b[4], b[5], b[6]],
                [
                    (4.0, stand()),
                    (near(-20, -24, 0.3, 10), go(-20, -24, 4.0)),
                    (3.0, stand()),
                    (near(-46, -24, 0.3, 10), go(-46, -24, 4.0)),
                    (2.0, stand()),
                    (near(-36, -24, 0.3, 10), go(-36, -24, 1.5)),
                    (3.0, stand()),
                ],
            ),
        ]
        # Where each station starts, with the five neighbours side by side.
        starts = {
            "lockstep": [(-46, -24 - 2 * k, 0.0) for k in range(5)],
            "idle": [(-47, -6, 0.0), (-44, -6, 0.0), (-41, -6, 0.0)],
            "strafe": [(-44, 22, -math.pi / 2)],
            "backpedal": [(-34, 22, math.pi)],
            "pace": [(-50, -18, 0.0)],
            "cut": [(-18, 0, 0.0)],
            "curve": [(-9, -7, math.pi / 2)],
        }
        for station in self.stations:
            places = starts.get(station.name, [(station.centre[0], station.centre[1], -math.pi / 2)])
            station.starts = places
            for body, (x, y, h) in zip(station.bodies, places, strict=True):
                body.place(x, y, h)
        self.passage = Passage(self, b[9], b[14], b[10], b[11], b[21])

    def point(self, face):
        if face == "ball":
            return (self.ball.x, self.ball.y)
        return face

    def circle(self, p: Body, centre, radius: float, speed: float, sense: int):
        # A point ahead round the circle, far enough ahead to be run at `speed`.
        a = math.atan2(p.y - centre[1], p.x - centre[0]) + sense * (0.6 + 0.11 * speed)
        return (centre[0] + radius * math.cos(a), centre[1] + radius * math.sin(a), speed, None)

    def body(self, pid: int) -> Body:
        return next(b for b in self.bodies if b.id == pid)

    def kick(self, p: Body, angle: float, speed: float, loft: float = 0.0, kind: str = "kick") -> None:
        p.kick = (angle, speed, loft, kind)

    def touched(self, p: Body, kind: str) -> None:
        touch = {
            "player": p.id,
            "kind": kind,
            "t": round(self.t, 3),
            "x": round(self.ball.x, 3),
            "y": round(self.ball.y, 3),
            "z": round(self.ball.z, 3),
        }
        if self.touches and (self.touches[-1]["t"], self.touches[-1]["player"]) == (touch["t"], p.id):
            self.touches.pop()
        self.touches.append(touch)

    def step(self) -> None:
        self.t += STEP
        for pid in list(self.recovering):
            self.recovering[pid] -= STEP
            if self.recovering[pid] <= 0:
                del self.recovering[pid]
        for station in self.stations:
            station.direct(self)
        self.passage.direct()
        for p in self.bodies:
            step_player(p)
        separate(self.bodies)
        b = self.ball
        able = [
            p
            for p in self.bodies
            if p.takes_ball
            and p.id not in self.recovering
            and b.z <= CONTROL_HEIGHT
            and math.hypot(b.x - p.x, b.y - p.y) <= CONTROL
        ]
        if able:
            nearest = min(able, key=lambda p: math.hypot(b.x - p.x, b.y - p.y))
            if nearest.id != self.owner:
                rival = self.owner is not None and self.body(self.owner).team != nearest.team
                self.touched(nearest, "tackle" if rival else "control")
            self.owner = nearest.id
        else:
            self.owner = None
        owner = self.body(self.owner) if self.owner is not None else None
        if owner and owner.kick:
            angle, speed, loft, kind = owner.kick
            owner.kick = None
            self.touched(owner, kind)
            b.vx = speed * math.cos(loft) * math.cos(angle)
            b.vy = speed * math.cos(loft) * math.sin(angle)
            b.vz = speed * math.sin(loft)
            b.z = BALL_RADIUS + (0.01 if loft > 0 else 0.0)
            self.owner = None
            self.recovering[owner.id] = KICK_RECOVERY
            owner.command = None
            step_ball(b)
        elif owner:
            b.vx, b.vy, b.z, b.vz = owner.vx, owner.vy, BALL_RADIUS, 0.0
            b.x = owner.x + math.cos(owner.heading) * DRIBBLE
            b.y = owner.y + math.sin(owner.heading) * DRIBBLE
        else:
            step_ball(b)
        self.touches = [t for t in self.touches if t["t"] >= self.t - RECENT_TOUCHES]

    def hello(self) -> dict:
        def entry(p: Body) -> dict:
            model = "Laya" if self.decisions else None
            return {
                "id": p.id,
                "number": p.id if p.team == 0 else p.id - 11,
                "name": p.name,
                "position": p.position,
                "model": model,
            }

        teams = []
        for team, name in enumerate(("Home", "Away")):
            teams.append(
                {
                    "name": name,
                    "colours": COLOURS[team],
                    "manager": "Built-in",
                    "assistants": [],
                    "players": [entry(p) for p in self.bodies if p.team == team],
                    "bench": [entry(p) for p in self.bench if p.team == team],
                }
            )
        return {"type": "hello", "version": 1, "pitch": PITCH, "teams": teams}

    def snapshot(self) -> dict:
        minutes = self.t / 180 * 45
        b = self.ball
        return {
            "type": "snapshot",
            "t": round(self.t, 3),
            "period": 1,
            "clock": f"{int(minutes):02d}:{int(minutes * 60) % 60:02d}",
            "phase": "play",
            "score": [0, 0],
            "ball": {
                "x": round(b.x, 3),
                "y": round(b.y, 3),
                "z": round(b.z, 3),
                "owner": self.owner,
                "touches": [dict(t) for t in self.touches],
            },
            "players": [
                {
                    "id": p.id,
                    "x": round(p.x, 3),
                    "y": round(p.y, 3),
                    "heading": round(p.heading, 3),
                    "speed": round(p.speed, 2),
                    "action": "kick" if p.kick else ("move" if p.command else "hold"),
                }
                for p in self.bodies
            ],
        }

    def stations_info(self) -> list[dict]:
        out = [
            {"name": s.name, "shows": s.shows, "centre": list(s.centre), "players": [p.id for p in s.bodies]}
            for s in self.stations
        ]
        out.append(
            {"name": "passage", "shows": Passage.SHOWS, "centre": [26, 0], "players": [p.id for p in self.passage.cast]}
        )
        return out


class Passage:
    """The right half's play with the ball, over and over, every touch going the way its
    team attacks (home towards +x, away towards -x)."""

    SHOWS = (
        "home: a dribble at 6 m/s, a sprint knocking the ball on (touch kind knock), a diagonal carry at a "
        "defender who jockeys, a shield with the defender close behind, a pass out wide, a carry to the "
        "byline and a cross to the far post; away: a standing tackle there, then a long lofted through "
        "ball for a runner who sprints on with it, knocking it on"
    )

    def __init__(self, world: World, a: Body, b: Body, c: Body, d: Body, e: Body) -> None:
        self.w = world
        self.a, self.b, self.c, self.d, self.e = a, b, c, d, e  # e is b's teammate
        self.cast = [a, b, c, d, e]
        for p in self.cast:
            p.takes_ball = True
        self.stage = "clear"
        self.since = 0.0
        self.mark = (0.0, 0.0)
        self.held = 0.0
        self.way = (1.0, 0.0)
        self.run: tuple = ()

    def to(self, stage: str) -> None:
        self.stage, self.since = stage, 0.0

    def direct(self) -> None:
        w, a, b, c, d, e = self.w, self.a, self.b, self.c, self.d, self.e
        ball = (w.ball.x, w.ball.y)
        s = self.since
        self.since += STEP
        owner = w.owner
        self.held = self.held + STEP if owner is not None else 0.0
        if self.stage == "clear":  # off the pitch for a snapshot, so the page places them all
            for k, p in enumerate(self.cast):
                p.place(70 + 3 * k, 40)
                p.command, p.kick = None, None
            w.ball, w.owner = Ball(80, 40), None
            if s >= 3 * STEP:
                self.to("reset")
            return
        if self.stage == "reset":
            a.place(-2, -6, 0.0)
            b.place(34, 2, math.pi)
            c.place(20, -22, 0.0)
            d.place(24, 14, 0.0)
            e.place(30, 28, math.pi)
            w.ball, w.owner = Ball(a.x + DRIBBLE, a.y), a.id
            self.to("dribble")
            return
        for p in self.cast:
            p.command = (p.x, p.y, 0.0, ball)
        decide = {p.id: ("dribble" if owner == p.id else "support") for p in self.cast}
        decide[b.id] = "mark"
        # The defender may win the ball only once it goes for it, and the striker it beats
        # does not win it straight back.
        b.takes_ball = self.stage in ("tackle", "counter", "through", "run_on", "loose")
        d.takes_ball = self.stage not in ("counter", "through", "run_on")
        if self.stage == "dribble":  # carried at the dribble's pace
            a.command = (a.x + 10, -6, DRIBBLE_SPEED, None)
            if a.x > 2:
                self.to("sprint")
        elif self.stage == "sprint":  # knocked on at each touch and run on to
            decide[a.id] = "sprint"
            self.sprint_on(a, (a.x + 10, -6))
            if a.x > 18 and owner == a.id:
                self.to("diagonal")
        elif self.stage == "diagonal":  # carried at 45 degrees
            a.command = (a.x + 10, a.y + 10, DRIBBLE_SPEED, None)
            if a.y > -2:
                self.to("approach")
        elif self.stage == "approach":  # weaving at a defender who backs off and side-steps
            side = 3.0 if int(s / 1.2) % 2 == 0 else -3.0
            a.command = (a.x + 5, 2 + side, 3.0, None)
            b.command = (a.x + 3.0 - min(s, 4) * 0.12, a.y + 0.3 * (b.y - a.y), 3.2, ball)
            c.command = (32, -20, JOG, ball)
            d.command = (34, 12, JOG, ball)
            decide[b.id] = "press"
            if s > 4.0:
                self.to("shield")
        elif self.stage == "shield":  # back to the defender, backing away slowly
            decide[a.id], decide[b.id] = "shield", "press"
            ux, uy = self.unit(b, a)
            sway = 0.8 * math.sin(s * 2.2)
            a.command = (a.x + ux * 1.5 - uy * sway, a.y + uy * 1.5 + ux * sway, WALK, (a.x + ux * 10, a.y + uy * 10))
            b.command = (a.x - ux * 1.2, a.y - uy * 1.2, 3.0, ball)
            c.command = (36, -16, WALK, ball)
            if s > 3.0 and owner == a.id:
                decide[a.id] = "pass"
                w.kick(a, math.atan2(c.y - w.ball.y, c.x - w.ball.x), 11.0)
                self.to("layoff")
        elif self.stage == "layoff":  # a pass out wide
            c.command = (w.ball.x, w.ball.y, JOG, None) if math.hypot(c.x - w.ball.x, c.y - w.ball.y) < 4 else c.command
            if owner == c.id:
                self.to("wing")
            elif s > 3:
                self.to("loose")
        elif self.stage == "wing":  # carried to the byline; the far post is attacked and covered
            c.command = (46, -26, DRIBBLE_SPEED, None)
            d.command = (44, 5, JOG, ball)
            b.command = (42, 2, JOG, ball)
            if owner != c.id:
                self.to("loose")
            elif c.x > 41 or s > 4.5:
                decide[c.id] = "cross"
                angle, speed = lofted(w.ball.x, w.ball.y, 46, 5, 0.5)
                w.kick(c, angle, speed, 0.5)
                self.mark = flight(w.ball.x, w.ball.y, angle, speed, 0.5)[:2]
                self.to("cross")
        elif self.stage == "cross":
            d.command = (*self.mark, JOG, ball)
            b.command = (self.mark[0] - 2.5, self.mark[1] - 1.5, JOG, ball)
            if owner == d.id:
                self.to("tackle")
            elif s > 4:
                self.to("loose")
        elif self.stage == "tackle":  # the defender comes round the receiver and takes it
            decide[b.id] = "tackle"
            d.command = (d.x, d.y, 0.0, (60.0, 0.0))  # holds it, facing the goal
            if s == 0.0:
                self.way = (math.cos(d.heading), math.sin(d.heading))
            ux, uy = self.way
            beside = (d.x - uy * 1.0 + ux * 0.3, d.y + ux * 1.0 + uy * 0.3)
            if math.hypot(b.x - beside[0], b.y - beside[1]) < 0.3 or s > 1.5:
                self.mark = (1.0, 0.0)
            elif s == 0.0:
                self.mark = (0.0, 0.0)
            near_ball = (w.ball.x + ux * 0.2, w.ball.y + uy * 0.2)
            b.command = (*(near_ball if self.mark == (1.0, 0.0) else beside), 4.0, ball)
            if owner == b.id:
                self.run = (e.x - 40, 29, TOP_SPEED, None)
                self.to("counter")
            elif s > 6:
                self.to("loose")
        elif self.stage == "counter":  # a touch away, then the long ball into the runner's path
            decide[b.id], decide[e.id] = "dribble", "run_behind"
            b.command = (b.x - 6, b.y + 2, 3.0, None)
            e.command = self.run
            if s > 0.8 and owner == b.id:
                decide[b.id] = "through_ball"
                ahead = 1.6
                for _ in range(3):
                    target = ahead_of(e, self.run, ahead)
                    angle, speed = lofted(w.ball.x, w.ball.y, *target, 0.35)
                    *_, ahead = flight(w.ball.x, w.ball.y, angle, speed, 0.35)
                w.kick(b, angle, speed, 0.35)
                self.to("through")
            elif owner != b.id:
                self.to("loose")
        elif self.stage == "through":
            decide[e.id] = "run_behind"
            e.command = self.run if w.ball.z > 0.5 and s < 2.5 else (w.ball.x, w.ball.y, TOP_SPEED, None)
            if owner == e.id:
                self.to("run_on")
            elif s > 5:
                self.to("loose")
        elif self.stage == "run_on":  # the runner sprints on with it, then stops with it
            decide[e.id] = "sprint" if e.x > -22 else "hold"
            if e.x > -22 and s < 7:
                self.sprint_on(e, (e.x - 10, 29))
            elif owner == e.id:
                e.command = (e.x, e.y, 0.0, None)
            else:
                e.command = (w.ball.x, w.ball.y, JOG, None)
            if s > 9 or (owner == e.id and e.speed < 0.2):
                self.to("clear")
        elif self.stage == "loose":  # anything gone astray: the nearest goes for it, then again
            nearest = min(self.cast, key=lambda p: math.hypot(p.x - w.ball.x, p.y - w.ball.y))
            nearest.command = (w.ball.x, w.ball.y, JOG, None)
            if s > 3 or owner is not None:
                self.to("clear")
        for p in self.cast:
            p.decision = decide[p.id]

    def sprint_on(self, p: Body, towards: tuple[float, float]) -> None:
        """A sprint with the ball: knocked on a few metres once it is under control, and
        run on to at full speed, as the engine's `sprint` decision plays it."""
        w = self.w
        if w.owner == p.id:
            p.command = (*towards, TOP_SPEED, None)
            if self.held > 0.15 and p.speed > 4:
                w.kick(p, p.heading, p.speed + KNOCK, 0.0, "knock")
        else:
            p.command = (w.ball.x + 3 * math.cos(p.heading), w.ball.y + 3 * math.sin(p.heading), TOP_SPEED, None)

    @staticmethod
    def unit(frm: Body, to: Body) -> tuple[float, float]:
        dx, dy = to.x - frm.x, to.y - frm.y
        dist = math.hypot(dx, dy) or 1.0
        return dx / dist, dy / dist


async def play(websocket: WebSocket, decisions: bool) -> None:
    await websocket.accept()
    world = World(decisions)
    await websocket.send_text(json.dumps(world.hello()))
    loop = asyncio.get_running_loop()
    due = loop.time()
    steps = 0

    async def feed() -> None:
        nonlocal due, steps
        while True:
            world.step()
            steps += 1
            if steps % SNAPSHOT_EVERY == 0:
                await websocket.send_text(json.dumps(world.snapshot()))
            for p in world.bodies if decisions else ():
                if p.decision and steps % (18 + p.id % 7 * 2) == 0:  # an answer every 0.3 to 0.5 s
                    ms = 150 + (p.id * 37 + steps) % 160
                    await websocket.send_text(
                        json.dumps(
                            {"type": "decision", "player": p.id, "model": "Laya", "action": p.decision, "ms": ms}
                        )
                    )
            due += STEP
            await asyncio.sleep(max(0.0, due - loop.time()))

    feeding = asyncio.create_task(feed())
    try:
        with contextlib.suppress(WebSocketDisconnect):
            while True:
                await websocket.receive_text()
    finally:
        feeding.cancel()


def page(live: bool, decisions: bool, ref: str | None = None) -> Starlette:
    """The page, with the probe added, over the scripted feed or a real keyless match. With
    `ref`, the page's files are served as committed at that git revision."""

    def read(path: str) -> bytes:
        if ref is None:
            return (WEB / path).read_bytes()
        where = f"{ref}:src/decision_pitch/web/{path}"
        return subprocess.run(["git", "show", where], cwd=HERE, capture_output=True, check=True).stdout

    def index(_request):
        html = read("index.html").decode()
        tag = '<script type="module" src="./__motion/probe.mjs"></script>\n'
        return Response(html.replace("</body>", tag + "</body>"), media_type="text/html")

    def main_js(_request):
        # The page's own entry point, with what the probe needs exposed after it has run.
        source = read("src/main.js").decode()
        expose = (
            "\nwindow.__pitch = { scene, camera, renderer, get actors() { return actors; },"
            " get broadcast() { return broadcast; }, get timeline() { return timeline; } };\n"
        )
        return Response(source + expose, media_type="text/javascript")

    def probe(_request):
        return Response(PROBE.read_text(), media_type="text/javascript")

    def stations(_request):
        return JSONResponse({"live": live, "stations": [] if live else World().stations_info()})

    routes = [
        Route("/", index),
        Route("/index.html", index),
        Route("/src/main.js", main_js),
        Route("/__motion/probe.mjs", probe),
        Route("/__motion/stations", stations),
    ]
    if live:
        from decision_pitch import server  # the engine's own socket: bots on both teams, no keys

        socket = next(r for r in server.app().routes if isinstance(r, WebSocketRoute))
        routes.append(socket)
    else:

        async def scripted(websocket: WebSocket) -> None:
            await play(websocket, decisions)

        routes.append(WebSocketRoute("/ws", scripted))
    if ref is None:
        routes.append(Mount("/", StaticFiles(directory=WEB, html=True)))
    else:

        def committed(request):
            path = request.path_params["path"]
            try:
                body = read(path)
            except subprocess.CalledProcessError:
                return Response(status_code=404)
            kind = "text/javascript" if path.endswith((".js", ".mjs")) else mimetypes.guess_type(path)[0]
            return Response(body, media_type=kind or "application/octet-stream")

        routes.append(Route("/{path:path}", committed))
    app = Starlette(routes=routes)

    async def fresh(scope, receive, send):
        # Always the worktree's current files: a coder's change shows on reload.
        async def sending(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = [*message["headers"], (b"cache-control", b"no-store")]
            await send(message)

        await app(scope, receive, sending if scope["type"] == "http" else send)

    return fresh


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--port", type=int, default=8796)
    parser.add_argument("--live", action="store_true", help="a real keyless match (bots) instead of the script")
    parser.add_argument("--decisions", action="store_true", help="play as model players, sending decisions")
    parser.add_argument("--ref", help="serve the page as committed at this git revision, such as develop")
    parser.add_argument("--stations", action="store_true", help="print the stations and exit")
    args = parser.parse_args()
    if args.stations:
        for s in World().stations_info():
            print(f"{s['name']:13} players {s['players']}: {s['shows']}")
        return
    what = ("live match" if args.live else "scripted") + (f", page at {args.ref}" if args.ref else "")
    print(f"Motion replay ({what}) at http://127.0.0.1:{args.port}/", flush=True)
    uvicorn.run(page(args.live, args.decisions, args.ref), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

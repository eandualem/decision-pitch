"""The match: players, ball, clock, score and the laws that restart play.

The engine is driven by commands, one per player, which last until replaced:
hold, run to a point, or kick the ball towards a point. A player told to kick
runs to the ball and kicks it as soon as it can play it."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from decision_pitch import pitch
from decision_pitch.physics import (
    BALL_RADIUS,
    STEP,
    TOP_SPEED,
    Ball,
    Player,
    carry,
    separate,
    step_ball,
    step_player,
)


@dataclass(frozen=True)
class Hold:
    pass


@dataclass(frozen=True)
class MoveTo:
    x: float
    y: float
    speed: float = TOP_SPEED


@dataclass(frozen=True)
class KickTo:
    x: float
    y: float
    speed: float  # m/s off the boot
    loft: float = 0.0  # radians above the ground


Command = Hold | MoveTo | KickTo

CONTROL = 0.75  # m from a player's centre to the ball's within which it plays the ball
CONTROL_HEIGHT = 0.9  # m, the highest ball a player can play
KEEPER_CONTROL = 1.3  # a goalkeeper's reach in its own penalty area
KEEPER_HEIGHT = 2.6
DRIBBLE = 0.6  # m ahead of a player's centre that it carries the ball
KICK_MAX = 30.0  # m/s
THROW_MAX = 15.0  # m/s
KICK_RECOVERY = 0.25  # s after a kick before the kicker can play the ball again
KICK_ERROR = 0.002  # radians of aim error per m/s of kick speed
KICKOFF_WAIT = 5.0  # s players have to take their places before they are placed
HALF_TIME = 3.0  # s
RESTART_DISTANCE = {"kickoff": pitch.CENTRE_RADIUS, "corner": 9.15, "goal_kick": 9.15, "throw_in": 2.0}
RESTARTS = tuple(RESTART_DISTANCE)

# 4-4-2 for a team attacking towards +x, in its own half
FORMATION = [
    ("GK", (-50.0, 0.0)),
    ("DF", (-36.0, -20.0)), ("DF", (-38.0, -7.0)), ("DF", (-38.0, 7.0)), ("DF", (-36.0, 20.0)),
    ("MF", (-20.0, -22.0)), ("MF", (-22.0, -7.0)), ("MF", (-22.0, 7.0)), ("MF", (-20.0, 22.0)),
    ("FW", (-1.0, -6.0)), ("FW", (-10.0, 8.0)),
]  # fmt: skip


@dataclass
class Team:
    name: str
    colours: dict[str, str]
    names: list[str]


TEAMS = (
    Team("Harbour", {"shirt": "#1f5fbf", "shorts": "#ffffff", "keeper": "#f2c230"},
         ["Vale", "Moss", "Hart", "Quill", "Reed", "Stone", "Finch", "Brook", "Ash", "Lark", "Pike"]),
    Team("Ridge", {"shirt": "#e0562b", "shorts": "#1b1b1b", "keeper": "#3fbf6f"},
         ["Rook", "Sable", "Thorne", "Wren", "Yarrow", "Birch", "Cliff", "Drake", "Ember", "Frost", "Glen"]),
)  # fmt: skip


@dataclass
class Match:
    half_length: float = 180.0  # real seconds per half
    seed: int = 0
    teams: tuple[Team, Team] = TEAMS
    t: float = 0.0  # seconds since kick-off, pauses included
    elapsed: float = 0.0  # seconds played in this half
    period: int = 1
    phase: str = "kickoff"
    score: list[int] = field(default_factory=lambda: [0, 0])
    ball: Ball = field(default_factory=Ball)
    owner: int | None = None  # the player in possession
    last_touch: int | None = None  # the team that last played the ball
    restart_team: int | None = 0
    since_restart: float = 0.0
    events: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.rng = random.Random(self.seed)
        self.players = [
            Player(team * 11 + i + 1, team, i + 1, team_.names[i], position, home)
            for team, team_ in enumerate(self.teams)
            for i, (position, home) in enumerate(FORMATION)
        ]
        self.commands: dict[int, Command] = {p.id: Hold() for p in self.players}
        self.recovering: dict[int, float] = {}
        self._kickoff(0, place_players=True)

    # -- what the engine is told and shows --------------------------------------------------

    def command(self, player_id: int, command: Command) -> None:
        self.commands[player_id] = command

    def player(self, player_id: int) -> Player:
        return self.players[player_id - 1]

    def attack(self, team: int) -> int:
        """+1 if `team` attacks towards +x in this half, else -1."""
        return (1 if team == 0 else -1) * (1 if self.period == 1 else -1)

    def clock(self) -> str:
        minutes = self.elapsed / self.half_length * 45 + (45 if self.period == 2 else 0)
        return f"{int(minutes):02d}:{int(minutes * 60) % 60:02d}"

    def hello_teams(self) -> list[dict]:
        return [
            {
                "name": team.name,
                "colours": team.colours,
                "players": [
                    {"id": p.id, "number": p.number, "name": p.name, "position": p.position, "model": None}
                    for p in self.players
                    if p.team == index
                ],
            }
            for index, team in enumerate(self.teams)
        ]

    def snapshot(self) -> dict:
        b = self.ball
        return {
            "type": "snapshot",
            "t": round(self.t, 3),
            "period": self.period,
            "clock": self.clock(),
            "phase": self.phase,
            "score": list(self.score),
            "ball": {"x": round(b.x, 3), "y": round(b.y, 3), "z": round(b.z, 3), "owner": self.owner},
            "players": [
                {
                    "id": p.id,
                    "x": round(p.x, 3),
                    "y": round(p.y, 3),
                    "heading": round(p.heading, 3),
                    "speed": round(p.speed, 2),
                    "action": type(self.commands[p.id]).__name__.lower().removesuffix("to"),
                }
                for p in self.players
            ],
        }

    def drain_events(self) -> list[dict]:
        events, self.events = self.events, []
        return events

    # -- one step ---------------------------------------------------------------------------

    def step(self) -> None:
        if self.phase == "full_time":
            return
        self.t += STEP
        if self.phase == "half_time":
            self.since_restart += STEP
            if self.since_restart >= HALF_TIME:
                self.period, self.elapsed = 2, 0.0
                self._kickoff(1, place_players=True)
            return
        self.elapsed += STEP
        self.since_restart += STEP
        for pid in list(self.recovering):
            self.recovering[pid] -= STEP
            if self.recovering[pid] <= 0:
                del self.recovering[pid]

        for p in self.players:
            self._move(p)
        separate(self.players)
        for p in self.players:
            p.x = max(-pitch.HALF_LENGTH - 3, min(pitch.HALF_LENGTH + 3, p.x))
            p.y = max(-pitch.HALF_WIDTH - 3, min(pitch.HALF_WIDTH + 3, p.y))
        if self.phase in RESTARTS:
            self._keep_distance()

        before = (self.ball.x, self.ball.y, self.ball.z)
        self._take_possession()
        owner = self.player(self.owner) if self.owner else None
        command = self.commands[owner.id] if owner else None
        if owner and isinstance(command, KickTo) and self._may_kick(owner):
            self._kick(owner, command)
        elif owner and self.phase == "play":
            self.ball.vx, self.ball.vy = owner.vx, owner.vy
            carry(
                self.ball,
                owner.x + math.cos(owner.heading) * DRIBBLE,
                owner.y + math.sin(owner.heading) * DRIBBLE,
            )
        elif self.phase == "play":
            step_ball(self.ball)
        if self.phase == "play":
            self._check_ball(before)

        if self.elapsed >= self.half_length and self.phase not in ("half_time", "full_time"):
            self._end_half()

    def _move(self, p: Player) -> None:
        command = self.commands[p.id]
        if isinstance(command, MoveTo):
            step_player(p, command.x, command.y, command.speed)
        elif isinstance(command, KickTo) and self.owner != p.id:
            # run at the ball from behind, so the kick goes the right way
            angle = math.atan2(command.y - self.ball.y, command.x - self.ball.x)
            tx, ty = self.ball.x - math.cos(angle) * 0.3, self.ball.y - math.sin(angle) * 0.3
            step_player(p, tx, ty, TOP_SPEED)
        else:
            step_player(p, p.x, p.y, 0.0)

    # -- possession and kicks ---------------------------------------------------------------

    def _can_play(self, p: Player) -> bool:
        if p.id in self.recovering:
            return False
        if self.phase in RESTARTS and p.team != self.restart_team:
            return False
        reach, height = CONTROL, CONTROL_HEIGHT
        if self.phase == "play" and p.position == "GK" and self._in_own_penalty_area(p):
            reach, height = KEEPER_CONTROL, KEEPER_HEIGHT
        b = self.ball
        return b.z <= height and math.hypot(b.x - p.x, b.y - p.y) <= reach

    def _take_possession(self) -> None:
        able = [p for p in self.players if self._can_play(p)]
        if not able:
            self.owner = None
            return
        nearest = min(able, key=lambda p: math.hypot(self.ball.x - p.x, self.ball.y - p.y))
        self.owner = nearest.id
        if self.phase == "play":
            self.last_touch = nearest.team

    def _may_kick(self, p: Player) -> bool:
        if self.phase != "kickoff":
            return True
        if self.since_restart >= KICKOFF_WAIT:
            self._place_for_kickoff()
            return True
        return self._kickoff_ready()

    def _kick(self, p: Player, command: KickTo) -> None:
        cap = THROW_MAX if self.phase == "throw_in" else KICK_MAX
        loft = max(command.loft, 0.3) if self.phase == "throw_in" else command.loft
        speed = max(0.0, min(command.speed, cap))
        angle = math.atan2(command.y - self.ball.y, command.x - self.ball.x)
        angle += self.rng.gauss(0, KICK_ERROR * speed)
        self.ball.vx = speed * math.cos(loft) * math.cos(angle)
        self.ball.vy = speed * math.cos(loft) * math.sin(angle)
        self.ball.vz = speed * math.sin(loft)
        self.ball.z = BALL_RADIUS + (0.01 if loft > 0 else 0.0)
        self.last_touch = p.team
        self.owner = None
        self.recovering[p.id] = KICK_RECOVERY
        self.commands[p.id] = Hold()
        if self.phase != "play":
            self.phase, self.restart_team = "play", None

    def _in_own_penalty_area(self, p: Player) -> bool:
        goal = -self.attack(p.team) * pitch.HALF_LENGTH
        return abs(p.x - goal) <= pitch.PENALTY_DEPTH and abs(p.y) <= pitch.PENALTY_HALF_WIDTH

    # -- ball out of play, goals and restarts -----------------------------------------------

    def _check_ball(self, before: tuple[float, float, float]) -> None:
        """Judge the ball where it first wholly crossed a line during this step."""
        b, (x0, y0, z0) = self.ball, before
        crossings = []
        lines = ((x0, b.x, pitch.HALF_LENGTH, "goal"), (y0, b.y, pitch.HALF_WIDTH, "touch"))
        for start, end, limit, line in lines:
            limit += BALL_RADIUS
            if abs(end) > limit:
                edge = limit if end > 0 else -limit
                f = (edge - start) / (end - start) if end != start else 0.0
                crossings.append((min(1.0, max(0.0, f)), line))
        if not crossings:
            return
        f, line = min(crossings)
        x, y, z = x0 + (b.x - x0) * f, y0 + (b.y - y0) * f, z0 + (b.z - z0) * f
        if line == "goal":
            end = 1 if x > 0 else -1
            attackers = 0 if self.attack(0) == end else 1
            if abs(y) < pitch.GOAL_WIDTH / 2 and z < pitch.GOAL_HEIGHT:
                self.score[attackers] += 1
                self._event("goal", attackers, self._last_player(attackers))
                self._kickoff(1 - attackers)
            elif self.last_touch == 1 - attackers:
                corner_y = pitch.HALF_WIDTH if y > 0 else -pitch.HALF_WIDTH
                self._restart("corner", attackers, end * pitch.HALF_LENGTH, corner_y)
            else:
                x = end * (pitch.HALF_LENGTH - pitch.GOAL_AREA_DEPTH)
                self._restart("goal_kick", 1 - attackers, x, 0.0)
        else:
            x = max(-pitch.HALF_LENGTH, min(pitch.HALF_LENGTH, x))
            y = pitch.HALF_WIDTH if y > 0 else -pitch.HALF_WIDTH
            self._restart("throw_in", 1 - (self.last_touch or 0), x, y)

    def _last_player(self, team: int) -> int | None:
        """The scorer, if it can be told: the player of `team` nearest the ball."""
        players = [p for p in self.players if p.team == team]
        return min(players, key=lambda p: math.hypot(self.ball.x - p.x, self.ball.y - p.y)).id

    def _restart(self, kind: str, team: int, x: float, y: float) -> None:
        self.ball.place(x, y)
        self.phase, self.restart_team, self.since_restart = kind, team, 0.0
        self.owner = None
        self._event(kind, team)

    def _kickoff(self, team: int, place_players: bool = False) -> None:
        self._restart("kickoff", team, 0.0, 0.0)
        self.events.pop()  # a kick-off is not shown as an event
        if place_players:
            self._place_for_kickoff(formation=True)

    def _kickoff_ready(self) -> bool:
        for p in self.players:
            side = -self.attack(p.team)
            if p.x * side < -0.5:
                return False  # in the opponents' half
            if p.team != self.restart_team and math.hypot(p.x, p.y) < pitch.CENTRE_RADIUS:
                return False
        return True

    def _place_for_kickoff(self, formation: bool = False) -> None:
        for p in self.players:
            side = -self.attack(p.team)
            if formation:
                p.x, p.y = -side * p.home[0], -side * p.home[1]
                p.vx = p.vy = 0.0
                p.heading = 0.0 if side < 0 else math.pi
                self.commands[p.id] = Hold()
            if p.x * side < 0:
                p.x = 0.0
        self._keep_distance()
        if formation:  # the kicking team's centre forward stands at the ball
            taker = next(p for p in self.players if p.team == self.restart_team and p.position == "FW")
            side = -self.attack(taker.team)
            taker.x, taker.y = side * 0.6, 0.0

    def _keep_distance(self) -> None:
        """Opponents of the restarting team keep their distance from the ball."""
        distance = RESTART_DISTANCE[self.phase]
        for p in self.players:
            if p.team == self.restart_team:
                continue
            dx, dy = p.x - self.ball.x, p.y - self.ball.y
            dist = math.hypot(dx, dy)
            if dist < distance:
                if dist == 0:
                    dx, dy, dist = -self.attack(self.restart_team), 0.0, 1.0
                p.x = self.ball.x + dx / dist * distance
                p.y = self.ball.y + dy / dist * distance

    def _end_half(self) -> None:
        self.owner = None
        if self.period == 1:
            self.phase, self.since_restart = "half_time", 0.0
            self._event("half_time", None)
        else:
            self.phase = "full_time"
            self._event("full_time", None)

    def _event(self, kind: str, team: int | None, player: int | None = None) -> None:
        event = {"type": "event", "kind": kind, "t": round(self.t, 3), "team": team}
        if player is not None:
            event["player"] = player
        self.events.append(event)

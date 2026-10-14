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
    PLAYER_RADIUS,
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
CONTROL_SPEED = 18.0  # m/s, relative to a player, above which a loose ball bounces off it
PARRY_SPEED = 10.0  # m/s above which a goalkeeper at full stretch parries a ball, not catches it
DIVE_MARGIN = 0.5  # m outside a post within which a ball heading for the goal makes its keeper dive
DEFLECT_PUSH = 0.4  # share of its speed a deflected ball leaves outwards from the player with
DEFLECT_KEEP = 0.3  # share of its speed along the player's body a deflected ball keeps
DRIBBLE = 0.6  # m ahead of a player's centre that it carries the ball
KICK_MAX = 30.0  # m/s
THROW_MAX = 15.0  # m/s
KICK_RECOVERY = 0.25  # s after a kick before the kicker can play the ball again
KICK_ERROR = 0.002  # radians of aim error per m/s of kick speed
KICKOFF_WAIT = 10.0  # s players have to take their places for a kick-off before they are placed
RETREAT_WAIT = 5.0  # s opponents have to retreat at any other restart before they are placed
OUT_OF_PLACE = 0.2  # m out of place beyond which a player runs back instead of being put right
SET_PIECE_WAIT = 1.5  # s before a free kick or penalty can be taken
HALF_TIME = 3.0  # s
RESTART_DISTANCE = {"kickoff": pitch.CENTRE_RADIUS, "corner": 9.15, "goal_kick": 9.15, "throw_in": 2.0,
                    "free_kick": 9.15, "penalty": 9.15}  # fmt: skip
RESTARTS = tuple(RESTART_DISTANCE)
NO_OFFSIDE = ("throw_in", "goal_kick", "corner")  # restarts no one can be offside from
FOUL_SPEED = 2.0  # m/s a challenger runs into the ball carrier at for its challenge to be judged
BEHIND = -0.5  # cosine: a challenger more than 120° from where the carrier faces is behind it
PROMISING_ATTACK = 27.0  # m from goal within which a foul stops a promising attack: a yellow card
GOAL_CHANCE = 25.0  # m from goal within which a foul can deny an obvious goal-scoring chance
SUBSTITUTES = 5  # substitutions a team may make
WINDOWS = 3  # stoppages it may make them in, half time not counted
FEWEST = 7  # players a team needs to play on

# 4-4-2 for a team attacking towards +x, in its own half
FORMATION = [
    ("GK", (-50.0, 0.0)),
    ("DF", (-36.0, -20.0)), ("DF", (-38.0, -7.0)), ("DF", (-38.0, 7.0)), ("DF", (-36.0, 20.0)),
    ("MF", (-20.0, -22.0)), ("MF", (-22.0, -7.0)), ("MF", (-22.0, 7.0)), ("MF", (-20.0, 22.0)),
    ("FW", (-1.0, -6.0)), ("FW", (-10.0, 8.0)),
]  # fmt: skip
BENCH = ("GK", "DF", "DF", "MF", "MF", "FW", "FW")


@dataclass
class Team:
    name: str
    colours: dict[str, str]
    names: list[str]  # the eleven who start, then the bench


TEAMS = (
    Team("Harbour", {"shirt": "#1f5fbf", "shorts": "#ffffff", "keeper": "#f2c230"},
         ["Vale", "Moss", "Hart", "Quill", "Reed", "Stone", "Finch", "Brook", "Ash", "Lark", "Pike",
          "Cove", "Dune", "Gale", "Heath", "Marsh", "Fern", "Rill"]),
    Team("Ridge", {"shirt": "#e0562b", "shorts": "#1b1b1b", "keeper": "#3fbf6f"},
         ["Rook", "Sable", "Thorne", "Wren", "Yarrow", "Birch", "Cliff", "Drake", "Ember", "Frost", "Glen",
          "Crag", "Flint", "Knoll", "Scree", "Tarn", "Briar", "Heron"]),
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
        # the players on the pitch, and the substitutes not yet used
        self.players = [
            Player(team * 11 + i + 1, team, i + 1, team_.names[i], position, home)
            for team, team_ in enumerate(self.teams)
            for i, (position, home) in enumerate(FORMATION)
        ]
        self.bench = [
            Player(23 + team * len(BENCH) + i, team, 12 + i, team_.names[11 + i], position, (0.0, 0.0))
            for team, team_ in enumerate(self.teams)
            for i, position in enumerate(BENCH)
        ]
        self.everyone = {p.id: p for p in [*self.players, *self.bench]}
        self.commands: dict[int, Command] = {pid: Hold() for pid in self.everyone}
        self.recovering: dict[int, float] = {}
        self.offside: set[int] = set()  # players in an offside position since the last kick
        self.indirect: int | None = None  # who took an indirect free kick no one else has touched
        self.restart_indirect = False  # the free kick about to be taken is indirect
        self.taker: int | None = None  # a penalty's taker
        self.penalty_live = False  # a penalty kick is on its way: the half waits for it
        self.yellows: dict[int, int] = {}
        self.substitutions = [0, 0]  # made by each team
        self.windows = [0, 0]  # stoppages each team has made substitutions in
        self.window_at: list[int | None] = [None, None]  # the stoppage of each team's latest
        self.stoppage = 0  # counts the restarts
        self.pending: list[tuple[int, int]] = []  # substitutions asked for: (off, on)
        self._kickoff(0, place_players=True)

    # -- what the engine is told and shows --------------------------------------------------

    def command(self, player_id: int, command: Command) -> None:
        self.commands[player_id] = command

    def player(self, player_id: int) -> Player:
        return self.everyone[player_id]

    def attack(self, team: int) -> int:
        """+1 if `team` attacks towards +x in this half, else -1."""
        return (1 if team == 0 else -1) * (1 if self.period == 1 else -1)

    def clock(self) -> str:
        minutes = self.elapsed / self.half_length * 45 + (45 if self.period == 2 else 0)
        return f"{int(minutes):02d}:{int(minutes * 60) % 60:02d}"

    def hello_teams(self) -> list[dict]:
        def entry(p: Player) -> dict:
            return {"id": p.id, "number": p.number, "name": p.name, "position": p.position, "model": None}

        return [
            {
                "name": team.name,
                "colours": team.colours,
                "players": [entry(p) for p in self.players if p.team == index],
                "bench": [entry(p) for p in self.bench if p.team == index],
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

    def substitute(self, off: int, on: int) -> str | None:
        """Ask to replace player `off` with substitute `on` at the next stoppage. Returns
        why it cannot be made, or None once it is asked for."""
        p, q = self.everyone.get(off), self.everyone.get(on)
        if p is None or p not in self.players:
            return "that player is not on the pitch"
        if q is None or q not in self.bench or q.team != p.team:
            return "that player is not on the team's bench"
        if any(off == a or on == b for a, b in self.pending):
            return "that substitution is already asked for"
        asked = sum(1 for a, _ in self.pending if self.player(a).team == p.team)
        if self.substitutions[p.team] + asked >= SUBSTITUTES:
            return f"all {SUBSTITUTES} substitutions are used"
        in_window = self.phase in RESTARTS and self.window_at[p.team] == self.stoppage
        if self.windows[p.team] >= WINDOWS and self.phase != "half_time" and not in_window:
            return f"all {WINDOWS} stoppages for substitutions are used"
        self.pending.append((off, on))
        return None

    # -- one step ---------------------------------------------------------------------------

    def step(self) -> None:
        if self.phase == "full_time":
            return
        self.t += STEP
        if self.phase == "half_time":
            self._substitute()
            self.since_restart += STEP
            if self.since_restart >= HALF_TIME:
                self.period, self.elapsed = 2, 0.0
                self._kickoff(1, place_players=True)
            return
        if self.phase in RESTARTS:
            self._substitute()
        self.elapsed += STEP
        self.since_restart += STEP
        for pid in list(self.recovering):
            self.recovering[pid] -= STEP
            if self.recovering[pid] <= 0:
                del self.recovering[pid]

        for p in self.players:
            self._move(p)
        self._judge_challenge()
        if self.phase == "full_time":
            return
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
            step_ball(self.ball)  # on its way before anyone else can claim it
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

        if self.penalty_live and self.ball.vx == self.ball.vy == self.ball.vz == 0:
            self.penalty_live = False  # it came to rest untouched
        waiting = self.phase == "penalty" or self.penalty_live  # a penalty is completed first
        if self.elapsed >= self.half_length and self.phase not in ("half_time", "full_time") and not waiting:
            self._end_half()

    def _move(self, p: Player) -> None:
        command = self.commands[p.id]
        if self._out_of_place(p) > OUT_OF_PLACE:
            # the laws ask it to retreat, whatever it was told
            step_player(p, *self._allowed_spot(p, margin=1.0), TOP_SPEED)
        elif isinstance(command, MoveTo):
            step_player(p, command.x, command.y, command.speed, dive=self._dives(p))
        elif isinstance(command, KickTo) and self.owner != p.id:
            # run at the ball from behind, so the kick goes the right way
            angle = math.atan2(command.y - self.ball.y, command.x - self.ball.x)
            tx, ty = self.ball.x - math.cos(angle) * 0.3, self.ball.y - math.sin(angle) * 0.3
            step_player(p, tx, ty, TOP_SPEED)
        else:
            step_player(p, p.x, p.y, 0.0)

    def _dives(self, p: Player) -> bool:
        """Whether `p` is a goalkeeper in its own area with a loose ball heading into its
        goal: it dives across rather than running (docs/decisions.md, section 2)."""
        if self.phase != "play" or p.position != "GK" or self.owner is not None:
            return False
        if not self._in_own_penalty_area(p.x, p.y, p.team):
            return False
        b, goal_x = self.ball, -self.attack(p.team) * pitch.HALF_LENGTH
        if (goal_x - b.x) * b.vx <= 0:
            return False  # not moving towards the goal
        return abs(b.y + b.vy * (goal_x - b.x) / b.vx) <= pitch.GOAL_WIDTH / 2 + DIVE_MARGIN

    # -- possession and kicks ---------------------------------------------------------------

    def _reaches(self, p: Player) -> bool:
        """Whether the ball is within `p`'s reach."""
        reach, height = CONTROL, CONTROL_HEIGHT
        if self.phase == "play" and p.position == "GK" and self._ball_in_own_penalty_area(p.team):
            reach, height = KEEPER_CONTROL, KEEPER_HEIGHT
        b = self.ball
        return b.z <= height and math.hypot(b.x - p.x, b.y - p.y) <= reach

    def _can_play(self, p: Player) -> bool:
        if p.id in self.recovering:
            return False
        if self.phase in RESTARTS and p.team != self.restart_team:
            return False
        if self.phase == "penalty" and p.id != self.taker:
            return False
        return self._reaches(p)

    def _take_possession(self) -> None:
        able = [p for p in self.players if self._can_play(p)]
        if not able:
            self.owner = None
            return
        nearest = min(able, key=lambda p: math.hypot(self.ball.x - p.x, self.ball.y - p.y))
        if self.phase == "play":
            deflects = self.owner is None and self._deflects(nearest)
            if self.penalty_live and self.elapsed >= self.half_length and not (deflects and self._saves(nearest)):
                self._end_half()  # this touch completes the penalty the half waited for; a save does not
                return
            if nearest.id in self.offside:
                self._offside(nearest)
                return
            if deflects:
                self._deflect(nearest)
                return
            self.offside = set()  # someone onside played it
            self.penalty_live = False
            if nearest.id != self.indirect:
                self.indirect = None
            self.last_touch = nearest.team
        self.owner = nearest.id

    def _deflects(self, p: Player) -> bool:
        """Whether the loose ball comes at `p` too fast to control, or reaches a goalkeeper
        only at full stretch (docs/decisions.md, section 8)."""
        b = self.ball
        vx, vy = b.vx - p.vx, b.vy - p.vy
        speed = math.sqrt(vx * vx + vy * vy + b.vz * b.vz)
        if speed > CONTROL_SPEED:
            return True
        if p.position != "GK" or speed <= PARRY_SPEED or vx == vy == 0:
            return False
        # its path passes beyond an outfield player's reach
        return abs((b.x - p.x) * vy - (b.y - p.y) * vx) / math.hypot(vx, vy) > CONTROL

    def _deflect(self, p: Player) -> None:
        """The ball bounces off `p`: outwards from where it touched, keeping a little of its
        speed along the body. It counts as `p` playing it, except for the opponents' offside."""
        b = self.ball
        vx, vy = b.vx - p.vx, b.vy - p.vy
        speed = math.sqrt(vx * vx + vy * vy + b.vz * b.vz)
        dx, dy = b.x - p.x, b.y - p.y
        dist = math.hypot(dx, dy)
        nx, ny = (dx / dist, dy / dist) if dist > 0 else (-vx / speed, -vy / speed)
        along = vx * nx + vy * ny
        b.vx = p.vx + nx * speed * DEFLECT_PUSH + (vx - along * nx) * DEFLECT_KEEP
        b.vy = p.vy + ny * speed * DEFLECT_PUSH + (vy - along * ny) * DEFLECT_KEEP
        b.vz *= DEFLECT_KEEP
        self.offside = self._offside_positions(p) | {q for q in self.offside if self.player(q).team != p.team}
        if not self._saves(p):
            self.penalty_live = False  # a goalkeeper's save does not complete a penalty
        if p.id != self.indirect:
            self.indirect = None
        self.last_touch = p.team
        self.owner = None
        self.recovering[p.id] = KICK_RECOVERY

    def _saves(self, p: Player) -> bool:
        """Whether `p` is the goalkeeper defending the goal the ball is at."""
        return p.position == "GK" and self._ball_in_own_penalty_area(p.team)

    def _may_kick(self, p: Player) -> bool:
        if self.phase in ("free_kick", "penalty") and self.since_restart < SET_PIECE_WAIT:
            return False
        if self.phase == "play":
            return True
        if self.since_restart >= (KICKOFF_WAIT if self.phase == "kickoff" else RETREAT_WAIT):
            self._keep_distance(everyone=True)  # anyone still out of place is placed
            return True
        return all(self._out_of_place(q) <= OUT_OF_PLACE for q in self.players)

    def _kick(self, p: Player, command: KickTo) -> None:
        cap = THROW_MAX if self.phase == "throw_in" else KICK_MAX
        loft = max(command.loft, 0.3) if self.phase == "throw_in" else command.loft
        speed = max(0.0, min(command.speed, cap))
        angle = math.atan2(command.y - self.ball.y, command.x - self.ball.x)
        angle += self.rng.gauss(0, KICK_ERROR * speed)
        self.offside = set() if self.phase in NO_OFFSIDE else self._offside_positions(p)
        if self.phase == "free_kick" and self.restart_indirect:
            self.indirect = p.id
        self.penalty_live = self.phase == "penalty"
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

    def _ball_in_own_penalty_area(self, team: int) -> bool:
        return self._in_own_penalty_area(self.ball.x, self.ball.y, team)

    def _in_own_penalty_area(self, x: float, y: float, team: int) -> bool:
        goal = -self.attack(team) * pitch.HALF_LENGTH
        return abs(x - goal) <= pitch.PENALTY_DEPTH and abs(y) <= pitch.PENALTY_HALF_WIDTH

    # -- fouls, offside and cards -----------------------------------------------------------

    def _judge_challenge(self) -> None:
        """An opponent running into the ball carrier fouls it if it came from behind or
        could not reach the ball (docs/decisions.md, section 8)."""
        if self.phase != "play" or self.owner is None:
            return
        carrier = self.player(self.owner)
        facing = math.cos(carrier.heading), math.sin(carrier.heading)
        for q in self.players:
            dx, dy = q.x - carrier.x, q.y - carrier.y
            dist = math.hypot(dx, dy)
            if q.team == carrier.team or dist == 0 or dist >= 2 * PLAYER_RADIUS:
                continue
            towards = -(q.vx * dx + q.vy * dy) / dist
            behind = (dx * facing[0] + dy * facing[1]) / dist < BEHIND
            if towards > FOUL_SPEED and (behind or not self._reaches(q)):
                self._foul(q, carrier)
                return

    def _foul(self, offender: Player, fouled: Player) -> None:
        team = fouled.team
        self._event("foul", team, offender.id, fouled=fouled.id)
        goal = math.hypot(self.attack(team) * pitch.HALF_LENGTH - fouled.x, fouled.y)
        if goal <= GOAL_CHANCE and self._denies_goal(offender, fouled):
            self._card(offender, red=True)
        elif goal <= PROMISING_ATTACK:
            self._card(offender)
        if self.phase == "full_time":
            return
        x = max(-pitch.HALF_LENGTH, min(pitch.HALF_LENGTH, fouled.x))
        y = max(-pitch.HALF_WIDTH, min(pitch.HALF_WIDTH, fouled.y))
        if self._in_own_penalty_area(x, y, offender.team):
            goal = -self.attack(offender.team) * pitch.HALF_LENGTH
            spot = goal - math.copysign(pitch.PENALTY_MARK, goal)
            self._restart("penalty", team, spot, 0.0, taker=fouled.id)
        else:
            self._restart("free_kick", team, x, y)

    def _denies_goal(self, offender: Player, fouled: Player) -> bool:
        """No outfield defender but the offender is nearer the goal line than the carrier."""
        direction = self.attack(fouled.team)
        return not any(
            q.team == offender.team and q is not offender and q.position != "GK"
            and q.x * direction > fouled.x * direction
            for q in self.players
        )

    def _card(self, p: Player, red: bool = False) -> None:
        if not red:
            self.yellows[p.id] = self.yellows.get(p.id, 0) + 1
            self._event("yellow", p.team, p.id)
            red = self.yellows[p.id] == 2
        if red:
            self._event("red", p.team, p.id)
            self._send_off(p)

    def _send_off(self, p: Player) -> None:
        self.players.remove(p)
        self.recovering.pop(p.id, None)
        self.pending = [(off, on) for off, on in self.pending if off != p.id]
        if self.owner == p.id:
            self.owner = None
        team = [q for q in self.players if q.team == p.team]
        if len(team) < FEWEST:
            self.phase = "full_time"
            self._event("full_time", None)
        elif p.position == "GK":  # the teammate nearest its own goal goes in goal
            goal = -self.attack(p.team) * pitch.HALF_LENGTH
            keeper = min(team, key=lambda q: math.hypot(goal - q.x, q.y))
            keeper.position, keeper.home = "GK", FORMATION[0][1]

    def _offside_positions(self, kicker: Player) -> set[int]:
        """The kicker's teammates in the opponents' half nearer their goal line than both
        the ball and the second-last opponent."""
        direction = self.attack(kicker.team)
        opponents = sorted((q.x * direction for q in self.players if q.team != kicker.team), reverse=True)
        line = max(0.0, self.ball.x * direction, opponents[1] if len(opponents) > 1 else -math.inf)
        return {
            q.id for q in self.players
            if q.team == kicker.team and q is not kicker and q.x * direction > line
        }  # fmt: skip

    def _offside(self, p: Player) -> None:
        team = 1 - p.team
        self._event("offside", team, p.id)
        x = max(-pitch.HALF_LENGTH, min(pitch.HALF_LENGTH, p.x))
        y = max(-pitch.HALF_WIDTH, min(pitch.HALF_WIDTH, p.y))
        self._restart("free_kick", team, x, y, indirect=True)

    # -- substitutions ----------------------------------------------------------------------

    def _substitute(self) -> None:
        """Make the substitutions asked for, now that play has stopped."""
        for off, on in self.pending:
            p, q = self.player(off), self.player(on)
            if self.phase != "half_time" and self.window_at[p.team] != self.stoppage:
                self.windows[p.team] += 1
                self.window_at[p.team] = self.stoppage
            self.substitutions[p.team] += 1
            self.players[self.players.index(p)] = q
            self.bench.remove(q)
            q.x, q.y, q.vx, q.vy, q.heading = p.x, p.y, 0.0, 0.0, p.heading
            q.position, q.home = p.position, p.home
            self.commands[q.id] = Hold()
            if self.taker == off:
                self.taker = on
            self._event("substitution", p.team, off=off, on=on)
        self.pending = []

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
            # no goal straight from an indirect free kick
            if abs(y) < pitch.GOAL_WIDTH / 2 and z < pitch.GOAL_HEIGHT and self.indirect is None:
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

    def _restart(
        self, kind: str, team: int, x: float, y: float, indirect: bool = False, taker: int | None = None
    ) -> None:
        self.ball.place(x, y)
        self.phase, self.restart_team, self.since_restart = kind, team, 0.0
        self.owner = None
        self.offside, self.indirect, self.penalty_live = set(), None, False
        self.restart_indirect, self.taker = indirect, taker
        self.stoppage += 1
        if kind == "free_kick":
            self._event(kind, team, indirect=indirect)
        else:
            self._event(kind, team, taker)

    def _kickoff(self, team: int, place_players: bool = False) -> None:
        self._restart("kickoff", team, 0.0, 0.0)
        self.events.pop()  # a kick-off is not shown as an event
        if place_players:
            self._place_for_kickoff()

    def _place_for_kickoff(self) -> None:
        for p in self.players:
            side = -self.attack(p.team)
            p.x, p.y = -side * p.home[0], -side * p.home[1]
            p.vx = p.vy = 0.0
            p.heading = 0.0 if side < 0 else math.pi
            self.commands[p.id] = Hold()
        self._keep_distance(everyone=True)
        # the kicking team's most advanced player stands at the ball
        team = [p for p in self.players if p.team == self.restart_team]
        taker = max(team, key=lambda p: p.home[0])
        side = -self.attack(taker.team)
        taker.x, taker.y = side * 0.6, 0.0

    def _keep_distance(self, everyone: bool = False) -> None:
        """Put right the players only just out of place for the restart, or `everyone`;
        the others are running back (see _move)."""
        for p in self.players:
            if everyone or self._out_of_place(p) <= OUT_OF_PLACE:
                p.x, p.y = self._allowed_spot(p)

    def _allowed_spot(self, p: Player, margin: float = 0.0) -> tuple[float, float]:
        """The nearest spot to `p` where the laws let it stand for this restart, `margin` m
        clear of the line: in its own half at a kick-off, and as far from the ball as the
        restart requires if it is an opponent of the restarting team; at a goal kick, also
        outside the penalty area."""
        if self.phase == "penalty":
            return self._penalty_spot(p, margin)
        x, y = p.x, p.y
        if self.phase == "kickoff" and x * -self.attack(p.team) < 0:
            x = -self.attack(p.team) * margin  # back over halfway
        goal = math.copysign(pitch.HALF_LENGTH, self.ball.x)
        if (self.phase == "goal_kick" and p.team != self.restart_team
                and abs(x - goal) <= pitch.PENALTY_DEPTH and abs(y) <= pitch.PENALTY_HALF_WIDTH):
            x = goal - math.copysign(pitch.PENALTY_DEPTH + 0.01 + margin, goal)  # just outside
        if p.team != self.restart_team and self.phase in RESTART_DISTANCE:
            x, y = self._away(p, x, y, RESTART_DISTANCE[self.phase] + margin)
        return x, y

    def _out_of_place(self, p: Player) -> float:
        """How far `p` is from where the laws let it stand for this restart; 0 in play."""
        if self.phase not in RESTARTS:
            return 0.0
        x, y = self._allowed_spot(p)
        return math.hypot(x - p.x, y - p.y)

    def _away(self, p: Player, x: float, y: float, distance: float) -> tuple[float, float]:
        """(x, y), moved out to `distance` from the ball if it is nearer."""
        dx, dy = x - self.ball.x, y - self.ball.y
        dist = math.hypot(dx, dy)
        if dist >= distance:
            return x, y
        if dist == 0:
            dx, dy, dist = -self.attack(p.team), 0.0, 1.0  # towards its own half
        return self.ball.x + dx / dist * distance, self.ball.y + dy / dist * distance

    def _penalty_spot(self, p: Player, margin: float) -> tuple[float, float]:
        """Where `p` may stand for a penalty: the defending goalkeeper on its goal line between
        the posts; everyone else but the taker outside the penalty area and arc, and behind
        the penalty mark."""
        if p.id == self.taker:
            return p.x, p.y
        goal = math.copysign(pitch.HALF_LENGTH, self.ball.x)
        out = -math.copysign(1.0, goal)  # from the goal line towards halfway
        if p.team != self.restart_team and p.position == "GK":
            return goal + out * PLAYER_RADIUS, max(-pitch.GOAL_WIDTH / 2, min(pitch.GOAL_WIDTH / 2, p.y))
        x, y = p.x, p.y
        if abs(x - goal) <= pitch.PENALTY_DEPTH and abs(y) <= pitch.PENALTY_HALF_WIDTH:
            x = goal + out * (pitch.PENALTY_DEPTH + 0.01)  # just outside, so a step in is put right
        if (x - self.ball.x) * out < 0:
            x = self.ball.x  # level with the mark at the nearest
        x += out * margin
        return self._away(p, x, y, RESTART_DISTANCE["penalty"] + margin)

    def _end_half(self) -> None:
        self.owner = None
        if self.period == 1:
            self.phase, self.since_restart = "half_time", 0.0
            self._event("half_time", None)
        else:
            self.phase = "full_time"
            self._event("full_time", None)

    def _event(self, kind: str, team: int | None, player: int | None = None, **details) -> None:
        event = {"type": "event", "kind": kind, "t": round(self.t, 3), "team": team}
        if player is not None:
            event["player"] = player
        event.update(details)
        self.events.append(event)

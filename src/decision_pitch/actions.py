"""What a decision model is asked and how its answer moves the player.

A model answers with one of ACTIONS. The player keeps carrying the action out, turned
into an engine command on every step by the rules below, until the model's next answer
arrives. Each action is carried out as the moment allows, so a player whose model gives
the same answer again and again still plays sensible football. The rules are the same for
both teams, and the state is told from the player's own side of the pitch, so a team
attacking the other way sees the same text."""

from __future__ import annotations

import math

from decision_pitch import pitch
from decision_pitch.arena.models import Question
from decision_pitch.bots import (
    DRIBBLE_SPEED,
    JOG,
    PRESSURE,
    SHOOTING_RANGE,
    _goal_line_spot,
    _home,
    _on_the_ball,
    _pass_or_clear,
    _press_spot,
    _save_spot,
    _space,
    _take_restart,
    _taker,
    _wall_spot,
)
from decision_pitch.bots import command as bot_command
from decision_pitch.match import RESTARTS, Command, Hold, KickTo, Match, MoveTo
from decision_pitch.physics import Player

ACTIONS = {
    "press": "run at the ball to win it or collect it",
    "hold": "keep your place in the team's shape",
    "support": "move into space ahead to offer a pass",
    "mark": "stay goal-side of the nearest opponent",
    "dribble": "run with the ball towards their goal",
    "pass": "pass to your best-placed open teammate, or clear if none is open",
    "shoot": "shoot at their goal, from in range",
    "clear": "kick the ball long upfield",
}
KICKS = ("pass", "shoot", "clear")  # spent once the ball is kicked
INSTRUCTIONS = (
    "Choose this soccer player's next action. It is carried out until your next answer "
    "arrives, and the match does not wait for you. Dribble, pass, shoot and clear need the "
    "ball: without it, you go for it if you are nearest."
)
NEARBY = 3  # teammates and opponents described, nearest first
POSITIONS = {"GK": "goalkeeper", "DF": "defender", "MF": "midfielder", "FW": "forward"}
RESTART_NAMES = {"kickoff": "kick off", "throw_in": "take a throw-in", "goal_kick": "take a goal kick",
                 "corner": "take a corner", "free_kick": "take a free kick",
                 "penalty": "take a penalty"}  # fmt: skip


def command(m: Match, p: Player, action: str) -> Command:
    """The engine command that carries out `action` for `p` now."""
    if m.phase == "half_time":
        return Hold()
    direction = m.attack(p.team)
    if action == "shoot" and math.hypot(direction * pitch.HALF_LENGTH - p.x, p.y) >= SHOOTING_RANGE:
        if m.phase == "play" and m.owner == p.id:
            return _on_the_ball(m, p)  # into range first, passing when pressed
        action = "dribble"
    if m.phase in RESTARTS:
        taker = m.restart_team == p.team and p.id == _taker(m, p.team).id
        if taker and action not in KICKS:
            return _take_restart(m, p)  # the ball is not carried, and nobody else can play it
        if not taker and (wall := _wall_spot(m, p)):
            return MoveTo(*wall, JOG)  # the wall lines up whatever the action
        elif not taker and action in ("press", "dribble", *KICKS):
            action = "hold"  # only the taker goes to the ball
    if m.owner == p.id and action in ("press", "hold", "support", "mark"):
        return _on_the_ball(m, p)  # it has the ball: it keeps playing it
    if p.position == "GK" and action in ("press", "mark"):
        return bot_command(m, p)  # a keeper keeps its goal, coming for the ball as the bot does
    if m.phase == "play" and m.owner != p.id and action in ("dribble", *KICKS):
        return bot_command(m, p)  # the nearest goes for the ball; the others keep their places
    if action == "press" and m.owner is not None and m.player(m.owner).team == p.team:
        action = "support"  # a teammate has it
    if action == "hold":
        if p.position == "GK":
            return MoveTo(*(_save_spot(m, p) or _goal_line_spot(m, p)))
        return MoveTo(*_home(m, p), JOG)
    if action == "support":
        if p.position == "GK":
            return MoveTo(*(_save_spot(m, p) or _goal_line_spot(m, p)))
        return MoveTo(*_home(m, p, attacking=True), JOG)
    if action == "mark":
        opponents = [q for q in m.players if q.team != p.team and q.position != "GK"]
        q = min(opponents, key=lambda q: math.hypot(q.x - p.x, q.y - p.y))
        goal_x = -direction * pitch.HALF_LENGTH
        dist = math.hypot(goal_x - q.x, q.y) or 1.0
        return MoveTo(q.x + (goal_x - q.x) / dist * 2, q.y - q.y / dist * 2)
    if action == "dribble":
        return MoveTo(direction * pitch.HALF_LENGTH, p.y * 0.8, DRIBBLE_SPEED)
    if action == "pass":
        return _pass_or_clear(m, p)
    if action == "shoot":
        return KickTo(direction * pitch.HALF_LENGTH, _far_post(m, p), 24.0, 0.06)
    if action == "clear":
        return KickTo(p.x + direction * 40, p.y * 0.5, 26.0, 0.5)
    return MoveTo(*_press_spot(m, p))  # press, without the ball


def _far_post(m: Match, p: Player) -> float:
    """Aim inside the post further from the goalkeeper."""
    keeper = next(q for q in m.players if q.team != p.team and q.position == "GK")
    side = -1 if keeper.y > 0 else 1
    return side * (pitch.GOAL_WIDTH / 2 - 0.6)


def question(
    m: Match, p: Player, action: str, answer: float | None, instruction: str | None = None
) -> Question:
    """What `p`'s model is asked: the state as `p` sees it, with `action` the one it is
    carrying out, `answer` its model's recent answer time in seconds (None before its
    first) and `instruction` its manager's latest instruction."""
    team, other = m.teams[p.team].name, m.teams[1 - p.team].name
    direction = m.attack(p.team)
    half = "1st" if m.period == 1 else "2nd"
    parts = [
        f"You are {p.name} ({p.number}), a {team} {POSITIONS[p.position]}.",
        f"{m.clock()}, {half} half, {team} {m.score[p.team]}-{m.score[1 - p.team]} {other}.",
    ]
    if m.phase in RESTARTS:
        taking = m.restart_team == p.team
        you = ", you take it" if taking and p.id == _taker(m, p.team).id else ""
        parts.append(f"{team if taking else other} {RESTART_NAMES[m.phase]}{you}.")
    elif m.phase == "play":
        parts.append("Play is on.")
    else:
        parts.append("Half time.")
    x, y = p.x * direction, p.y * direction
    goal = math.hypot(pitch.HALF_LENGTH - x, y)
    parts.append(
        f"You: {abs(x):.0f} m into {'their' if x > 0 else 'your'} half, "
        f"{abs(y):.0f} m {'left' if y > 0 else 'right'} of centre, {p.speed:.0f} m/s, "
        f"doing {action}; their goal {goal:.0f} m."
    )
    b = m.ball
    if m.owner == p.id:
        held = "you have it"
    elif m.owner is not None:
        q = m.player(m.owner)
        held = f"{q.name} ({'teammate' if q.team == p.team else 'opponent'}) has it"
    else:
        speed = math.hypot(b.vx, b.vy)
        held = "loose" + (f", {speed:.0f} m/s" if speed >= 1 else "") + (", in the air" if b.z > 1 else "")
    parts.append(f"Ball: {_offset(b.x - p.x, b.y - p.y, direction)}, {held}.")
    for label, team_index in (("Teammates", p.team), ("Opponents", 1 - p.team)):
        others = sorted(
            (q for q in m.players if q.team == team_index and q.id != p.id),
            key=lambda q: math.hypot(q.x - p.x, q.y - p.y),
        )[:NEARBY]
        described = [
            f"{q.name} {_offset(q.x - p.x, q.y - p.y, direction)}"
            + (" open" if label == "Teammates" and _space(m, q) >= PRESSURE else "")
            for q in others
        ]
        parts.append(f"{label}: {'; '.join(described)}.")
    if instruction:
        parts.append(f"Manager: {instruction}")
    if answer is not None:
        parts.append(f"Your answers take {answer:.1f} s.")
    return Question(" ".join(parts), ACTIONS, INSTRUCTIONS)


def _offset(dx: float, dy: float, direction: int) -> str:
    """Where a point is from the player: ahead is towards their goal, left as it faces it."""
    ahead, left = dx * direction, dy * direction
    if math.hypot(ahead, left) < 1:
        return "at your feet"
    parts = []
    if abs(ahead) >= 1:
        parts.append(f"{abs(ahead):.0f} m {'ahead' if ahead > 0 else 'behind'}")
    if abs(left) >= 1:
        parts.append(f"{abs(left):.0f} m {'left' if left > 0 else 'right'}")
    return " ".join(parts)

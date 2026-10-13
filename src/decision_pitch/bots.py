"""The built-in bot: simple rules that play any position, so a full match runs with no
model at all. Both teams use the same rules."""

from __future__ import annotations

import math

from decision_pitch import pitch
from decision_pitch.match import RESTARTS, Command, Hold, KickTo, Match, MoveTo
from decision_pitch.physics import ROLLING, Player

SHOOTING_RANGE = 24.0  # m from goal
PRESSURE = 4.0  # m: an opponent this close makes the player pass
DRIBBLE_SPEED = 6.0
JOG = 5.0


def play(match: Match) -> None:
    """Give every player its bot command."""
    for p in match.players:
        match.command(p.id, command(match, p))


def play_match(match: Match) -> Match:
    """Play `match` to full time with bots on every player, as fast as it runs."""
    while match.phase != "full_time":
        play(match)
        match.step()
    return match


def command(m: Match, p: Player) -> Command:
    if m.phase == "half_time":
        return Hold()
    if m.phase in RESTARTS:
        if m.restart_team == p.team and p.id == _taker(m, p.team).id:
            return _pass_or_clear(m, p)
        return MoveTo(*_home(m, p), JOG)
    if m.owner == p.id:
        return _on_the_ball(m, p)
    if m.owner is not None and m.player(m.owner).team == p.team:
        return MoveTo(*_home(m, p, attacking=True), JOG)
    if p.position == "GK":
        if _ball_in_own_area(m, p) and p.id == _nearest(m, p.team).id:
            return MoveTo(m.ball.x, m.ball.y)
        return MoveTo(*_goal_line_spot(m, p))
    if p.id == _nearest(m, p.team, outfield=True).id:
        # meet the ball where it is going
        return MoveTo(m.ball.x + m.ball.vx * 0.3, m.ball.y + m.ball.vy * 0.3)
    return MoveTo(*_home(m, p), JOG)


def _on_the_ball(m: Match, p: Player) -> Command:
    direction = m.attack(p.team)
    goal_x = direction * pitch.HALF_LENGTH
    if p.position != "GK" and math.hypot(goal_x - p.x, p.y) < SHOOTING_RANGE:
        aim = m.rng.uniform(-pitch.GOAL_WIDTH / 2 + 0.6, pitch.GOAL_WIDTH / 2 - 0.6)
        return KickTo(goal_x, aim, 24.0, 0.06)
    if p.position == "GK" or _pressed(m, p):
        return _pass_or_clear(m, p)
    return MoveTo(goal_x, p.y * 0.8, DRIBBLE_SPEED)


def _pass_or_clear(m: Match, p: Player) -> Command:
    """Pass to the most useful open teammate, or kick the ball long upfield."""
    direction = m.attack(p.team)
    best, best_score = None, -math.inf
    for q in m.players:
        if q.team != p.team or q.id == p.id or q.position == "GK":
            continue
        dist = math.hypot(q.x - p.x, q.y - p.y)
        if not 5 < dist < 35 or _space(m, q) < 3:
            continue
        score = (q.x - p.x) * direction - 0.3 * abs(dist - 15)
        if score > best_score:
            best, best_score = q, score
    if best is None:
        return KickTo(p.x + direction * 40, p.y * 0.5, 26.0, 0.5)
    dist = math.hypot(best.x - p.x, best.y - p.y)
    # lead the receiver a little; long balls go in the air
    tx, ty = best.x + direction * 2, best.y
    if dist > 25:
        return KickTo(tx, ty, min(26.0, 9 + dist * 0.45), 0.5)
    return KickTo(tx, ty, min(24.0, math.sqrt(2 * ROLLING * dist) * 1.4 + 4), 0.0)


def _pressed(m: Match, p: Player) -> bool:
    return _space(m, p) < PRESSURE


def _space(m: Match, p: Player) -> float:
    """Distance to the nearest opponent."""
    return min(math.hypot(q.x - p.x, q.y - p.y) for q in m.players if q.team != p.team)


def _nearest(m: Match, team: int, outfield: bool = False) -> Player:
    players = [q for q in m.players if q.team == team and not (outfield and q.position == "GK")]
    return min(players, key=lambda q: math.hypot(m.ball.x - q.x, m.ball.y - q.y))


def _taker(m: Match, team: int) -> Player:
    if m.phase == "goal_kick":
        return next(q for q in m.players if q.team == team and q.position == "GK")
    return _nearest(m, team, outfield=True)


def _home(m: Match, p: Player, attacking: bool = False) -> tuple[float, float]:
    """The player's formation spot, shifted with the ball."""
    direction = m.attack(p.team)
    if m.phase == "kickoff":
        return direction * p.home[0], direction * p.home[1]
    bx, by = m.ball.x * direction, m.ball.y * direction  # the ball in the team's frame
    x = p.home[0] + 0.5 * bx + (8 if attacking else 0) + 15
    y = p.home[1] * 0.85 + 0.25 * by
    x = max(-pitch.HALF_LENGTH + 4, min(pitch.HALF_LENGTH - 6, x))
    return direction * x, direction * y


def _goal_line_spot(m: Match, p: Player) -> tuple[float, float]:
    goal_x = -m.attack(p.team) * pitch.HALF_LENGTH
    y = max(-pitch.GOAL_WIDTH / 2, min(pitch.GOAL_WIDTH / 2, m.ball.y * 0.25))
    return goal_x + m.attack(p.team) * 1.5, y


def _ball_in_own_area(m: Match, p: Player) -> bool:
    goal_x = -m.attack(p.team) * pitch.HALF_LENGTH
    return abs(m.ball.x - goal_x) <= pitch.PENALTY_DEPTH and abs(m.ball.y) <= pitch.PENALTY_HALF_WIDTH

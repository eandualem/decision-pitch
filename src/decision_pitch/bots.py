"""The built-in bot: simple rules that play any position, so a full match runs with no
model at all. Both teams use the same rules."""

from __future__ import annotations

import math

from decision_pitch import pitch
from decision_pitch.match import RESTARTS, Command, Hold, KickTo, Match, MoveTo
from decision_pitch.physics import ROLLING, TOP_SPEED, Player

SHOOTING_RANGE = 24.0  # m from goal
FREE_KICK_RANGE = 30.0  # m from goal within which a direct free kick is shot
WALL = 3  # players in a defensive wall
WALL_RANGE = 32.0  # m from goal within which a free kick gets a wall
WALL_DISTANCE = 9.5  # m from the ball, just beyond the 9.15 the laws require
PRESSURE = 4.0  # m: an opponent this close makes the player pass
DRIBBLE_SPEED = 6.0
JOG = 5.0
ROUND_WIDE = 2.0  # m to the side that a challenger from behind passes the carrier at
ROUND_AHEAD = 1.5  # m ahead of the carrier it aims for once out wide, so it gets in front
ROUND_LEAD = 1.0  # s of the carrier's run it aims further ahead by
ROUND_INTERCEPT = 2.0  # s ahead, at most, that it aims to meet the ball once in front
ROUND_UNTIL = 0.3  # cosine from the carrier's facing at which it goes for the ball


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
            return _take_restart(m, p)
        wall = _wall_spot(m, p)
        return MoveTo(*(wall or _home(m, p)), JOG)
    if m.owner == p.id:
        return _on_the_ball(m, p)
    if m.owner is not None and m.player(m.owner).team == p.team:
        return MoveTo(*_home(m, p, attacking=True), JOG)
    if p.position == "GK":
        if _ball_in_own_area(m, p) and p.id == _nearest(m, p.team).id:
            return MoveTo(m.ball.x, m.ball.y)
        return MoveTo(*_goal_line_spot(m, p))
    if p.id == _nearest(m, p.team, outfield=True).id:
        return MoveTo(*_press_spot(m, p))
    return MoveTo(*_home(m, p), JOG)


def _press_spot(m: Match, p: Player) -> tuple[float, float]:
    """Where `p` runs to win the ball: where it is going. From behind an opponent carrying
    it, `p` first comes out wide and draws level, since running into a carrier from behind
    is a foul."""
    b = m.ball
    c = m.player(m.owner) if m.owner is not None else None
    if c is None or c.team == p.team:
        return b.x + b.vx * 0.3, b.y + b.vy * 0.3
    fx, fy = math.cos(c.heading), math.sin(c.heading)
    dx, dy = p.x - c.x, p.y - c.y
    if dx * fx + dy * fy >= ROUND_UNTIL * math.hypot(dx, dy):
        # into the ball's path, where it can be reached before the carrier's body
        lead = _intercept(b.x - p.x, b.y - p.y, b.vx, b.vy, TOP_SPEED)
        return b.x + b.vx * lead, b.y + b.vy * lead
    across = fx * dy - fy * dx  # how far p is to the carrier's left
    side = 1.0 if across >= 0 else -1.0
    on = min(1.0, abs(across) / ROUND_WIDE)  # run on past the carrier once out wide
    ahead_x, ahead_y = fx * ROUND_AHEAD + c.vx * ROUND_LEAD, fy * ROUND_AHEAD + c.vy * ROUND_LEAD
    return c.x - fy * side * ROUND_WIDE + ahead_x * on, c.y + fx * side * ROUND_WIDE + ahead_y * on


def _intercept(dx: float, dy: float, vx: float, vy: float, speed: float) -> float:
    """How soon a runner at `speed` can meet a point (dx, dy) away moving at (vx, vy), in
    seconds, at most ROUND_INTERCEPT."""
    a = vx * vx + vy * vy - speed * speed
    b = 2 * (dx * vx + dy * vy)
    c = dx * dx + dy * dy
    if a >= 0:
        return ROUND_INTERCEPT
    t = (-b - math.sqrt(b * b - 4 * a * c)) / (2 * a)
    return min(ROUND_INTERCEPT, max(0.0, t))


def _on_the_ball(m: Match, p: Player) -> Command:
    direction = m.attack(p.team)
    goal_x = direction * pitch.HALF_LENGTH
    if p.position != "GK" and math.hypot(goal_x - p.x, p.y) < SHOOTING_RANGE:
        return _shot(m, p)
    if p.position == "GK" or _pressed(m, p):
        return _pass_or_clear(m, p)
    return MoveTo(goal_x, p.y * 0.8, DRIBBLE_SPEED)


def _shot(m: Match, p: Player, loft: float = 0.06) -> Command:
    aim = m.rng.uniform(-pitch.GOAL_WIDTH / 2 + 0.6, pitch.GOAL_WIDTH / 2 - 0.6)
    return KickTo(m.attack(p.team) * pitch.HALF_LENGTH, aim, 24.0, loft)


def _take_restart(m: Match, p: Player) -> Command:
    """Shoot a penalty, and a direct free kick in range over the wall; pass anything else."""
    if m.phase == "penalty":
        return _shot(m, p)
    goal = math.hypot(m.attack(p.team) * pitch.HALF_LENGTH - m.ball.x, m.ball.y)
    if m.phase == "free_kick" and not m.restart_indirect and goal < FREE_KICK_RANGE:
        return _shot(m, p, loft=0.2)
    return _pass_or_clear(m, p)


def _wall_spot(m: Match, p: Player) -> tuple[float, float] | None:
    """Where `p` stands in its team's wall at a free kick near its goal, if it is in it:
    the defending team's nearest outfield players, across the line from the ball to the
    goal."""
    if m.phase != "free_kick" or p.team == m.restart_team or p.position == "GK":
        return None
    goal_x = -m.attack(p.team) * pitch.HALF_LENGTH
    dx, dy = goal_x - m.ball.x, -m.ball.y
    dist = math.hypot(dx, dy)
    if dist > WALL_RANGE:
        return None
    outfield = [q for q in m.players if q.team == p.team and q.position != "GK"]
    wall = sorted(sorted(outfield, key=lambda q: math.hypot(q.x - m.ball.x, q.y - m.ball.y))[:WALL],
                  key=lambda q: q.id)  # fmt: skip
    if p not in wall:
        return None
    ux, uy = dx / dist, dy / dist
    across = (wall.index(p) - (len(wall) - 1) / 2) * 0.85
    return m.ball.x + ux * WALL_DISTANCE - uy * across, m.ball.y + uy * WALL_DISTANCE + ux * across


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
    if m.phase == "penalty" and m.taker is not None:
        return m.player(m.taker)
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

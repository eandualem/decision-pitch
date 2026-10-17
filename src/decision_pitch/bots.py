"""The built-in bot: simple rules that play any position, so a full match runs with no
model at all. Both teams use the same rules."""

from __future__ import annotations

import math
from dataclasses import replace

from decision_pitch import pitch
from decision_pitch.match import CONTROL, CONTROL_HEIGHT, RESTARTS, Command, Hold, KickTo, Match, MoveTo
from decision_pitch.physics import ROLLING, TOP_SPEED, Player, _step_ball

SHOOTING_RANGE = 24.0  # m from goal
CLOSE_RANGE = 16.0  # m from goal: an unpressed player on the ball carries it this close before shooting
FREE_KICK_RANGE = 30.0  # m from goal within which a direct free kick is shot
WALL = 3  # players in a defensive wall
WALL_RANGE = 32.0  # m from goal within which a free kick gets a wall
WALL_DISTANCE = 9.5  # m from the ball, just beyond the 9.15 the laws require
PRESSURE = 4.0  # m: a teammate with no opponent this close is open for a pass
PRESSED = 2.5  # m: an opponent this close makes the player on the ball pass
DRIBBLE_SPEED = 6.0
WALK = 1.5  # m/s: the slowest a player keeping the team's shape moves to its place
JOG = 5.0  # m/s: the fastest
PACE = 2.0  # s a player keeping the team's shape gives itself to reach its place
PACE_DEFENDING = 1.2  # s, while the other team has the ball
LANES = (0.0, 25.0, -25.0, 50.0, -50.0)  # degrees from straight on that a dribbler may carry the ball
LANE_LOOK = 6.0  # m along a lane at which its room from the nearest opponent is judged
LANE_ROOM = 8.0  # m of room beyond which more makes no difference
LANE_KEEP = 2.0  # m more room another lane needs before a dribbler leaves its own
DRIBBLE_AHEAD = 10.0  # m along its lane that a dribbler aims
ROUND_WIDE = 2.0  # m to the side that a challenger from behind passes the carrier at
ROUND_AHEAD = 1.5  # m ahead of the carrier it aims for once out wide, so it gets in front
ROUND_LEAD = 1.0  # s of the carrier's run it aims further ahead by
ROUND_INTERCEPT = 2.0  # s ahead, at most, that it aims to meet the ball once in front
ROUND_UNTIL = 0.3  # cosine from the carrier's facing at which it goes for the ball
CHASE_AHEAD = 3.0  # s of a loose ball's path searched for the player who reaches it first
CHASE_STEP = 0.1  # s between the points of that path
RUN_THROUGH = 3.0  # m beyond its meeting spot that a chaser close to a moving ball aims
RUN_THROUGH_NEAR = 6.0  # m from the ball within which it does
RUN_THROUGH_SPEED = 1.0  # m/s the ball moves at, at least
SAVE_MARGIN = 1.0  # m outside a post within which a goalkeeper still covers a shot
SHAPE_FOLLOW = 0.9  # how far the team's shape moves with the ball, as a share of the ball's move
SHAPE_DEEPEST = 8.0  # m from its own goal line that an outfield player's place goes back to at most


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
        return _shape(m, p, wall or _home(m, p))
    if m.owner == p.id:
        return _on_the_ball(m, p)
    if m.owner is not None and m.player(m.owner).team == p.team:
        return _shape(m, p, _home(m, p, attacking=True))
    if p.position == "GK":
        if spot := _save_spot(m, p):
            return MoveTo(*spot, face=(m.ball.x, m.ball.y))
        if _ball_in_own_area(m, p) and p.id == _nearest(m, p.team).id:
            return MoveTo(m.ball.x, m.ball.y)
        return MoveTo(*_goal_line_spot(m, p), face=(m.ball.x, m.ball.y))
    if m.owner is None:
        chaser, spot = _chase(m, p.team)
        if p.id == chaser.id:
            return MoveTo(*_run_through(m, p, spot))
    elif p.id == _nearest(m, p.team, outfield=True).id:
        return MoveTo(*_press_spot(m, p))
    return _shape(m, p, _home(m, p))


def _shape(m: Match, p: Player, spot: tuple[float, float]) -> MoveTo:
    """`p`'s move to `spot` in the team's shape: walking or jogging by how far it is, and
    sooner while the other team has the ball, facing the ball (docs/decisions.md,
    section 2)."""
    defending = m.owner is not None and m.player(m.owner).team != p.team
    dist = math.hypot(spot[0] - p.x, spot[1] - p.y)
    speed = min(JOG, max(WALK, dist / (PACE_DEFENDING if defending else PACE)))
    return MoveTo(*spot, speed, face=(m.ball.x, m.ball.y))


_chases: tuple[tuple, dict[int, tuple[Player, tuple[float, float]]]] = ((), {})


def _chase(m: Match, team: int) -> tuple[Player, tuple[float, float]]:
    """The outfield player of `team` who can reach the loose ball first on its path, and
    where; so a pass is met by its receiver, not chased by its passer. Worked out once per
    step for both teams."""
    global _chases
    b = m.ball
    key = (id(m), m.t, b.x, b.y, b.z, b.vx, b.vy, b.vz)
    if _chases[0] != key:
        path, ball = [(b.x, b.y, b.z)], replace(b)
        for _ in range(round(CHASE_AHEAD / CHASE_STEP)):
            _step_ball(ball, CHASE_STEP)  # coarse: a guide to where it goes, not a replay
            if abs(ball.x) > pitch.HALF_LENGTH or abs(ball.y) > pitch.HALF_WIDTH:
                break  # it goes out: meet it before the line
            path.append((ball.x, ball.y, ball.z))
        found = {}
        for side in (0, 1):
            best = None
            for q in m.players:
                if q.team == side and q.position != "GK":
                    time, spot = _meet(q, path, m.recovering.get(q.id, 0.0))
                    if best is None or time < best[0]:
                        best = (time, q, spot)
            found[side] = best[1:]
        _chases = (key, found)
    return _chases[1][team]


def _run_through(m: Match, p: Player, spot: tuple[float, float]) -> tuple[float, float]:
    """Where `p`, chasing the loose ball, runs: close to a moving ball, on beyond its meeting
    spot, so it arrives at full speed rather than slowing to stop there as the ball rolls on."""
    b = m.ball
    dx, dy = spot[0] - p.x, spot[1] - p.y
    dist = math.hypot(dx, dy)
    if math.hypot(b.vx, b.vy) < RUN_THROUGH_SPEED or math.hypot(b.x - p.x, b.y - p.y) > RUN_THROUGH_NEAR or dist == 0:
        return spot
    return spot[0] + dx / dist * RUN_THROUGH, spot[1] + dy / dist * RUN_THROUGH


def _meet(
    q: Player, path: list[tuple[float, float, float]], ready: float
) -> tuple[float, tuple[float, float]]:
    """How soon `q`, able to play the ball after `ready` seconds, can reach a ball on `path`
    and where; if it cannot within the path, after its end, at the path's last point."""
    for i, (x, y, z) in enumerate(path):
        t = i * CHASE_STEP
        if t >= ready and z <= CONTROL_HEIGHT and math.hypot(x - q.x, y - q.y) - CONTROL <= TOP_SPEED * t:
            return t, (x, y)
    x, y, _ = path[-1]
    return CHASE_AHEAD + math.hypot(x - q.x, y - q.y) / TOP_SPEED, (x, y)


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
    if abs(a) < 1e-9:  # as fast as the runner: met only if it is coming towards it
        times = [-c / b] if b < 0 else []
    elif (d := b * b - 4 * a * c) >= 0:
        times = [(-b - math.sqrt(d)) / (2 * a), (-b + math.sqrt(d)) / (2 * a)]
    else:
        times = []
    return min([t for t in times if t >= 0] + [ROUND_INTERCEPT])


def _on_the_ball(m: Match, p: Player) -> Command:
    direction = m.attack(p.team)
    goal_x = direction * pitch.HALF_LENGTH
    goal = math.hypot(goal_x - p.x, p.y)
    if p.position != "GK" and goal < SHOOTING_RANGE and (goal < CLOSE_RANGE or _pressed(m, p)):
        return _shot(m, p)
    if p.position == "GK" or _pressed(m, p):
        return _pass_or_clear(m, p)
    return MoveTo(*_dribble_spot(m, p), DRIBBLE_SPEED)


def _dribble_spot(m: Match, p: Player) -> tuple[float, float]:
    """Where `p` carries the ball: along the lane towards their goal with the most room
    from the nearest opponent, keeping its own lane unless another has clearly more
    (docs/decisions.md, section 2)."""
    straight = math.atan2(-0.2 * p.y, m.attack(p.team) * pitch.HALF_LENGTH - p.x)
    opponents = [q for q in m.players if q.team != p.team]
    best, best_score = straight, -math.inf
    for lane in LANES:
        angle = straight + math.radians(lane)
        x, y = p.x + math.cos(angle) * LANE_LOOK, p.y + math.sin(angle) * LANE_LOOK
        if abs(y) > pitch.HALF_WIDTH - 2:
            continue  # it would carry the ball out
        room = min([LANE_ROOM] + [math.hypot(q.x - x, q.y - y) for q in opponents])
        own = math.cos(angle - p.heading) > math.cos(math.radians(LANES[1] / 2))  # the lane it is in
        score = room + (LANE_KEEP if own else 0.0)
        if score > best_score:
            best, best_score = angle, score
    return p.x + math.cos(best) * DRIBBLE_AHEAD, p.y + math.sin(best) * DRIBBLE_AHEAD


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
    return _pass_to(m, p, best)


def _pass_to(m: Match, p: Player, best: Player) -> KickTo:
    """`p`'s pass to teammate `best`."""
    dist = math.hypot(best.x - p.x, best.y - p.y)
    # long balls go in the air
    if dist > 25:
        speed, loft = min(26.0, 9 + dist * 0.45), 0.5
    else:
        speed, loft = min(24.0, math.sqrt(2 * ROLLING * dist) * 1.4 + 4), 0.0
    travel = dist / speed  # aim where the receiver will be when the ball gets there
    return KickTo(best.x + best.vx * travel, best.y + best.vy * travel, speed, loft)


def _pressed(m: Match, p: Player) -> bool:
    return _space(m, p) < PRESSED


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
    """The player's formation spot, shifted with the ball; a goalkeeper's is on its line."""
    direction = m.attack(p.team)
    if m.phase == "kickoff":
        return direction * p.home[0], direction * p.home[1]
    if p.position == "GK":
        return _goal_line_spot(m, p)
    bx, by = m.ball.x * direction, m.ball.y * direction  # the ball in the team's frame
    x = p.home[0] + SHAPE_FOLLOW * bx + (8 if attacking else 0) + 15
    y = p.home[1] * 0.85 + 0.25 * by
    x = max(-pitch.HALF_LENGTH + SHAPE_DEEPEST, min(pitch.HALF_LENGTH - 6, x))
    if m.phase == "goal_kick" and p.team != m.restart_team:
        x = min(x, pitch.HALF_LENGTH - pitch.PENALTY_DEPTH - 1)  # outside the area until the kick
    return direction * x, direction * y


def _goal_line_spot(m: Match, p: Player) -> tuple[float, float]:
    goal_x = -m.attack(p.team) * pitch.HALF_LENGTH
    y = max(-pitch.GOAL_WIDTH / 2, min(pitch.GOAL_WIDTH / 2, m.ball.y * 0.25))
    return goal_x + m.attack(p.team) * 1.5, y


def _save_spot(m: Match, p: Player) -> tuple[float, float] | None:
    """Where a goalkeeper gets across to a ball heading into its goal: the ball's line at
    the keeper's depth. None if the ball is not heading into the goal."""
    goal_x = -m.attack(p.team) * pitch.HALF_LENGTH
    b = m.ball
    if m.owner is not None or (goal_x - b.x) * b.vx <= 0 or (p.x - b.x) * b.vx <= 0:
        return None  # carried, moving away from the goal, or already past the keeper
    if abs(b.y + b.vy * (goal_x - b.x) / b.vx) > pitch.GOAL_WIDTH / 2 + SAVE_MARGIN:
        return None  # going wide
    return p.x, b.y + b.vy * (p.x - b.x) / b.vx


def _ball_in_own_area(m: Match, p: Player) -> bool:
    goal_x = -m.attack(p.team) * pitch.HALF_LENGTH
    return abs(m.ball.x - goal_x) <= pitch.PENALTY_DEPTH and abs(m.ball.y) <= pitch.PENALTY_HALF_WIDTH

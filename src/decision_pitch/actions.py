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
    CLOSE_RANGE,
    DRIBBLE_SPEED,
    FREE_KICK_RANGE,
    PRESSURE,
    SHOOTING_RANGE,
    WALK,
    _chase,
    _dribble_spot,
    _goal_line_spot,
    _home,
    _on_the_ball,
    _pass_or_clear,
    _pass_to,
    _press_spot,
    _pressed,
    _save_spot,
    _shape,
    _space,
    _take_restart,
    _taker,
    _wall_spot,
)
from decision_pitch.bots import command as bot_command
from decision_pitch.match import RESTARTS, AirKick, Command, Hold, KickTo, Match, MoveTo, Tackle, position_label
from decision_pitch.physics import DIAGONAL, ROLLING, Player

ACTIONS = {
    "wait": "stop with the ball at your feet and wait for support; opponents can tackle you",
    "dribble": "run with the ball into space towards their goal",
    "sprint": "knock the ball ahead and run on at full speed; an opponent can take it between touches",
    "take_on": "run at the nearest defender and cut past it; it can win the ball",
    "shield": "keep the ball with your back to the nearest opponent until a teammate is free; slow",
    "pass": "pass to your best-placed open teammate, or clear if none is open",
    "through_ball": "pass into the space ahead of a teammate further forward; it can be cut out",
    "cross": "lift the ball into the penalty area from wide",
    "shoot": "shoot at their goal",
    "clear": "kick the ball long upfield",
    "press": "run at the ball to win it or collect it",
    "tackle": "go straight in to win the ball now; it can be a foul",
    "slide_tackle": "slide in for the ball from further away; a miss leaves you on the ground, from behind it is a foul",
    "jockey": "back off facing the player on the ball, between it and your goal; safe, but gives ground",
    "hold": "keep your place in the team's shape",
    "support": "move into space ahead to offer a pass",
    "mark": "stay goal-side of the nearest opponent",
    "run_behind": "sprint beyond their last defender for a through ball; you can be offside",
}
ON_THE_BALL = ("wait", "dribble", "sprint", "take_on", "shield", "pass", "through_ball", "cross", "shoot", "clear")
OFF_THE_BALL = ("press", "tackle", "slide_tackle", "jockey", "hold", "support", "mark", "run_behind")
CHALLENGES = ("press", "tackle", "slide_tackle", "jockey")  # going for the ball an opponent has
AT_A_RESTART = ("hold", "support", "mark", "run_behind")  # for the players not taking it
KEEPER_ON_THE_BALL = ("wait", "pass", "through_ball", "clear")
KEEPER_OFF_THE_BALL = ("hold", "press")
KICKS = ("pass", "through_ball", "cross", "shoot", "clear")  # spent once the ball is kicked
INSTRUCTIONS = (
    "Choose this soccer player's next action. It is carried out until your next answer "
    "arrives, and the match does not wait for you."
    " Play your assigned role. Off the ball, preserve spacing and defensive cover; do not all "
    "chase the ball. Use the recovery target, teammate pressure and manager's defensive approach "
    "to decide whether to press, mark, support or hold. Hold means recover your shape, not stand still."
)
POSITIONS = {"GK": "goalkeeper", "DF": "defender", "MF": "midfielder", "FW": "forward"}
RESTART_NAMES = {"kickoff": "kick off", "throw_in": "take a throw-in", "goal_kick": "take a goal kick",
                 "corner": "take a corner", "free_kick": "take a free kick",
                 "penalty": "take a penalty"}  # fmt: skip
SHOT_ASKED = 30.0  # m from goal within which `shoot` is asked
CROSS_WIDE = 14.0  # m from the centre line at which the ball is wide enough to cross
CROSS_DEPTH = 36.0  # m from their goal line within which it is
CROSS_LOFT = 0.35  # radians
CROSS_SHORT = 2.0  # m short of its target that a cross lands, so it bounces up to the target low
TAKE_ON_RANGE = 10.0  # m: an opponent ahead this close can be taken on
TAKE_ON_CUT = 5.0  # m from it at which the dribbler cuts past
TAKE_ON_WIDE = 2.5  # m to its side that the dribbler passes it
TAKE_ON_BEYOND = 4.0  # m beyond it that the dribbler aims
SHIELD_RANGE = 5.0  # m: an opponent this close can be shielded from
LAY_OFF = 12.0  # m within which a shielding player lays the ball off to an open teammate
KNOCK = 3.5  # m/s faster than the player that a sprint knocks the ball ahead
SPRINT_THROUGH = 8.0  # m beyond a ball running away that a sprinting player aims, so it keeps its speed
THROUGH_RANGE = 40.0  # m: the furthest teammate a through ball is played to
THROUGH_LEAD = 6.0  # m ahead of the teammate's run that a through ball goes into space
THROUGH_ROOM = 2.0  # m of room from every opponent that its spot needs
RUN_BEYOND = 6.0  # m beyond the second-last defender that a run in behind aims
RUN_LANE = 25.0  # m from the centre line, at most, that a run in behind keeps to
RUN_REACH = 20.0  # m behind the offside line within which a player can run in behind
RUN_ON = 4.0  # m/s: a runner beyond the line still going faster than this carries on
CHALLENGE_RANGE = 15.0  # m from the opponent on the ball within which a slide or jockey is asked
JOCKEY_DISTANCE = 2.5  # m from the carrier, towards its own goal, that a jockeying player keeps


def options(m: Match, p: Player) -> dict[str, str]:
    """The actions `p`'s model is asked to choose from: those that apply to it now
    (docs/decisions.md, section 4)."""
    keeper = p.position == "GK"
    if m.phase in RESTARTS and m.restart_team == p.team and p.id == _taker(m, p.team).id:
        names = [a for a in KICKS if _applies(m, p, a)]
    elif keeper and m.owner == p.id and m.phase == "play":
        names = [a for a in KEEPER_ON_THE_BALL if _applies(m, p, a)]
    elif keeper:
        names = list(KEEPER_OFF_THE_BALL)
    elif m.phase in RESTARTS:
        names = [a for a in AT_A_RESTART if _applies(m, p, a)]
    elif m.owner == p.id:
        names = [a for a in ON_THE_BALL if _applies(m, p, a)]
    else:
        names = [a for a in OFF_THE_BALL if _applies(m, p, a)]
    return {a: ACTIONS[a] for a in names}


def _applies(m: Match, p: Player, action: str) -> bool:
    """Whether a kick or a move on the ball can be made from here."""
    goal = math.hypot(m.attack(p.team) * pitch.HALF_LENGTH - m.ball.x, m.ball.y)
    if action == "shoot":
        if m.phase == "penalty":
            return True
        if m.phase == "free_kick":
            return not m.restart_indirect and goal < FREE_KICK_RANGE
        return m.phase == "play" and goal < SHOT_ASKED
    if action == "cross":
        return _wide(m, p)
    if action == "through_ball":
        return _through(m, p) is not None
    if action == "take_on":
        return _ahead(m, p) is not None
    if action == "shield":
        return _space(m, p) < SHIELD_RANGE
    if action == "run_behind":
        return p.position != "GK" and _offside_line(m, p.team) - p.x * m.attack(p.team) <= RUN_REACH
    if action in CHALLENGES:
        c = m.player(m.owner) if m.owner is not None else None
        if c is not None and c.team == p.team:
            return False  # a teammate has it
        if action == "press":
            return True
        if c is None:
            return False
        return action == "tackle" or math.hypot(c.x - p.x, c.y - p.y) <= CHALLENGE_RANGE
    return True


def command(m: Match, p: Player, action: str, defending: str = "zonal") -> Command:
    """The engine command that carries out `action` for `p` now."""
    if m.phase == "half_time":
        return Hold()
    on_the_ball = m.owner == p.id
    if action == "wait" and m.phase == "play":
        return Hold() if on_the_ball else _shape(m, p, _home(m, p))
    if m.phase == "play" and not on_the_ball and action in ON_THE_BALL and action != "sprint":
        return _without_ball(m, p, action)
    direction = m.attack(p.team)
    goal = math.hypot(direction * pitch.HALF_LENGTH - p.x, p.y)
    if action == "shoot" and goal >= SHOOTING_RANGE:
        if m.phase == "play" and m.owner == p.id:
            return _on_the_ball(m, p)  # into range first, passing when pressed
        action = "dribble"
    if action == "shoot" and m.phase == "play" and m.owner == p.id and goal >= CLOSE_RANGE and not _pressed(m, p):
        return _on_the_ball(m, p)  # unpressed, it carries the ball closer first
    if m.phase in RESTARTS:
        taker = m.restart_team == p.team and p.id == _taker(m, p.team).id
        if taker and action not in KICKS:
            return _take_restart(m, p)  # the ball is not carried, and nobody else can play it
        if not taker and (wall := _wall_spot(m, p)):
            return _shape(m, p, wall)  # the wall lines up whatever the action
        elif not taker and action not in AT_A_RESTART:
            action = "hold"  # only the taker goes to the ball
    if on_the_ball and action in OFF_THE_BALL:
        return _on_the_ball(m, p)  # it has the ball: it keeps playing it
    if p.position == "GK" and action in ("press", "tackle", "slide_tackle", "jockey", "mark", "run_behind"):
        return bot_command(m, p)  # a keeper keeps its goal, coming for the ball as the bot does
    if m.phase == "play" and m.owner is None and action in AT_A_RESTART and _chase(m, p.team)[0] is p:
        return bot_command(m, p)  # keeping its place, it still collects a loose ball it reaches first
    teammate = not on_the_ball and m.owner is not None and m.player(m.owner).team == p.team
    if action == "sprint" and teammate:
        action = "support"  # a teammate has it
    if action == "jockey" and (m.owner is None or teammate):
        action = "hold"  # no opponent on the ball to back off from
    if action == "hold":
        if p.position == "GK":
            return MoveTo(*(_save_spot(m, p) or _goal_line_spot(m, p)), face=(m.ball.x, m.ball.y))
        return _shape(m, p, _home(m, p))
    if action == "support":
        if p.position == "GK":
            return MoveTo(*(_save_spot(m, p) or _goal_line_spot(m, p)), face=(m.ball.x, m.ball.y))
        return _shape(m, p, _home(m, p, attacking=True))
    if action == "mark":
        q = marking_target(m, p, defending)
        if q is None:
            return _shape(m, p, _home(m, p))
        goal_x = -direction * pitch.HALF_LENGTH
        dist = math.hypot(goal_x - q.x, q.y) or 1.0
        return MoveTo(q.x + (goal_x - q.x) / dist * 2, q.y - q.y / dist * 2, face=(m.ball.x, m.ball.y))
    if action == "run_behind":
        return _run_behind(m, p)
    if action == "dribble":
        return MoveTo(*_dribble_spot(m, p), DRIBBLE_SPEED)
    if action == "sprint" and on_the_ball:
        x, y = _dribble_spot(m, p)
        return KickTo(x, y, p.speed + KNOCK, touch="knock")
    if action == "take_on":
        return _take_on(m, p)
    if action == "shield":
        return _shield(m, p)
    if action == "pass":
        return _pass_or_clear(m, p)
    if action == "through_ball":
        spot = _through(m, p)
        return _pass_or_clear(m, p) if spot is None else KickTo(*spot, _ground_speed(m, spot))
    if action == "cross":
        return _cross(m, p)
    if action == "shoot":
        return KickTo(direction * pitch.HALF_LENGTH, _far_post(m, p), 24.0, 0.06)
    if action == "clear":
        return KickTo(p.x + direction * 40, p.y * 0.5, 26.0, 0.5)
    if action == "jockey":
        return _jockey(m, p)
    opponent = m.owner is not None and not teammate
    if action in ("tackle", "slide_tackle") and opponent:
        c = m.player(m.owner)
        # straight in, from any side
        return Tackle(m.ball.x + c.vx * 0.2, m.ball.y + c.vy * 0.2, slide=action == "slide_tackle")
    if action == "sprint" and m.owner is None:
        return MoveTo(*_run_on(m, p))  # on to its knock, flat out
    if action == "press" and opponent:
        return Tackle(*_press_spot(m, p), from_behind=False)
    return MoveTo(*_press_spot(m, p))  # at the ball: loose, a teammate's, or sprinting at an opponent's


def _without_ball(m: Match, p: Player, action: str) -> Command:
    """A late answer for the ball, carried out without it (docs/decisions.md, section 4):
    with the ball loose it runs at it; while another player has it, a kick is a kick at
    nothing and any other action a run to where it would have dribbled."""
    if m.owner is None:
        if p.position == "GK":
            return bot_command(m, p)  # a keeper keeps its goal
        return MoveTo(*_press_spot(m, p))
    if action in KICKS:
        return AirKick()
    return MoveTo(*_dribble_spot(m, p), DRIBBLE_SPEED)


def _jockey(m: Match, p: Player) -> MoveTo:
    """Back off facing the opponent on the ball, JOCKEY_DISTANCE from it towards its own
    goal."""
    c = m.player(m.owner)
    goal_x = -m.attack(p.team) * pitch.HALF_LENGTH
    dx, dy = goal_x - c.x, -c.y
    dist = math.hypot(dx, dy) or 1.0
    return MoveTo(c.x + dx / dist * JOCKEY_DISTANCE, c.y + dy / dist * JOCKEY_DISTANCE, face=(c.x, c.y))


def _run_on(m: Match, p: Player) -> tuple[float, float]:
    """Where a sprinting player runs for a loose ball running away from it: SPRINT_THROUGH
    beyond the ball along its path, so it keeps its speed instead of braking to arrive
    beside it. For any other loose ball, where a presser runs."""
    b = m.ball
    speed = math.hypot(b.vx, b.vy)
    if speed < 1 or b.vx * (b.x - p.x) + b.vy * (b.y - p.y) <= 0:
        return _press_spot(m, p)
    return b.x + b.vx / speed * SPRINT_THROUGH, b.y + b.vy / speed * SPRINT_THROUGH


def _ahead(m: Match, p: Player) -> Player | None:
    """The nearest opponent within 60° of straight upfield and within TAKE_ON_RANGE."""
    direction = m.attack(p.team)
    near = [
        (dist, q) for q in m.players
        if q.team != p.team and (dist := math.hypot(q.x - p.x, q.y - p.y)) < TAKE_ON_RANGE
        and (q.x - p.x) * direction > 0.5 * dist
    ]  # fmt: skip
    return min(near, key=lambda pair: pair[0])[1] if near else None


def _take_on(m: Match, p: Player) -> MoveTo:
    """Run at the nearest opponent ahead, then cut past it on the side with more room,
    keeping to the side it has started cutting to."""
    q = _ahead(m, p)
    if q is None:
        return MoveTo(*_dribble_spot(m, p), DRIBBLE_SPEED)
    dist = math.hypot(q.x - p.x, q.y - p.y)
    if dist > TAKE_ON_CUT:
        return MoveTo(q.x, q.y, DRIBBLE_SPEED)
    ux, uy = (q.x - p.x) / dist, (q.y - p.y) / dist
    leaning = ux * math.sin(p.heading) - uy * math.cos(p.heading)  # > 0: heading left of it
    best, best_score = None, -math.inf
    for side in (1.0, -1.0):
        x = q.x - uy * side * TAKE_ON_WIDE + ux * TAKE_ON_BEYOND
        y = q.y + ux * side * TAKE_ON_WIDE + uy * TAKE_ON_BEYOND
        if abs(y) > pitch.HALF_WIDTH - 1:
            continue
        room = min([10.0] + [math.hypot(o.x - x, o.y - y) for o in m.players if o.team != p.team and o is not q])
        score = room + (2.0 if leaning * side > 0 else 0.0)
        if score > best_score:
            best, best_score = (x, y), score
    return MoveTo(*(best or (q.x, q.y)), DRIBBLE_SPEED)


def _shield(m: Match, p: Player) -> Command:
    """Keep the ball with its back to the nearest opponent, edging away at walking pace,
    until a teammate within LAY_OFF is open to take it."""
    q = min((q for q in m.players if q.team != p.team), key=lambda q: math.hypot(q.x - p.x, q.y - p.y))
    dist = math.hypot(q.x - p.x, q.y - p.y)
    if dist >= SHIELD_RANGE:
        return _on_the_ball(m, p)
    mates = [
        r for r in m.players
        if r.team == p.team and r is not p and r.position != "GK"
        and math.hypot(r.x - p.x, r.y - p.y) < LAY_OFF and _space(m, r) >= PRESSURE
    ]  # fmt: skip
    if mates:
        return _pass_to(m, p, max(mates, key=lambda r: _space(m, r)))
    ux, uy = ((p.x - q.x) / dist, (p.y - q.y) / dist) if dist > 0 else (-m.attack(p.team), 0.0)
    x = max(-pitch.HALF_LENGTH + 1, min(pitch.HALF_LENGTH - 1, p.x + ux))
    y = max(-pitch.HALF_WIDTH + 1, min(pitch.HALF_WIDTH - 1, p.y + uy))
    return MoveTo(x, y, WALK, face=(p.x + ux * 10, p.y + uy * 10))


def _through(m: Match, p: Player) -> tuple[float, float] | None:
    """The spot for a through ball: into the space ahead of a teammate further forward,
    where it will be when the ball gets there, with room from every opponent; the one
    furthest forward with the most room. None if there is none."""
    direction = m.attack(p.team)
    b = m.ball
    best, best_score = None, -math.inf
    for q in m.players:
        if q.team != p.team or q is p or q.position == "GK" or (q.x - b.x) * direction < 3:
            continue
        dist = math.hypot(q.x - b.x, q.y - b.y)
        if dist > THROUGH_RANGE:
            continue
        travel = dist / _ground_speed(m, (q.x, q.y))
        x = q.x + q.vx * travel + direction * THROUGH_LEAD
        y = q.y + q.vy * travel
        x = max(-pitch.HALF_LENGTH + 3, min(pitch.HALF_LENGTH - 3, x))
        y = max(-pitch.HALF_WIDTH + 2, min(pitch.HALF_WIDTH - 2, y))
        room = min(math.hypot(o.x - x, o.y - y) for o in m.players if o.team != p.team)
        score = min(room, 8.0) + 0.2 * x * direction
        if room >= THROUGH_ROOM and score > best_score:
            best, best_score = (x, y), score
    return best


def _ground_speed(m: Match, spot: tuple[float, float]) -> float:
    """A ball played along the ground to `spot`, as hard as a pass that far."""
    dist = math.hypot(spot[0] - m.ball.x, spot[1] - m.ball.y)
    return min(24.0, math.sqrt(2 * ROLLING * dist) * 1.4 + 4)


def _wide(m: Match, p: Player) -> bool:
    """Whether the ball is wide in the final third of the pitch `p` attacks."""
    b = m.ball
    return abs(b.y) >= CROSS_WIDE and pitch.HALF_LENGTH - b.x * m.attack(p.team) <= CROSS_DEPTH


def _cross(m: Match, p: Player) -> Command:
    """Lift the ball into the penalty area: to the teammate there with the most room, or
    the penalty mark. From inside, it first carries the ball wide; at a restart it passes."""
    direction = m.attack(p.team)
    if not _wide(m, p):
        if m.phase in RESTARTS:
            return _pass_or_clear(m, p)
        side = 1.0 if p.y >= 0 else -1.0
        return MoveTo(p.x + direction * 6, side * (pitch.HALF_WIDTH - 5), DRIBBLE_SPEED)
    goal_x = direction * pitch.HALF_LENGTH
    in_area = [
        q for q in m.players
        if q.team == p.team and q is not p and q.position != "GK"
        and abs(goal_x - q.x) <= pitch.PENALTY_DEPTH and abs(q.y) <= pitch.PENALTY_HALF_WIDTH
    ]  # fmt: skip
    if in_area:
        q = max(in_area, key=lambda q: _space(m, q))
        x, y = q.x + q.vx, q.y + q.vy  # about where it will be when the ball comes down
    else:
        x, y = goal_x - direction * pitch.PENALTY_MARK, 0.0
    dist = math.hypot(x - m.ball.x, y - m.ball.y)
    land = max(5.0, dist - CROSS_SHORT)
    return KickTo(x, y, 6.0 + 0.41 * land, CROSS_LOFT)  # lands `land` m away (docs/decisions.md, section 4)


def _last_defender(m: Match, team: int) -> float:
    """How far up the pitch the opponents' second-last player stands, in `team`'s frame
    (towards the goal it attacks)."""
    direction = m.attack(team)
    xs = sorted((q.x * direction for q in m.players if q.team != team), reverse=True)
    return xs[1] if len(xs) > 1 else 0.0


def _offside_line(m: Match, team: int) -> float:
    """How far up the pitch a player of `team` can be without being in an offside
    position, in its frame: the second-last opponent, the ball or halfway."""
    return max(0.0, m.ball.x * m.attack(team), _last_defender(m, team))


def _run_behind(m: Match, p: Player) -> MoveTo:
    """From onside, with a teammate on the ball ready to pass (unpressed and facing
    upfield), sprint to RUN_BEYOND beyond the offside line, and carry on while still
    running. Otherwise keep its place in the team's shape, no further up than onside, so
    a runner that went beyond the line with no pass played checks back. A player further
    than RUN_REACH from the line keeps its place. A loose ball it can reach first, such
    as the through ball it ran for, it goes for, as `command` says."""
    direction = m.attack(p.team)
    line = _offside_line(m, p.team)
    ours = m.phase == "play" and m.owner is not None and m.player(m.owner).team == p.team
    hx, hy = _home(m, p, attacking=ours)
    x = p.x * direction
    if line - x > RUN_REACH:
        return _shape(m, p, (hx, hy))
    if ours:
        c = m.player(m.owner)
        ready = not _pressed(m, c) and math.cos(c.heading) * direction > DIAGONAL
        running = x > line + 0.5 and p.vx * direction > RUN_ON
        if running or (ready and x <= line + 0.5):
            y = max(-RUN_LANE, min(RUN_LANE, p.y))
            return MoveTo(direction * min(line + RUN_BEYOND, pitch.HALF_LENGTH - 6), y)
    return _shape(m, p, (direction * min(hx * direction, line - 1.0), hy))


def _far_post(m: Match, p: Player) -> float:
    """Aim inside the post further from the goalkeeper."""
    keeper = next(q for q in m.players if q.team != p.team and q.position == "GK")
    side = -1 if keeper.y > 0 else 1
    return side * (pitch.GOAL_WIDTH / 2 - 0.6)


def question(
    m: Match, p: Player, action: str, answer: float | None, instruction: str | None = None,
    defending: str = "zonal", current_actions: dict[int, str] | None = None,
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
    parts.append(f"Your base formation position: {_offset(p.home[0] - x, p.home[1] - y, 1)}. "
                 "Ahead means toward their goal; left/right are from your team's attacking direction.")
    parts.append(position_context(m, p))
    parts.append(f"Team defending: {defending.replace('_', '-')}.")
    if defending == "man_to_man" and p.position != "GK":
        target = marking_target(m, p, defending)
        if target:
            parts.append(f"Your marking assignment: opponent #{target.number}, "
                         f"{_offset(target.x - p.x, target.y - p.y, direction)}. "
                         "Mark tracks this opponent goal-side; recover cover if chasing would expose goal.")
    else:
        parts.append("Protect your formation area; cover behind a teammate pressing the ball.")
    teammates = [q for q in m.players if q.team == p.team and q.position != "GK"
                 and q.id not in m.down and q.id not in m.moves]
    if teammates:
        nearest = min(teammates, key=lambda q: (math.hypot(q.x - m.ball.x, q.y - m.ball.y), q.id))
        pressing = [f"#{q.number}" for q in teammates if q.id != p.id
                    and (current_actions or {}).get(q.id) in ("press", "tackle", "slide_tackle")
                    and (current_actions or {})[q.id] in options(m, q)]
        parts.append(f"Nearest outfield teammate to ball: #{nearest.number}"
                     f"{' (you)' if nearest.id == p.id else ''}, "
                     f"{math.hypot(nearest.x - m.ball.x, nearest.y - m.ball.y):.0f} m away. "
                     f"Other teammates pressing/challenging: {', '.join(pressing) or 'none'}.")
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
        )
        described = [
            f"{q.name} ({q.number}) {_offset(q.x - p.x, q.y - p.y, direction)}"
            + (" open" if label == "Teammates" and _space(m, q) >= PRESSURE else "")
            for q in others
        ]
        parts.append(f"{label}: {'; '.join(described)}.")
    if m.phase == "play" and p.position != "GK":
        line = _last_defender(m, p.team) - x
        parts.append(f"Their last defender {abs(line):.0f} m {'ahead' if line >= 0 else 'behind'}.")
    if instruction:
        parts.append(f"Manager: {instruction}")
    if answer is not None:
        parts.append(f"Your answers take {answer:.1f} s.")
    return Question(" ".join(parts), options(m, p), INSTRUCTIONS)


def position_context(m: Match, p: Player) -> str:
    direction = m.attack(p.team)
    hx, hy = _home(m, p)
    sx, sy = _home(m, p, attacking=True)
    x = p.x * direction
    third = "defensive" if x < -pitch.LENGTH / 6 else "attacking" if x > pitch.LENGTH / 6 else "middle"
    duty = {"GK": "Protect your goal.", "DF": "Keep defensive cover; do not follow every attack to their goal.",
            "MF": "Connect defence and attack while keeping space from teammates.",
            "FW": "Offer a forward outlet without crowding the ball carrier."}[p.position]
    return (f"Assigned role: {position_label(p)}; currently in the {third} third. {duty} "
            f"Recovery target (hold): {_offset(hx - p.x, hy - p.y, direction)}, "
            f"{math.hypot(hx - p.x, hy - p.y):.0f} m from your current position. "
            f"Support target: {_offset(sx - p.x, sy - p.y, direction)}.")


def marking_target(m: Match, p: Player, defending: str = "zonal") -> Player | None:
    opponents = [q for q in m.players if q.team != p.team and q.position != "GK"]
    if defending != "man_to_man":
        return min(opponents, key=lambda q: (math.hypot(q.x - p.x, q.y - p.y), q.id), default=None)
    direction = m.attack(p.team)
    ours = [q for q in m.players if q.team == p.team and q.position != "GK"]
    pairs = sorted((math.hypot(q.home[0] - r.x * direction, q.home[1] - r.y * direction), q.id, r.id)
                   for q in ours for r in opponents)
    assigned, taken = {}, set()
    for _, own, other in pairs:
        if own not in assigned and other not in taken:
            assigned[own] = other
            taken.add(other)
    return m.player(assigned[p.id]) if p.id in assigned else None


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

"""The decisions with tradeoffs and the freer movement of docs/decisions.md, sections 2 and 4:
what each action makes the player do, and the downside the engine plays out."""

import math
import pytest

from decision_pitch import actions, bots, pitch
from decision_pitch.match import KickTo, Match, MoveTo
from decision_pitch.physics import SIDE_SPEED, STEP, TOP_SPEED, Player, step_player


def in_play(ball=(0.0, 0.0)):
    """A match in open play, with every player lined up out of the way on one touchline."""
    m = Match()
    m.phase, m.restart_team = "play", None
    for i, p in enumerate(m.players):
        p.x, p.y, p.vx, p.vy = -50 + i * 4.7, -30.0, 0.0, 0.0
    m.ball.place(*ball)
    m.drain_events()
    return m


def on_the_ball(m, p, x=0.0, y=0.0):
    p.x, p.y, p.heading = x, y, 0.0  # home attacks towards +x in the first half
    m.ball.place(x + 0.6, y)
    m.owner = p.id
    return p


def play(m, seconds, actions_by_player):
    """Run the match with the given players carrying out their actions, the rest frozen."""
    events = []
    for _ in range(round(seconds / STEP)):
        for pid, action in actions_by_player.items():
            m.command(pid, actions.command(m, m.player(pid), action))
        m.step()
        events += [e["kind"] for e in m.drain_events()]
    return events


# -- movement -------------------------------------------------------------------------------------


def test_a_player_facing_the_ball_side_steps_a_short_way_and_turns_to_run_a_long_one():
    p = Player(1, 0, 1, "A", "MF", (0.0, 0.0))
    for _ in range(60):
        step_player(p, 0.0, 3.0, 2.0, face=(20.0, 0.0))  # 3 m to its left, slowly
    assert abs(p.heading) < 0.1 and p.y > 1.0  # still facing the ball, moving sideways
    q = Player(2, 0, 2, "B", "MF", (0.0, 0.0))
    for _ in range(60):
        step_player(q, 0.0, 30.0, TOP_SPEED, face=(20.0, 0.0))  # 30 m away, flat out
    assert q.heading > 1.2  # turned to run
    r = Player(3, 0, 3, "C", "MF", (0.0, 0.0))
    for _ in range(120):
        step_player(r, -1.5, 0.0, TOP_SPEED, face=(20.0, 0.0))  # a short way back
    assert abs(r.heading) < 0.1 and r.x < -1.0 and r.speed <= SIDE_SPEED  # backed off


def test_players_keeping_shape_walk_or_jog_by_how_far_their_place_is():
    m = in_play(ball=(10.0, 0.0))
    p = m.player(7)
    p.x, p.y = 0.0, 0.0
    assert bots._shape(m, p, (1.0, 0.0)).speed == bots.WALK
    assert bots._shape(m, p, (6.0, 0.0)).speed == 3.0
    assert bots._shape(m, p, (30.0, 0.0)).speed == bots.JOG
    m.owner = 18  # the other team has the ball: it hurries
    assert bots._shape(m, p, (6.0, 0.0)).speed == 5.0
    assert bots._shape(m, p, (6.0, 0.0)).face == (10.0, 0.0)  # watching the ball


def test_a_dribbler_cuts_away_from_a_defender_in_its_path():
    m = in_play()
    p = on_the_ball(m, m.player(7))
    m.player(18).x, m.player(18).y = 6.0, 0.0  # straight ahead
    x, y = bots._dribble_spot(m, p)
    assert x > p.x and abs(y) > 3  # diagonally, not at the defender


# -- what a model is asked ------------------------------------------------------------------------


def test_position_context_includes_role_location_and_relative_formation_in_both_directions():
    m = Match()
    p = m.player(7)
    p.home = (-10, 5)
    for period in (1, 2):
        m.period = period
        direction = m.attack(p.team)
        p.x, p.y = -5 * direction, 5 * direction
        text = actions.question(m, p, "hold", None).state
        assert "midfielder" in text and "You: 5 m into your half" in text
        assert "Your base formation position: 5 m behind" in text


def test_a_model_is_asked_only_the_actions_that_apply():
    m = in_play()
    p = on_the_ball(m, m.player(7))
    on = actions.options(m, p)
    assert "dribble" in on and "sprint" in on and "press" not in on
    assert "shoot" not in on and "cross" not in on and "shield" not in on  # far from goal, central, unpressed
    off = actions.options(m, m.player(8))
    assert tuple(off) == ("hold", "support", "mark")  # a teammate has it; too far back to run in behind
    assert tuple(actions.options(m, m.player(1))) == actions.KEEPER_OFF_THE_BALL
    m._restart("corner", 0, 52.5, 34.0)
    taker = bots._taker(m, 0)
    assert "cross" in actions.options(m, taker) and "dribble" not in actions.options(m, taker)
    others = next(q for q in m.players if q.team == 0 and q is not taker and q.position != "GK")
    assert set(actions.options(m, others)) <= set(actions.AT_A_RESTART)


def test_challenges_are_asked_while_an_opponent_has_the_ball():
    m = in_play()
    on_the_ball(m, m.player(18))
    near, far = m.player(8), m.player(9)
    near.x, near.y, far.x, far.y = 5.0, 5.0, 20.0, 5.0
    assert {"press", "tackle", "slide_tackle", "jockey"} <= set(actions.options(m, near))
    assert "tackle" in actions.options(m, far) and "slide_tackle" not in actions.options(m, far)
    m.owner = None  # loose: it can be pressed for, not tackled
    assert "press" in actions.options(m, near) and "tackle" not in actions.options(m, near)


def test_the_state_tells_how_far_the_last_defender_is():
    m = in_play()
    p = m.player(10)
    p.x, p.y = 20.0, 0.0
    for q, x in zip((q for q in m.players if q.team == 1), (40, 30, 28, 27, 26, 25, 24, 23, 22, 21, 50)):
        q.x = x
    assert "Their last defender 20 m ahead." in actions.question(m, p, "hold", None).state


# -- each action and its downside -----------------------------------------------------------------


def test_a_sprint_knocks_the_ball_ahead_and_leaves_it_loose_for_an_opponent():
    m = in_play()
    p = on_the_ball(m, m.player(7))
    p.vx = 6.0
    knock = actions.command(m, p, "sprint")
    assert isinstance(knock, KickTo) and knock.touch == "knock" and knock.speed == 6.0 + actions.KNOCK
    m.command(p.id, knock)
    m.step()
    assert m.owner is None and m.touches[-1]["kind"] == "knock"  # loose until it gets there
    chase = actions.command(m, p, "sprint")
    assert isinstance(chase, MoveTo) and chase.speed == TOP_SPEED
    opponent = m.player(18)
    opponent.x, opponent.y = m.ball.x + 2.0, 0.6  # close to where the ball rolls
    play(m, 1.0, {p.id: "sprint", opponent.id: "press"})
    assert any(t["player"] == opponent.id for t in m.touches)  # it took the ball


def test_a_sprint_covers_more_ground_than_a_dribble():
    gained = {}
    for action in ("sprint", "dribble"):
        m = in_play()
        p = on_the_ball(m, m.player(7), x=-40.0)
        play(m, 5.0, {p.id: action})
        gained[action] = p.x + 40.0
    assert gained["sprint"] > gained["dribble"] + 3


def test_a_take_on_runs_at_the_defender_then_cuts_past_it_and_can_lose_the_ball():
    m = in_play()
    p = on_the_ball(m, m.player(7))
    defender = m.player(18)
    defender.x, defender.y = 8.0, 0.0
    assert actions.command(m, p, "take_on") == MoveTo(8.0, 0.0, bots.DRIBBLE_SPEED)  # at it
    defender.x = 4.0
    cut = actions.command(m, p, "take_on")
    assert cut.x > defender.x and abs(cut.y) == actions.TAKE_ON_WIDE  # beside it and beyond
    defender.x, defender.y = 3.0, 0.0
    play(m, 1.0, {p.id: "take_on", defender.id: "press"})
    assert any(t["player"] == defender.id for t in m.touches)  # it got to the ball first


def test_a_shield_turns_its_back_on_the_opponent_slowly_and_lays_the_ball_off():
    m = in_play()
    p = on_the_ball(m, m.player(7))
    opponent = m.player(18)
    opponent.x, opponent.y = -2.0, 0.0  # behind it
    shield = actions.command(m, p, "shield")
    assert shield.speed == bots.WALK and shield.face[0] > p.x  # back to the opponent, slow
    mate = m.player(8)
    mate.x, mate.y = 8.0, 6.0  # free, close by
    assert isinstance(actions.command(m, p, "shield"), KickTo)


def test_a_through_ball_goes_ahead_of_a_runner_who_can_be_offside():
    m = in_play()
    p = on_the_ball(m, m.player(7))
    runner = m.player(10)
    runner.x, runner.y, runner.vx = 20.0, 5.0, 7.0
    for q, x in zip((q for q in m.players if q.team == 1), (50, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6)):
        q.x, q.y = x, -20.0  # the keeper deep, the rest 5 m or more behind the runner
    through = actions.command(m, p, "through_ball")
    assert isinstance(through, KickTo) and through.x > runner.x + actions.THROUGH_LEAD
    assert "offside" in play(m, 3.0, {p.id: "through_ball", runner.id: "run_behind"})


def test_a_run_in_behind_goes_from_onside_when_the_ball_can_be_played():
    m = in_play()
    runner = m.player(10)
    runner.x, runner.y = 30.0, 5.0
    line = actions._offside_line(m, 0)
    home = bots._home(m, runner)
    assert "run_behind" in actions.options(m, runner)
    waiting = actions.command(m, runner, "run_behind")
    assert waiting == bots._shape(m, runner, (min(home[0], line - 1.0), home[1]))  # its place, onside
    on_the_ball(m, m.player(7))  # facing upfield, unpressed
    run = actions.command(m, runner, "run_behind")
    assert run == MoveTo(min(line + actions.RUN_BEYOND, pitch.HALF_LENGTH - 6), 5.0)
    runner.x = 0.0  # too far from the line to run in behind: it keeps its place
    assert "run_behind" not in actions.options(m, runner)
    assert actions.command(m, runner, "run_behind") == bots._shape(m, runner, bots._home(m, runner, attacking=True))


def test_a_tackle_goes_straight_in_and_from_behind_is_a_foul():
    m = in_play()
    carrier = m.player(18)
    carrier.x, carrier.y, carrier.heading, carrier.vx = 0.0, 0.0, math.pi, -3.0  # away, towards -x
    m.ball.place(-0.6, 0.0)
    m.owner = carrier.id
    tackler = m.player(7)
    tackler.x, tackler.y, tackler.heading = 3.0, 0.3, math.pi  # behind it, facing it
    tackle = actions.command(m, tackler, "tackle")
    assert tackle.speed == TOP_SPEED and tackle.x < carrier.x  # straight at the ball, through it
    assert actions.command(m, tackler, "press") != tackle  # pressing comes round instead
    assert "foul" in play(m, 1.5, {tackler.id: "tackle"})


def test_a_cross_lifts_the_ball_into_the_area_from_wide_and_goes_wide_first():
    m = in_play()
    p = on_the_ball(m, m.player(6), x=40.0, y=25.0)
    cross = actions.command(m, p, "cross")
    assert isinstance(cross, KickTo) and cross.loft == actions.CROSS_LOFT
    assert abs(cross.x - (pitch.HALF_LENGTH - pitch.PENALTY_MARK)) < 0.01 and cross.y == 0.0  # the penalty mark
    p = on_the_ball(m, m.player(6), x=10.0, y=5.0)
    wide = actions.command(m, p, "cross")
    assert isinstance(wide, MoveTo) and wide.y > 25  # towards the touchline first


def test_a_player_keeping_its_place_still_collects_a_loose_ball_it_reaches_first():
    m = in_play(ball=(5.0, 0.0))
    p = m.player(7)
    p.x, p.y = 3.0, 0.0  # the nearest by far
    for action in ("hold", "support", "mark", "run_behind"):
        assert actions.command(m, p, action) == bots.command(m, p)
    m.owner = 18  # an opponent has it: pressing stays a choice
    assert actions.command(m, p, "hold") == bots._shape(m, p, bots._home(m, p))


def test_tactical_context_and_unique_marking_follow_both_teams_and_halves():
    m = in_play(ball=(25, 10))
    for period in (1, 2):
        m.period = period
        for team in (0, 1):
            ours = [p for p in m.players if p.team == team and p.position != 'GK']
            targets = [actions.marking_target(m, p, 'man_to_man') for p in ours]
            assert len({q.id for q in targets}) == len(ours)
            p, target = ours[0], targets[0]
            text = actions.question(m, p, 'hold', None, defending='man_to_man',
                                    current_actions={ours[1].id: 'press'}).state
            assert 'Assigned role: Right back' in text and 'Recovery target (hold)' in text
            assert f'Your marking assignment: opponent #{target.number}' in text
            assert f'Other teammates pressing/challenging: #{ours[1].number}' in text
            move = actions.command(m, p, 'mark', 'man_to_man')
            assert math.hypot(move.x - target.x, move.y - target.y) == pytest.approx(2)
            assert (move.x - target.x) * m.attack(team) < 0


def test_wait_stops_with_possession_and_recovers_shape_if_ball_is_lost():
    m = in_play()
    p = on_the_ball(m, m.player(7))
    assert 'wait' in actions.options(m, p)
    for _ in range(60):
        m.command(p.id, actions.command(m, p, 'wait'))
        m.step()
    assert m.owner == p.id and p.speed == 0
    assert abs(p.x) < 0.01 and abs(p.y) < 0.01
    m.owner = 18
    assert 'wait' not in actions.options(m, p)
    assert actions.command(m, p, 'wait') == bots._shape(m, p, bots._home(m, p))

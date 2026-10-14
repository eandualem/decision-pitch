import math

import pytest

from decision_pitch import bots, pitch
from decision_pitch.bots import _wall_spot
from decision_pitch.match import DRIBBLE, OUT_OF_PLACE, RETREAT_WAIT, SET_PIECE_WAIT, Hold, KickTo, Match, MoveTo
from decision_pitch.physics import STEP, TOP_SPEED


def in_play():
    """A match in open play, with every player lined up out of the way on one touchline.
    The home team (players 1-11) attacks towards +x."""
    m = Match()
    m.phase, m.restart_team, m.last_touch = "play", None, 0
    for i, p in enumerate(m.players):
        p.x, p.y, p.vx, p.vy = -50 + i * 4.7, -30.0, 0.0, 0.0
    m.drain_events()
    return m


def run(m, seconds):
    for _ in range(round(seconds / STEP)):
        m.step()


def on_the_ball(m, pid, x, y):
    """Player `pid` with the ball at its feet at (x, y), facing towards +x."""
    p = m.player(pid)
    p.x, p.y, p.heading = x, y, 0.0
    m.ball.place(x + DRIBBLE, y)
    m.owner = pid
    m.command(pid, Hold())
    return p


def challenge(m, pid, x, y, vx, vy):
    """Player `pid` at (x, y), running at (vx, vy) m/s."""
    q = m.player(pid)
    q.x, q.y, q.vx, q.vy, q.heading = x, y, vx, vy, math.atan2(vy, vx)
    m.command(pid, MoveTo(x + vx * 10, y + vy * 10))
    return q


def kinds(events):
    return [e["kind"] for e in events]


def on_pitch(m):
    return {p.id for p in m.players}


# -- fouls and free kicks ---------------------------------------------------------------------


def test_running_into_the_ball_carrier_from_behind_is_a_foul_and_a_free_kick():
    m = in_play()
    on_the_ball(m, 10, 0.0, 0.0)
    challenge(m, 15, -0.7, 0.0, 5.0, 0.0)
    m.step()
    events = m.drain_events()
    assert kinds(events) == ["foul", "free_kick"]
    assert (events[0]["team"], events[0]["player"], events[0]["fouled"]) == (0, 15, 10)
    assert (m.phase, m.restart_team) == ("free_kick", 0)
    assert (m.ball.x, m.ball.y) == (0.0, 0.0)  # where the fouled player was


def test_running_into_the_carrier_from_the_side_without_reaching_the_ball_is_a_foul():
    m = in_play()
    on_the_ball(m, 10, 0.0, 0.0)
    challenge(m, 15, 0.0, 0.75, 0.0, -5.0)
    m.step()
    assert kinds(m.drain_events()) == ["foul", "free_kick"]


def test_a_challenge_that_reaches_the_ball_from_the_front_wins_it_fairly():
    m = in_play()
    on_the_ball(m, 10, 0.0, 0.0)
    challenge(m, 15, 0.75, 0.0, -5.0, 0.0)
    m.step()
    assert m.drain_events() == [] and m.phase == "play" and m.owner == 15


def test_a_slow_contact_is_not_a_foul():
    m = in_play()
    on_the_ball(m, 10, 0.0, 0.0)
    challenge(m, 15, -0.7, 0.0, 1.0, 0.0)
    m.step()
    assert m.drain_events() == [] and m.phase == "play"


@pytest.mark.parametrize("speed, running", [(2.0, 6.0), (0.0, 0.0)])
def test_a_presser_behind_the_carrier_runs_round_it_and_wins_the_ball_fairly(speed, running):
    m = in_play()
    carrier = on_the_ball(m, 10, -20.0, 0.0)
    carrier.vx = speed
    challenge(m, 15, -24.0, 0.2, running, 0.0)
    for _ in range(round(4 / STEP)):
        m.command(10, MoveTo(pitch.HALF_LENGTH, 0.0, speed) if speed else Hold())
        m.command(15, MoveTo(*bots._press_spot(m, m.player(15))))
        m.step()
        if m.owner != 10:
            break
    assert m.drain_events() == [] and m.owner == 15


def test_a_presser_meets_a_ball_coming_at_it_as_fast_as_it_runs():
    # 4 m apart, closing at twice its speed
    assert bots._intercept(-4.0, 0.0, TOP_SPEED, 0.0, TOP_SPEED) == pytest.approx(4 / (2 * TOP_SPEED))


def test_a_free_kick_waits_before_it_can_be_taken():
    m = in_play()
    on_the_ball(m, 10, 0.0, 0.0)
    challenge(m, 15, -0.7, 0.0, 5.0, 0.0)
    m.step()
    m.player(15).x = -30.0  # out of the way, so only the wait holds the kick
    m.command(10, KickTo(20.0, 0.0, 15.0))
    run(m, SET_PIECE_WAIT - 0.1)
    assert m.phase == "free_kick"
    run(m, 0.2)
    assert m.phase == "play" and m.ball.vx > 0


def test_the_offender_runs_back_from_a_free_kick_and_the_kick_waits_for_it():
    m = in_play()
    on_the_ball(m, 10, 0.0, 0.0)
    offender = challenge(m, 15, -0.7, 0.0, 5.0, 0.0)
    m.step()
    assert m.phase == "free_kick"
    m.command(10, KickTo(20.0, 0.0, 15.0))
    m.command(15, MoveTo(m.ball.x, m.ball.y))  # told to stay at the ball
    while m.phase == "free_kick":
        x, y = offender.x, offender.y
        m.step()
        assert math.hypot(offender.x - x, offender.y - y) <= TOP_SPEED * STEP + OUT_OF_PLACE  # no jump
        if m.phase == "free_kick":
            assert m.since_restart < RETREAT_WAIT
    assert math.hypot(offender.x - m.ball.x, offender.y - m.ball.y) >= 9.15 - 0.5  # kicked as it got there
    assert m.since_restart > SET_PIECE_WAIT


def test_a_free_kick_near_goal_gets_a_wall_of_three_beyond_the_required_distance():
    m = in_play()
    on_the_ball(m, 10, 25.0, 0.0)
    challenge(m, 15, 24.3, 0.0, 5.0, 0.0)
    m.step()
    assert m.phase == "free_kick"
    spots = {p.id: _wall_spot(m, p) for p in m.players}
    wall = {pid: spot for pid, spot in spots.items() if spot is not None}
    assert len(wall) == 3 and all(m.player(pid).team == 1 for pid in wall)
    for x, y in wall.values():
        assert math.hypot(x - m.ball.x, y - m.ball.y) >= 9.15
        assert x > m.ball.x  # between the ball and the goal it defends
    m.ball.place(-20.0, 0.0)  # far from goal: no wall
    assert all(_wall_spot(m, p) is None for p in m.players)


def test_a_foul_in_the_penalty_area_is_a_penalty_taken_by_the_fouled_player():
    m = in_play()
    on_the_ball(m, 10, 45.0, 5.0)
    challenge(m, 15, 44.3, 5.0, 5.0, 0.0)
    m.step()
    penalty = m.drain_events()[-1]
    assert (penalty["kind"], penalty["team"], penalty["player"]) == ("penalty", 0, 10)
    assert (m.ball.x, m.ball.y) == (pitch.HALF_LENGTH - pitch.PENALTY_MARK, 0.0)
    run(m, 1.0)
    for p in m.players:
        if p.id == 10:
            continue
        if p.id == 12:  # the defending goalkeeper, on its goal line
            assert p.x == pytest.approx(pitch.HALF_LENGTH, abs=0.5)
            assert abs(p.y) <= pitch.GOAL_WIDTH / 2
            continue
        in_area = p.x >= pitch.HALF_LENGTH - pitch.PENALTY_DEPTH and abs(p.y) <= pitch.PENALTY_HALF_WIDTH
        assert not in_area
        assert math.hypot(p.x - m.ball.x, p.y - m.ball.y) >= 9.15 - 1e-9


def test_players_beside_the_penalty_area_wait_behind_the_mark():
    m = in_play()
    on_the_ball(m, 10, 45.0, 5.0)
    challenge(m, 15, 44.3, 5.0, 5.0, 0.0)
    m.step()
    beside = m.player(9)
    beside.x, beside.y = 50.0, 25.0
    m.command(9, Hold())
    m.step()
    assert beside.x <= m.ball.x


def test_a_half_waits_for_a_penalty_awarded_at_its_end():
    m = in_play()
    m.elapsed = m.half_length - STEP / 2  # this is the half's last step
    on_the_ball(m, 10, 45.0, 5.0)
    challenge(m, 15, 44.3, 5.0, 5.0, 0.0)
    m.command(10, KickTo(pitch.HALF_LENGTH + 2, 2.0, 24.0))
    m.step()
    assert m.phase == "penalty"
    run(m, 5.0)
    events = kinds(m.drain_events())
    assert events[-1] == "half_time" and events[-2] in ("goal", "goal_kick", "corner")


def penalty_after_time(ball, velocity):
    """A penalty kick on its way after the half's time is up."""
    m = in_play()
    m.elapsed, m.penalty_live = m.half_length, True
    m.ball.place(*ball)
    m.ball.vx = velocity
    return m


def test_a_slow_penalty_ball_is_followed_until_it_stops():
    m = penalty_after_time((52.55, 0.0), 0.45)
    run(m, 1.0)
    assert kinds(m.drain_events()) == ["goal", "half_time"]


def test_a_touch_after_time_ends_the_half_before_that_player_can_score():
    m = penalty_after_time((52.3, 2.0), 1.0)
    m.player(10).x, m.player(10).y = 51.9, 2.0
    m.command(10, KickTo(pitch.HALF_LENGTH + 2, 2.0, 24.0))
    m.step()
    assert kinds(m.drain_events()) == ["half_time"] and m.score == [0, 0]


def test_the_bot_shoots_a_penalty():
    m = in_play()
    on_the_ball(m, 10, 45.0, 5.0)
    challenge(m, 15, 44.3, 5.0, 5.0, 0.0)
    m.step()
    for _ in range(round(10 / STEP)):
        if m.phase != "penalty":
            break
        bots.play(m)
        m.step()
    assert m.phase == "play" and 10 in m.recovering and m.ball.vx > 10


# -- cards ------------------------------------------------------------------------------------


def test_a_foul_that_stops_a_promising_attack_is_a_yellow_card():
    m = in_play()
    on_the_ball(m, 10, 30.0, 0.0)
    challenge(m, 15, 29.3, 0.0, 5.0, 0.0)
    m.step()
    events = m.drain_events()
    assert kinds(events) == ["foul", "yellow", "free_kick"]
    assert (events[1]["team"], events[1]["player"]) == (1, 15)
    assert 15 in on_pitch(m)


def test_a_second_yellow_card_is_a_red_and_the_player_leaves_the_pitch():
    m = in_play()
    m.yellows[15] = 1
    on_the_ball(m, 10, 30.0, 0.0)
    challenge(m, 15, 29.3, 0.0, 5.0, 0.0)
    m.step()
    assert kinds(m.drain_events()) == ["foul", "yellow", "red", "free_kick"]
    assert 15 not in on_pitch(m)
    assert 15 not in {p["id"] for p in m.snapshot()["players"]}


def test_a_foul_that_denies_an_obvious_goal_scoring_chance_is_a_red_card():
    m = in_play()
    for p in m.players:
        if p.team == 1 and p.position != "GK":
            p.x = min(p.x, 20.0)  # no outfield defender between the carrier and the goal
    on_the_ball(m, 10, 33.0, 0.0)
    challenge(m, 15, 32.3, 0.0, 5.0, 0.0)
    m.step()
    assert kinds(m.drain_events()) == ["foul", "red", "free_kick"]
    assert 15 not in on_pitch(m)


def test_a_sent_off_goalkeeper_is_replaced_in_goal_by_the_teammate_nearest_it():
    m = in_play()
    m._card(m.player(12), red=True)
    keepers = [p for p in m.players if p.team == 1 and p.position == "GK"]
    assert [p.id for p in keepers] == [22]  # Ridge defends +x; 22 is nearest that goal


def test_a_team_reduced_below_seven_players_ends_the_match():
    m = in_play()
    for pid in (13, 14, 15, 16):
        m._card(m.player(pid), red=True)
    assert m.phase == "play"
    m._card(m.player(17), red=True)
    assert m.phase == "full_time" and m.drain_events()[-1]["kind"] == "full_time"


# -- offside ----------------------------------------------------------------------------------


def through_ball(receiver, line=20.0, ball=0.0):
    """Player 7 passes from `ball` with the second-last opponent at `line`, while player 10
    stands at `receiver`. Returns the match once the ball is played."""
    m = in_play()
    for p in m.players:
        if p.team == 1:
            p.x, p.y = ball - 5, -30.0
    m.player(12).x, m.player(12).y = 50.0, 0.0
    m.player(13).x, m.player(13).y = line, 10.0
    m.player(10).x, m.player(10).y = receiver
    m.player(7).x, m.player(7).y = ball - 0.6, 0.0
    m.ball.place(ball, 0.0)
    m.command(7, KickTo(receiver[0], receiver[1], 20.0))
    m.step()
    assert m.owner is None and m.ball.vx > 0  # played
    return m


def test_a_player_beyond_the_second_last_opponent_when_the_ball_is_played_is_offside():
    m = through_ball((30.0, 10.0))
    assert m.offside == {10}
    receiver = m.player(10)
    m.ball.place(receiver.x + 0.3, receiver.y)  # it reaches the ball first
    m.step()
    events = m.drain_events()
    assert kinds(events) == ["offside", "free_kick"]
    assert (events[0]["team"], events[0]["player"]) == (1, 10)
    assert (events[1]["team"], events[1]["indirect"]) == (1, True)
    assert (m.ball.x, m.ball.y) == pytest.approx((receiver.x, receiver.y))


@pytest.mark.parametrize(
    "receiver, line, ball",
    [((20.0, 10.0), 20.0, 0.0), ((-5.0, 10.0), -10.0, -20.0)],
    ids=["level", "own half"],
)
def test_a_player_level_with_the_second_last_opponent_or_in_its_own_half_is_onside(receiver, line, ball):
    assert through_ball(receiver, line, ball).offside == set()


def test_an_onside_teammate_reaching_the_ball_first_ends_the_offside():
    m = through_ball((30.0, 10.0))
    onside = m.player(9)
    onside.x, onside.y = 15.0, 5.0
    m.ball.place(onside.x + 0.3, onside.y)
    m.step()
    assert m.owner == 9 and m.offside == set()
    receiver = m.player(10)
    m.ball.place(receiver.x + 0.3, receiver.y)
    m.step()
    assert m.drain_events() == [] and m.owner == 10


def test_no_one_is_offside_from_a_throw_in():
    m = in_play()
    m.phase, m.restart_team = "throw_in", 0
    m.player(10).x, m.player(10).y = 45.0, 0.0
    m.player(7).x, m.player(7).y = 10.0, -pitch.HALF_WIDTH - 0.6
    m.ball.place(10.0, -pitch.HALF_WIDTH)
    m.command(7, KickTo(45.0, 0.0, 15.0))
    m.step()
    assert m.phase == "play" and m.offside == set()


@pytest.mark.parametrize("indirect, restart, score", [(True, "goal_kick", [0, 0]), (False, "goal", [1, 0])])
def test_a_goal_cannot_be_scored_directly_from_an_indirect_free_kick(indirect, restart, score):
    m = in_play()
    m.phase, m.restart_team, m.restart_indirect = "free_kick", 0, indirect
    m.ball.place(40.0, 0.0)
    m.player(10).x, m.player(10).y = 39.4, 0.0
    m.command(10, KickTo(pitch.HALF_LENGTH + 2, 0.0, 20.0))
    run(m, 3.0)
    assert kinds(m.drain_events()) == [restart] and m.score == score


# -- substitutions ----------------------------------------------------------------------------


def stop(m):
    """Stop play for a throw-in."""
    m._restart("throw_in", 0, 0.0, -pitch.HALF_WIDTH)
    m.drain_events()


def test_each_team_has_a_bench_of_seven():
    teams = Match().hello_teams()
    assert [p["id"] for p in teams[0]["bench"]] == list(range(23, 30))
    assert [p["id"] for p in teams[1]["bench"]] == list(range(30, 37))
    assert [p["number"] for p in teams[0]["bench"]] == list(range(12, 19))


def test_a_substitution_is_made_at_the_next_stoppage_in_the_outgoing_players_place():
    m = in_play()
    off = m.player(10)
    assert m.substitute(10, 29) is None
    m.step()
    assert 10 in on_pitch(m) and m.drain_events() == []
    stop(m)
    where = (off.x, off.y)
    m.step()
    assert 29 in on_pitch(m) and 10 not in on_pitch(m)
    [event] = m.drain_events()
    assert (event["kind"], event["team"], event["off"], event["on"]) == ("substitution", 0, 10, 29)
    on = m.player(29)
    assert (on.x, on.y) == where and (on.position, on.home) == (off.position, off.home)
    assert m.substitute(10, 28) == "that player is not on the pitch"  # it cannot return


def test_a_team_makes_at_most_five_substitutions():
    m = in_play()
    stop(m)
    for off, on in zip(range(2, 7), range(23, 28), strict=True):
        assert m.substitute(off, on) is None
    assert m.substitute(7, 28) == "all 5 substitutions are used"
    m.step()
    assert m.substitutions == [5, 0] and m.windows == [1, 0]
    assert m.substitute(7, 28) == "all 5 substitutions are used"


def test_substitutions_are_made_in_at_most_three_stoppages_besides_half_time():
    m = in_play()
    for off, on in ((2, 23), (3, 24), (4, 25)):
        stop(m)
        assert m.substitute(off, on) is None
        m.step()
    assert m.windows[0] == 3
    assert m.substitute(5, 26) is None  # in the same stoppage as the third
    m.step()
    m.phase = "play"
    assert m.substitute(6, 27) == "all 3 stoppages for substitutions are used"
    m.phase, m.since_restart = "half_time", 0.0
    assert m.substitute(6, 27) is None
    m.step()
    assert m.substitutions[0] == 5 and m.windows[0] == 3


def test_a_sent_off_player_cannot_be_replaced():
    m = in_play()
    assert m.substitute(15, 30) is None
    m._card(m.player(15), red=True)
    assert m.pending == []
    assert m.substitute(15, 30) == "that player is not on the pitch"

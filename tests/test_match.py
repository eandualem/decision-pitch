import math

import pytest

from decision_pitch import bots, pitch
from decision_pitch.match import HALF_TIME, THROW_MAX, Hold, KickTo, Match, MoveTo
from decision_pitch.physics import BALL_RADIUS, STEP


def in_play(ball=(0.0, 0.0), velocity=(0.0, 0.0, 0.0), last_touch=0):
    """A match in open play, with every player lined up out of the way on one touchline."""
    m = Match()
    m.phase, m.restart_team, m.last_touch = "play", None, last_touch
    for i, p in enumerate(m.players):
        p.x, p.y, p.vx, p.vy = -50 + i * 4.7, -30.0, 0.0, 0.0
    m.ball.place(*ball)
    m.ball.vx, m.ball.vy, m.ball.vz = velocity
    m.drain_events()
    return m


def run(m, seconds):
    for _ in range(round(seconds / STEP)):
        m.step()


def test_the_match_kicks_off_with_each_team_in_its_own_half():
    m = Match()
    assert (m.phase, m.restart_team, m.period) == ("kickoff", 0, 1)
    assert (m.ball.x, m.ball.y) == (0, 0)
    for p in m.players:
        assert p.x * m.attack(p.team) <= 0
        if p.team == 1:
            assert math.hypot(p.x, p.y) >= pitch.CENTRE_RADIUS


def test_the_kick_off_puts_the_ball_in_play():
    m = Match()
    taker = min((p for p in m.players if p.team == 0), key=lambda p: math.hypot(p.x, p.y))
    m.command(taker.id, KickTo(-20.0, 0.0, 10.0))
    run(m, 1)
    assert m.phase == "play" and m.ball.x < -1


def test_a_ball_between_the_posts_under_the_bar_is_a_goal():
    m = in_play(ball=(pitch.HALF_LENGTH - 1, 0.0), velocity=(10.0, 0.0, 0.0))
    run(m, 0.5)
    assert m.score == [1, 0]
    assert [e["kind"] for e in m.drain_events()] == ["goal"]
    assert (m.phase, m.restart_team) == ("kickoff", 1)
    assert (m.ball.x, m.ball.y) == (0, 0)


def test_a_ball_over_the_bar_is_not_a_goal():
    m = in_play(ball=(pitch.HALF_LENGTH - 1, 0.0), velocity=(10.0, 0.0, 0.0))
    m.ball.z, m.ball.vz = 3.5, 1.0
    run(m, 0.5)
    assert m.score == [0, 0] and m.phase == "goal_kick"


def test_over_the_touchline_is_a_throw_in_to_the_other_team_where_it_crossed():
    m = in_play(ball=(10.0, pitch.HALF_WIDTH - 1), velocity=(0.0, 8.0, 0.0), last_touch=0)
    run(m, 0.5)
    assert (m.phase, m.restart_team) == ("throw_in", 1)
    assert m.ball.y == pitch.HALF_WIDTH and m.ball.x == pytest.approx(10.0)


def test_over_the_goal_line_off_an_attacker_is_a_goal_kick():
    m = in_play(ball=(pitch.HALF_LENGTH - 1, 15.0), velocity=(10.0, 0.0, 0.0), last_touch=0)
    run(m, 0.5)
    assert (m.phase, m.restart_team) == ("goal_kick", 1)
    assert m.ball.x == pitch.HALF_LENGTH - pitch.GOAL_AREA_DEPTH


def test_over_the_goal_line_off_a_defender_is_a_corner():
    m = in_play(ball=(pitch.HALF_LENGTH - 1, 15.0), velocity=(10.0, 0.0, 0.0), last_touch=1)
    run(m, 0.5)
    assert (m.phase, m.restart_team) == ("corner", 0)
    assert (m.ball.x, m.ball.y) == (pitch.HALF_LENGTH, pitch.HALF_WIDTH)


def test_opponents_keep_their_distance_at_a_corner():
    m = in_play(ball=(pitch.HALF_LENGTH - 1, 15.0), velocity=(10.0, 0.0, 0.0), last_touch=1)
    run(m, 0.5)
    defender = next(p for p in m.players if p.team == 1)
    defender.x, defender.y = pitch.HALF_LENGTH - 2, pitch.HALF_WIDTH - 2
    m.command(defender.id, MoveTo(m.ball.x, m.ball.y))
    run(m, 1)
    assert math.hypot(defender.x - m.ball.x, defender.y - m.ball.y) >= 9.15 - 1e-9
    assert m.phase == "corner"


def test_only_the_restarting_team_may_play_the_ball_and_its_kick_restarts_play():
    m = in_play(ball=(10.0, pitch.HALF_WIDTH - 1), velocity=(0.0, 8.0, 0.0), last_touch=0)
    run(m, 0.5)
    thrower = next(p for p in m.players if p.team == 1)
    thrower.x, thrower.y = m.ball.x, m.ball.y - 0.5
    m.command(thrower.id, KickTo(10.0, 10.0, 25.0))
    run(m, STEP)
    assert m.phase == "play" and m.last_touch == 1
    speed = math.sqrt(m.ball.vx**2 + m.ball.vy**2 + m.ball.vz**2)
    assert speed <= THROW_MAX + 1e-9


def test_a_player_carries_the_ball_it_controls():
    m = in_play(ball=(0.0, 0.0))
    p = m.players[5]
    p.x, p.y = -0.5, 0.0
    m.command(p.id, MoveTo(30.0, 0.0))
    run(m, 2)
    assert m.owner == p.id and m.ball.x > 5 and m.ball.z == BALL_RADIUS


def test_ends_change_at_half_time_and_the_other_team_kicks_off():
    m = Match(half_length=1.0)
    run(m, 1.0 + STEP)
    assert m.phase == "half_time"
    run(m, HALF_TIME)
    assert (m.period, m.phase, m.restart_team) == (2, "kickoff", 1)
    assert m.attack(0) == -1
    assert all(p.x * m.attack(p.team) <= 0 for p in m.players)


def test_the_match_ends_after_the_second_half():
    m = Match(half_length=1.0)
    run(m, 2.0 + HALF_TIME + 3 * STEP)
    assert m.phase == "full_time"
    assert [e["kind"] for e in m.drain_events()][-2:] == ["half_time", "full_time"]
    before = m.t
    m.step()
    assert m.t == before


def test_bots_play_a_whole_match():
    m = Match(half_length=40.0, seed=3)
    touched = set()
    while m.phase != "full_time":
        bots.play(m)
        m.step()
        if m.owner:
            touched.add(m.player(m.owner).team)
    assert touched == {0, 1}
    assert m.period == 2


def test_a_pass_is_met_by_its_receiver_not_chased_by_its_passer():
    m = in_play(ball=(0.5, 0.0), velocity=(12.0, 0.0, 0.0))
    passer, receiver = m.player(7), m.player(8)
    passer.x, passer.y = 0.0, 0.0
    receiver.x, receiver.y = 15.0, 3.0
    m.recovering[passer.id] = 0.25  # as the engine does once it kicks
    assert bots.command(m, passer) == MoveTo(*bots._home(m, passer), bots.JOG)
    goes = bots.command(m, receiver)
    assert isinstance(goes, MoveTo) and 5 < goes.x < 16 and abs(goes.y) < 0.5  # onto the ball's path


def test_the_player_on_the_ball_passes_only_when_an_opponent_is_close():
    m = in_play(ball=(0.5, 0.0))
    carrier, opponent = m.player(7), m.player(18)
    carrier.x, carrier.y = 0.0, 0.0
    m.owner = carrier.id
    opponent.x, opponent.y = 3.0, 2.0  # 3.6 m away: it keeps dribbling
    assert bots.command(m, carrier) == MoveTo(52.5, 0.0, bots.DRIBBLE_SPEED)
    opponent.x, opponent.y = 2.0, 1.0
    assert isinstance(bots.command(m, carrier), KickTo)


def test_a_snapshot_lists_every_player_and_the_ball():
    m = Match()
    m.command(1, Hold())
    snapshot = m.snapshot()
    assert snapshot["type"] == "snapshot" and snapshot["phase"] == "kickoff"
    assert len(snapshot["players"]) == 22
    assert set(snapshot["ball"]) == {"x", "y", "z", "owner"}
    assert snapshot["players"][0]["action"] == "hold"


def test_a_ball_is_judged_where_it_first_crossed_a_line():
    m = in_play(ball=(52.60, 3.35), velocity=(10.0, 25.0, 0.0))
    m.step()
    assert m.score == [1, 0]


def test_a_ball_over_the_touchline_first_near_a_corner_is_a_throw_in():
    m = in_play(ball=(52.58, 34.08), velocity=(3.0, 6.0, 0.0), last_touch=0)
    m.step()
    assert (m.phase, m.restart_team) == ("throw_in", 1)


def test_a_player_cannot_carry_the_ball_through_a_post():
    y = pitch.GOAL_WIDTH / 2 + pitch.POST_RADIUS  # straight at the post
    m = in_play(ball=(45.6, y))
    p = m.players[9]
    p.x, p.y = 45.0, y
    m.command(p.id, MoveTo(60.0, y))
    run(m, 3)
    assert m.phase == "play" and m.ball.x < pitch.HALF_LENGTH


def test_an_opponent_on_the_centre_spot_at_kick_off_is_moved_into_its_own_half():
    m = Match()
    for p in m.players:  # nobody nearby to nudge the opponent off the spot
        if p.team == 0 and abs(p.x) < 2:
            p.x = -20.0
    opponent = next(p for p in m.players if p.team == 1)
    opponent.x, opponent.y = 0.0, 0.0
    m.step()
    assert opponent.x * m.attack(1) <= 0
    assert math.hypot(opponent.x, opponent.y) >= pitch.CENTRE_RADIUS - 1e-9


def test_a_goalkeeper_has_no_extra_reach_for_a_ball_outside_its_area():
    m = in_play(ball=(-35.0, 0.0))
    m.ball.z = 2.0
    keeper = m.players[0]
    keeper.x, keeper.y = -36.1, 0.0
    m.step()
    assert m.owner is None


def test_a_kicked_ball_leaves_before_a_nearby_opponent_can_claim_it():
    m = in_play(ball=(0.0, 0.0))
    kicker, defender = m.players[5], m.players[16]
    kicker.x, kicker.y = -0.6, 0.0
    defender.x, defender.y = 0.7, 0.0
    m.command(kicker.id, KickTo(-30.0, 0.0, 30.0))
    run(m, 3 * STEP)
    assert m.owner is None and m.ball.vx < -20

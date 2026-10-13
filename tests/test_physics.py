import math

from decision_pitch import pitch
from decision_pitch.physics import (
    ACCELERATION,
    BALL_RADIUS,
    PLAYER_RADIUS,
    STEP,
    TOP_SPEED,
    TURN_RATE,
    Ball,
    Player,
    separate,
    step_ball,
    step_player,
)


def run(ball, seconds):
    for _ in range(round(seconds / STEP)):
        step_ball(ball)


def player(**kw):
    return Player(1, 0, 1, "Test", "MF", (0.0, 0.0), **kw)


def test_a_dropped_ball_bounces_lower_each_time_then_rolls():
    ball = Ball(z=3.0)
    peaks, rising, top = [], False, ball.z
    for _ in range(600):
        step_ball(ball)
        if ball.vz > 0:
            rising, top = True, max(top, ball.z) if rising else ball.z
        elif rising:
            peaks.append(top)
            rising = False
    assert len(peaks) >= 2 and peaks[0] < 3.0 and peaks[1] < peaks[0]
    assert ball.z == BALL_RADIUS and ball.vz == 0


def test_a_rolling_ball_slows_to_a_stop():
    ball = Ball(vx=12.0)
    run(ball, 30)
    assert ball.vx == 0
    assert 30 < ball.x < 70


def test_air_drag_slows_a_ball_in_flight():
    ball = Ball(z=20.0, vx=25.0)
    run(ball, 0.5)
    assert ball.vx < 24.0


def test_a_ball_hitting_a_post_bounces_back():
    post_y = pitch.GOAL_WIDTH / 2 + pitch.POST_RADIUS
    ball = Ball(x=pitch.HALF_LENGTH - 2, y=post_y, z=0.5, vx=15.0)
    ball.vz = 0.0
    run(ball, 0.3)
    assert ball.vx < 0 and ball.x < pitch.HALF_LENGTH


def test_a_ball_hitting_the_crossbar_bounces_back():
    bar = pitch.GOAL_HEIGHT + pitch.POST_RADIUS
    ball = Ball(x=-pitch.HALF_LENGTH + 1, y=0.0, z=bar, vx=-20.0, vz=0.0)
    run(ball, 0.1)
    assert ball.vx > 0


def test_a_player_accelerates_at_a_limited_rate_up_to_top_speed():
    p = player()
    step_player(p, 100.0, 0.0, 20.0)
    assert p.speed <= ACCELERATION * STEP + 1e-9
    for _ in range(600):
        step_player(p, 100.0, 0.0, 20.0)
        assert p.speed <= TOP_SPEED + 1e-9
    assert p.speed > TOP_SPEED - 0.1


def test_a_running_player_turns_at_a_limited_rate():
    p = player(vx=TOP_SPEED)
    step_player(p, -50.0, 0.1, TOP_SPEED)
    assert abs(p.heading) <= TURN_RATE / (1 + TOP_SPEED / 3) * STEP + 1e-9


def test_a_player_stops_at_its_target():
    p = player()
    for _ in range(600):
        step_player(p, 10.0, 5.0, TOP_SPEED)
    assert math.hypot(p.x - 10, p.y - 5) < 0.2 and p.speed < 0.2


def test_overlapping_players_are_pushed_apart():
    a, b = player(x=0.0), player(x=0.3)
    separate([a, b])
    assert b.x - a.x >= 2 * PLAYER_RADIUS - 1e-9


def test_players_on_the_same_spot_are_pushed_apart():
    a, b = player(), player()
    separate([a, b])
    assert math.hypot(b.x - a.x, b.y - a.y) >= 2 * PLAYER_RADIUS - 1e-9

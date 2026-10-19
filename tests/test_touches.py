"""The snapshot's record of the latest touches of the ball and of a goalkeeper's dive, which
the page draws contact from. Reading them must change nothing in play."""

import math

from decision_pitch import pitch
from decision_pitch.match import CONTROL_SPEED, RECENT_TOUCHES, Hold, KickTo, Match, MoveTo
from decision_pitch.physics import BALL_RADIUS, STEP


def in_play(ball=(0.0, 0.0), velocity=(0.0, 0.0, 0.0)):
    """A match in open play, with every player lined up out of the way on one touchline."""
    m = Match()
    m.phase, m.restart_team, m.last_touch = "play", None, 0
    for i, p in enumerate(m.players):
        p.x, p.y, p.vx, p.vy = -50 + i * 4.7, -30.0, 0.0, 0.0
        m.command(p.id, Hold())
    m.ball.place(*ball)
    m.ball.vx, m.ball.vy, m.ball.vz = velocity
    m.drain_events()
    return m


def outfield(m, team=0, index=5):
    return [p for p in m.players if p.team == team and p.position != "GK"][index]


def keeper(m, team):
    return next(p for p in m.players if p.team == team and p.position == "GK")


def run(m, seconds):
    for _ in range(round(seconds / STEP)):
        m.step()


def latest(snapshot):
    touches = snapshot["ball"]["touches"]
    return touches[-1] if touches else None


def test_a_new_match_has_no_touch_and_no_dive():
    snapshot = Match().snapshot()
    assert snapshot["ball"]["touches"] == []
    assert not any("dive" in p for p in snapshot["players"])


def test_a_kick_is_recorded_with_its_kicker_time_and_where_the_ball_was():
    m = in_play(ball=(0.0, 0.0))
    p = outfield(m)
    p.x, p.y = -0.5, 0.0
    m.command(p.id, KickTo(30.0, 0.0, 20.0))
    m.step()
    snapshot = m.snapshot()
    touch = latest(snapshot)
    assert touch == {"player": p.id, "kind": "kick", "t": snapshot["t"], "x": 0.0, "y": 0.0, "z": BALL_RADIUS}
    assert m.ball.vx > 15  # the ball is on its way: the record is of the touch, not after it


def test_a_throw_in_is_recorded_as_a_throw():
    m = in_play(ball=(10.0, pitch.HALF_WIDTH - 1), velocity=(0.0, 8.0, 0.0))
    run(m, 0.5)
    assert m.phase == "throw_in"
    thrower = next(p for p in m.players if p.team == m.restart_team)
    thrower.x, thrower.y = m.ball.x, m.ball.y - 0.5
    m.command(thrower.id, KickTo(10.0, 10.0, 12.0))
    for _ in range(150):
        m.step()
        if m.phase == "play":
            break
    assert m.phase == "play"
    assert latest(m.snapshot())["kind"] == "throw"
    assert latest(m.snapshot())["player"] == thrower.id


def test_taking_a_loose_ball_is_a_control_and_carrying_it_adds_no_touch():
    m = in_play(ball=(-3.0, 0.0), velocity=(4.0, 0.0, 0.0))
    p = outfield(m)
    p.x, p.y, p.heading = 0.0, 0.0, math.pi
    taken = None
    for _ in range(120):
        m.step()
        if m.owner == p.id:
            taken = m.snapshot()
            break
    assert taken is not None
    touch = latest(taken)
    assert (touch["player"], touch["kind"], touch["t"]) == (p.id, "control", taken["t"])
    assert touch["x"] > -1.0  # where it met the ball, before it was carried
    m.command(p.id, MoveTo(30.0, 0.0))
    run(m, 1.0)
    assert m.owner == p.id
    assert list(m.touches) == [touch]


def test_taking_the_ball_off_an_opponent_is_a_tackle():
    m = in_play()
    carrier, challenger = outfield(m, 0), outfield(m, 1)
    carrier.x, carrier.y, carrier.heading = 0.0, 0.0, 0.0
    m.ball.place(0.6, 0.0)
    m.owner = carrier.id
    challenger.x, challenger.y = 1.0, 0.0  # standing nearer the ball: no foul to judge
    m.step()
    assert m.owner == challenger.id
    touch = latest(m.snapshot())
    assert (touch["player"], touch["kind"]) == (challenger.id, "tackle")
    assert m.drain_events() == []


def test_a_ball_too_fast_to_control_is_a_deflection():
    m = in_play(ball=(-3.0, 0.0), velocity=(CONTROL_SPEED + 6, 0.0, 0.0))
    p = outfield(m)
    p.x, p.y = 0.0, 0.0
    for _ in range(30):
        m.step()
        if m.touches:
            break
    assert m.owner is None
    touch = latest(m.snapshot())
    assert (touch["player"], touch["kind"]) == (p.id, "deflect")


def test_a_goalkeeper_parrying_a_shot_in_its_area_is_a_save():
    goal = -pitch.HALF_LENGTH  # the home team defends -x in the first half
    m = in_play(ball=(goal + 12, 1.0), velocity=(-(CONTROL_SPEED + 6), 0.0, 0.0))
    gk = keeper(m, 0)
    gk.x, gk.y = goal + 2, 0.0
    for _ in range(60):
        m.step()
        if m.touches:
            break
    touch = latest(m.snapshot())
    assert (touch["player"], touch["kind"]) == (gk.id, "save")
    assert touch["y"] > 0.5  # it reached across to the ball


def test_a_goalkeeper_taking_the_ball_in_its_area_is_a_catch():
    goal = -pitch.HALF_LENGTH
    m = in_play(ball=(goal + 8, 0.0), velocity=(-6.0, 0.0, 0.0))
    gk = keeper(m, 0)
    gk.x, gk.y = goal + 2, 0.0
    for _ in range(90):
        m.step()
        if m.touches:
            break
    assert m.owner == gk.id
    touch = latest(m.snapshot())
    assert (touch["player"], touch["kind"]) == (gk.id, "catch")


def test_walking_up_to_a_ball_placed_for_a_restart_is_not_a_touch():
    m = Match()
    taker = min((p for p in m.players if p.team == 0), key=lambda p: math.hypot(p.x, p.y))
    run(m, 0.5)
    assert m.owner == taker.id and m.phase == "kickoff"
    assert latest(m.snapshot()) is None


def test_each_touch_is_repeated_for_a_tenth_of_a_second_so_no_snapshot_misses_it():
    m = in_play(ball=(0.0, 0.0))
    p = outfield(m)
    p.x, p.y = -0.5, 0.0
    m.command(p.id, KickTo(30.0, 0.0, 20.0))
    m.step()
    touch = latest(m.snapshot())
    seen = 0
    while m.t < touch["t"] + 0.3:
        m.step()
        seen += touch in m.snapshot()["ball"]["touches"]
    assert seen == round(RECENT_TOUCHES / STEP)
    assert m.snapshot()["ball"]["touches"] == []


def test_a_kick_met_at_once_by_another_player_keeps_both_touches_in_order():
    m = in_play(ball=(0.0, 0.0))
    kicker, blocker = outfield(m, 0), outfield(m, 1)
    kicker.x, kicker.y = -0.5, 0.0
    blocker.x, blocker.y = 0.9, 0.0  # the ball reaches it the next step, too fast to control
    m.command(kicker.id, KickTo(30.0, 0.0, 26.0))
    m.step()
    m.step()
    touches = m.snapshot()["ball"]["touches"]
    assert [(t["player"], t["kind"]) for t in touches] == [(kicker.id, "kick"), (blocker.id, "deflect")]
    assert touches[0]["t"] < touches[1]["t"]


def test_a_kick_in_the_step_the_ball_is_taken_replaces_that_first_touch():
    m = in_play(ball=(0.0, 0.0))
    p = outfield(m)
    p.x, p.y = -0.5, 0.0
    m.command(p.id, KickTo(30.0, 0.0, 20.0))
    m.step()  # it takes the loose ball and kicks it at once
    assert [t["kind"] for t in m.snapshot()["ball"]["touches"]] == ["kick"]


def test_a_goalkeeper_diving_across_its_goal_is_flagged_while_it_dives():
    goal = -pitch.HALF_LENGTH
    m = in_play(ball=(goal + 20, 0.0), velocity=(-20.0, 2.0, 0.0))
    gk = keeper(m, 0)
    gk.x, gk.y = goal + 0.5, -2.0
    m.command(gk.id, MoveTo(goal + 0.5, 2.5))
    m.step()
    players = {p["id"]: p for p in m.snapshot()["players"]}
    assert players[gk.id]["dive"] is True
    assert sum("dive" in p for p in players.values()) == 1
    m.command(gk.id, Hold())
    m.step()
    assert "dive" not in {p["id"]: p for p in m.snapshot()["players"]}[gk.id]


def test_reading_the_snapshot_changes_nothing():
    m = in_play(ball=(0.0, 0.0))
    p = outfield(m)
    p.x, p.y = -0.5, 0.0
    m.command(p.id, KickTo(30.0, 0.0, 20.0))
    m.step()
    first = m.snapshot()
    first["ball"]["touches"][0]["kind"] = "changed by the reader"
    assert latest(m.snapshot())["kind"] == "kick"
    assert m.snapshot() == m.snapshot()

import asyncio
import json
import random
import time

import httpx
import pytest

from decision_pitch import actions, players
from decision_pitch.arena import apis
from decision_pitch.arena.models import Answer
from decision_pitch.bots import _taker
from decision_pitch.match import TEAMS, Hold, KickTo, Match, MoveTo, Team
from decision_pitch.players import FAILURE_WAIT, Players
from decision_pitch.server import main, run, seat

KEY = "test-key-not-real"


class Fake:
    """A decision model that answers `action` after `delay` seconds, or fails."""

    def __init__(self, action="press", delay=0.0, fail=False, name="Fake"):
        self.name, self.action, self.delay, self.fail = name, action, delay, fail
        self.asked, self.in_flight, self.most_in_flight = [], 0, 0

    async def decide(self, question):
        self.asked.append((time.perf_counter(), question))
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
            if self.fail:
                raise RuntimeError("HTTP 500: overloaded")
            return Answer(self.action, {a: 1.0 if a == self.action else 0.0 for a in question.options})
        finally:
            self.in_flight -= 1


def in_play(match):
    match.phase, match.restart_team = "play", None
    return match


# -- the adapters, with the move set taken from the question ---------------------------------


def test_an_answer_is_checked_against_the_soccer_actions():
    def handle(request):
        criteria = json.loads(request.content)["questions"]["move"]["criteria"]
        assert tuple(criteria) == tuple(actions.ACTIONS)
        probabilities = {a: 0.3 if a == "pass" else 0.1 for a in criteria}
        return httpx.Response(200, json={"answers": {"move": {"choice": "pass", "probabilities": probabilities}}})

    model = apis.DecisionAPI("Test", "https://example.test/v1", "m", KEY, transport=httpx.MockTransport(handle))
    match = Match()
    answer = asyncio.run(model.decide(actions.question(match, match.player(7), "hold", None)))
    assert answer.move == "pass"


def test_an_answer_with_the_runner_moves_is_unusable():
    runner = {m: 0.2 for m in ("left", "right", "jump", "roll", "keep")}
    reply = {"answers": {"move": {"choice": "jump", "probabilities": runner}}}
    model = apis.DecisionAPI("Test", "https://example.test/v1", "m", KEY,
                             transport=httpx.MockTransport(lambda r: httpx.Response(200, json=reply)))
    match = Match()
    with pytest.raises(ValueError, match="unusable"):
        asyncio.run(model.decide(actions.question(match, match.player(7), "hold", None)))


# -- the state each player is told ------------------------------------------------------------


def test_both_teams_are_told_the_same_state_from_their_own_side():
    """A match and its mirror image, with the teams swapped, read the same to each player."""
    same = Team("Same", TEAMS[0].colours, TEAMS[0].names)
    a, b = in_play(Match(teams=(same, same))), in_play(Match(teams=(same, same)))
    rng = random.Random(1)
    for p in a.players:
        p.x, p.y, p.vx, p.vy = rng.uniform(-50, 50), rng.uniform(-33, 33), rng.uniform(-5, 5), 0.0
    a.ball.x, a.ball.y, a.ball.vx, a.ball.vy = 12.0, -4.0, 6.0, 2.0
    for p in a.players:
        q = b.player(p.id + 11 if p.team == 0 else p.id - 11)
        q.x, q.y, q.vx, q.vy = -p.x, -p.y, -p.vx, -p.vy
    b.ball.x, b.ball.y, b.ball.vx, b.ball.vy = -12.0, 4.0, -6.0, -2.0
    for p in a.players:
        mirror = b.player(p.id + 11 if p.team == 0 else p.id - 11)
        assert actions.question(a, p, "mark", 0.4).state == actions.question(b, mirror, "mark", 0.4).state


def test_the_state_says_what_the_player_is_doing_and_how_fast_it_answers():
    match = Match()
    state = actions.question(match, match.player(10), "support", 1.25, "Stay wide.").state
    assert "Harbour forward" in state and "doing support" in state
    assert "Your answers take 1.2 s." in state and "Manager: Stay wide." in state
    assert "Harbour kick off, you take it." in state  # the centre forward takes the kick-off
    assert "Your answers" not in actions.question(match, match.player(10), "hold", None).state


# -- answers turned into movement --------------------------------------------------------------


def test_a_pass_from_the_player_on_the_ball_is_a_kick():
    match = in_play(Match())
    p = match.player(7)
    match.ball.place(p.x + 0.5, p.y)
    match.owner = p.id
    assert isinstance(actions.command(match, p, "pass"), KickTo)
    assert isinstance(actions.command(match, p, "press"), Hold)  # it already has the ball


def test_at_a_restart_only_the_taker_goes_to_the_ball():
    match = Match()
    match._restart("throw_in", 0, 10.0, 34.0)
    taker = min((p for p in match.players if p.team == 0 and p.position != "GK"),
                key=lambda p: abs(p.x - 10) + abs(p.y - 34))
    other = next(p for p in match.players if p.team == 0 and p.id != taker.id and p.position != "GK")
    assert isinstance(actions.command(match, taker, "press"), KickTo)
    held = actions.command(match, other, "press")
    assert isinstance(held, MoveTo) and (held.x, held.y) != (10.0, 34.0)


def test_a_taker_that_never_takes_the_restart_is_taken_over():
    match = Match()
    match._restart("corner", 0, 52.5, 34.0)
    taker = _taker(match, 0)
    assert isinstance(actions.command(match, taker, "hold"), MoveTo)
    match.since_restart = actions.RESTART_WAIT
    assert isinstance(actions.command(match, taker, "hold"), KickTo)


def test_a_kick_once_made_is_done():
    match = in_play(Match())
    squad = Players(match, {7: Fake()})
    squad.seats[7].action = "clear"
    squad.play()
    match.commands[7], match.recovering[7] = Hold(), 0.25  # as the engine does once it kicks
    squad.play()
    assert squad.seats[7].action == "hold"


def test_a_kick_answered_just_after_a_kick_is_still_carried_out():
    match = in_play(Match())
    squad = Players(match, {7: Fake()})
    seat_ = squad.seats[7]
    seat_.action = "clear"
    squad.play()
    match.commands[7], match.recovering[7] = Hold(), 0.25
    seat_.action, seat_.answers = "pass", seat_.answers + 1  # a new answer, before the next step
    squad.play()
    assert seat_.action == "pass" and isinstance(match.commands[7], KickTo)


# -- the real-time loop -------------------------------------------------------------------------


def test_each_player_has_one_question_in_flight_and_its_answer_time_measured():
    async def go():
        match = in_play(Match())
        model = Fake("support", delay=0.05)
        squad = Players(match, {7: model, 8: model})
        task = asyncio.create_task(squad.run())
        await asyncio.sleep(0.32)
        task.cancel()
        return squad, model

    squad, model = asyncio.run(go())
    assert model.most_in_flight == 2  # one per player
    assert 8 <= len(model.asked) <= 14  # each player asks again as soon as it is answered
    decision = squad.drain_decisions()[0]
    assert decision["action"] == "support" and 45 <= decision["ms"] <= 120
    assert squad.seats[7].action == "support" and 0.045 <= squad.seats[7].answer <= 0.12
    assert "Your answers take 0.1 s." in model.asked[-1][1].state


def test_a_failed_answer_waits_before_asking_again():
    async def go():
        match = in_play(Match())
        model = Fake(fail=True)
        squad = Players(match, {7: model})
        task = asyncio.create_task(squad.run())
        await asyncio.sleep(FAILURE_WAIT * 2.5)
        task.cancel()
        return squad, model

    squad, model = asyncio.run(go())
    assert len(model.asked) == 3
    assert model.asked[1][0] - model.asked[0][0] >= FAILURE_WAIT
    assert squad.drain_decisions()[0]["error"] == "HTTP 500: overloaded"
    assert squad.seats[7].action == "hold"  # it keeps doing what it was doing


def test_a_match_with_a_model_on_every_player_runs_to_full_time():
    match = Match(half_length=0.5)
    model = Fake("press", delay=0.01)
    squad = seat(match, model, model)
    sent = []

    async def send(message):
        sent.append(message)

    asyncio.run(run(match, send, squad))
    assert match.phase == "full_time" and len(squad.seats) == 22
    decided = {m["player"] for m in sent if m["type"] == "decision"}
    assert decided == set(range(1, 23))


def test_a_player_sent_off_is_no_longer_asked():
    async def go():
        match = in_play(Match())
        squad = Players(match, {7: Fake("hold")})
        match._card(match.player(7), red=True)
        running = asyncio.create_task(squad.run())
        await asyncio.sleep(0.3)
        assert squad._loops[7].done()  # its loop has ended
        running.cancel()

    asyncio.run(go())


def test_a_substitute_with_a_model_is_named_and_asked_once_it_comes_on():
    match = Match()
    squad = Players(match, {23: Fake("hold", delay=0.01, name="Sub")})
    assert match.substitute(10, 23) is None  # made at the kick-off, a stoppage
    sent = []

    async def send(message):
        sent.append(message)
        if message["type"] == "decision":
            match.phase = "full_time"

    asyncio.run(asyncio.wait_for(run(match, send, squad), 5.0))
    [substitution] = [m for m in sent if m.get("kind") == "substitution"]
    assert (substitution["off"], substitution["on"], substitution["model"]) == (10, 23, "Sub")
    assert {m["player"] for m in sent if m["type"] == "decision"} == {23}


def test_a_penalty_taker_is_told_it_takes_it():
    match = Match()
    match._restart("penalty", 0, 41.5, 0.0, taker=10)
    text = actions.question(match, match.player(10), "hold", None).state
    assert "Harbour take a penalty, you take it." in text


# -- which models can play ----------------------------------------------------------------------


def test_with_no_keys_only_the_bot_and_local_models_are_offered(monkeypatch):
    monkeypatch.setattr(players.local, "engine_python", lambda: "/laya/bin/python")
    reasons = asyncio.run(players.available())
    assert reasons["bot"] is None and reasons["laya"] is None
    assert "TYPESAFE_API_KEY" in reasons["jev"] and "OPENAI_API_KEY" in reasons["openai"]


def test_startup_names_the_key_to_check_when_a_model_does_not_answer(monkeypatch):
    refused = httpx.MockTransport(lambda r: httpx.Response(401, json={"error": "bad key"}))
    monkeypatch.setitem(players.APIS, "jev", lambda: apis.DecisionAPI(
        "Jev", "https://example.test/v1", "m", KEY, transport=refused, key_name="TYPESAFE_API_KEY"))
    reason = asyncio.run(players.available())["jev"]
    assert "did not answer" in reason and "check TYPESAFE_API_KEY" in reason


def test_a_kick_answer_survives_the_second_half_kick_off():
    match = Match()
    p = next(q for q in match.players if q.team == 1 and q.position == "FW")
    squad = Players(match, {p.id: Fake()})
    squad.seats[p.id].action = "pass"
    squad.play()
    match.period = 2
    match._kickoff(1, place_players=True)  # every command is reset to hold
    squad.play()
    assert squad.seats[p.id].action == "pass"


def test_an_error_that_could_carry_a_key_is_named_by_its_type_only():
    async def leaky(question):
        raise httpx.LocalProtocolError(f"Illegal header value b'Bearer {KEY}\\n'")

    async def go():
        match = in_play(Match())
        model = Fake()
        model.decide = leaky
        squad = Players(match, {7: model})
        task = asyncio.create_task(squad.run())
        await asyncio.sleep(0.05)
        task.cancel()
        return squad.drain_decisions()

    assert asyncio.run(go())[0]["error"] == "LocalProtocolError"


def test_choosing_a_model_without_its_key_says_which_key(capsys):
    with pytest.raises(SystemExit) as stopped:
        main(["--headless", "--home", "jev"])
    assert stopped.value.code == 2
    assert "TYPESAFE_API_KEY" in capsys.readouterr().err

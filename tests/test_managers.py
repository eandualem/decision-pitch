import asyncio
import json
from pathlib import Path

import httpx
import httpx2
import pytest
from anthropic import DefaultAsyncHttpxClient

from decision_pitch import actions, managers
from decision_pitch.managers import Advice, BuiltIn, Claude, LanguageModel, Staff
from decision_pitch.match import Match
from decision_pitch.players import Players
from decision_pitch.server import fast, hello, main, run

KEY = "test-key-not-real"
RECORDED = json.loads((Path(__file__).parent / "recordings" / "openai_manager.json").read_text())


class Fake:
    def __init__(self, name):
        self.name = name

    async def decide(self, question):
        raise NotImplementedError


def staffed(home=None, away=None, options=None, match=None):
    match = match or Match()
    squad = Players(match)
    options = options or ({"bot": None}, {"bot": None})
    return Staff(match, squad, (home or BuiltIn(), away or BuiltIn()), options)


def play(staff):
    """Line up, then play the match to full time as fast as it runs; return what was sent."""
    sent = []

    async def send(message):
        sent.append(message)

    async def go():
        await staff.line_up()
        await fast(staff.match, send, staff.squad, staff)
        await staff.aclose()

    asyncio.run(go())
    return sent


# -- the built-in manager -----------------------------------------------------------------


def test_two_built_in_managers_play_a_full_match_with_substitutions():
    staff = staffed(match=Match(half_length=120.0, seed=2))
    sent = play(staff)
    assert staff.match.phase == "full_time"
    made = [m for m in sent if m.get("kind") == "substitution" and m["type"] == "event"]
    asked = [m for m in sent if m["type"] == "manager" and m["kind"] == "substitution"]
    for team in (0, 1):
        assert 3 <= sum(m["team"] == team for m in made) <= 5
    assert {(m["off"], m["on"]) for m in made} <= {(m["off"], m["on"]) for m in asked}


def test_the_built_in_line_up_puts_no_more_on_a_local_model_than_it_answers_quickly():
    laya = Fake("Laya")
    staff = staffed(options=({"bot": None, "laya": laya}, {"bot": None}))
    asyncio.run(staff.line_up())
    on_laya = [p for p in staff.match.players if staff.squad.seats.get(p.id)]
    assert len(on_laya) == 7  # 0.2 s an answer, one at a time: 7 players within 1.5 s
    assert {p.position for p in on_laya} == {"FW", "MF", "DF"}  # forwards first, the keeper last
    assert staff.models(0)[1] == "bot"


def test_a_player_whose_model_keeps_failing_is_replaced_like_for_like():
    jev = Fake("Jev")
    staff = staffed(options=({"jev": jev}, {"bot": None}))
    asyncio.run(staff.line_up())
    staff.squad.seats[7].outcomes.extend([True, False, False, False])
    advice = asyncio.run(BuiltIn().advise(staff.situation(0)))
    assert advice.substitutions == [(7, 26, "jev")]  # a midfielder for a midfielder


# -- advice is checked before it is applied --------------------------------------------------


def test_an_instruction_reaches_the_player_in_its_state():
    jev = Fake("Jev")
    staff = staffed(options=({"jev": jev}, {"bot": None}))
    asyncio.run(staff.line_up())
    staff.apply(0, Advice(instructions=[(7, "Stay wide and wait for the switch.\nNow.")]))
    seat = staff.squad.seats[7]
    question = actions.question(staff.match, staff.match.player(7), "hold", None, seat.instruction)
    assert "Manager: Stay wide and wait for the switch. Now." in question.state
    [message] = staff.drain()
    assert message == {"type": "manager", "team": 0, "kind": "instruction", "player": 7,
                       "text": "Stay wide and wait for the switch. Now."}  # fmt: skip


def test_advice_that_breaks_the_rules_is_dropped_and_the_manager_told():
    staff = staffed(options=({"bot": None, "jev": Fake("Jev")}, {"bot": None}))
    staff.apply(0, Advice(
        instructions=[(15, "Not my player."), (23, "Still on the bench.")],
        substitutions=[(7, 30, "jev"), (7, 26, "laya"), (8, 26, "jev"), (9, 26, "jev")],
    ))  # fmt: skip
    [asked] = staff.drain()
    assert (asked["off"], asked["on"], asked["model"]) == (8, 26, "jev")
    assert staff.squad.seats[26].model.name == "Jev"
    feed = staff.feed(0)
    assert "Substitution of [30] for [7] refused: that player is not on the team's bench." in feed
    assert "Substitution of [26] for [7] refused: that is not your player or model." in feed
    assert "Substitution of [26] for [9] refused: that substitution is already asked for." in feed
    assert "waiting for a stoppage: Heath for Brook" in feed


def test_a_live_match_streams_a_substitution_request_with_the_model_s_name():
    staff = staffed(options=({"bot": None, "jev": Fake("Jev")}, {"bot": None}))
    staff.apply(0, Advice(substitutions=[(8, 26, "jev")]))
    sent = []

    async def send(message):
        sent.append(message)
        if message["type"] == "manager":
            staff.match.phase = "full_time"

    asyncio.run(asyncio.wait_for(run(staff.match, send, staff.squad, staff), 5.0))
    [asked] = [m for m in sent if m["type"] == "manager"]
    assert asked["model"] == "jev"


def test_the_feed_tells_the_match_from_the_team_s_side():
    staff = staffed()
    m = staff.match
    m.score = [0, 1]
    staff.observe([{"type": "event", "kind": "goal", "t": 1.0, "team": 1, "player": 20},
                   {"type": "event", "kind": "throw_in", "t": 2.0, "team": 0}])  # fmt: skip
    feed = staff.feed(0)
    assert feed.startswith("You manage Harbour. 00:00, 1st half, Harbour 0-1 Ridge; kickoff.")
    assert "Since you last looked: 00:00 goal, Ridge (Ember)." in feed  # a throw-in is left out
    assert "- [7] Finch, midfielder: bot" in feed
    assert "Your bench: [23] Cove, goalkeeper;" in feed
    assert "- bot: the built-in bot" in feed


# -- the language-model manager, on recorded answers ------------------------------------------


class Recorded:
    """OpenAI's Chat Completions API replaying recorded answers: the line-up, then each
    advice in turn, over and over; an assistant gets the recorded note."""

    def __init__(self):
        self.requests, self.advised = [], 0

    def __call__(self, request):
        body = json.loads(request.content)
        self.requests.append(request)
        if "response_format" not in body:
            content = RECORDED["assistant"]
        elif "lineup" in body["response_format"]["json_schema"]["schema"]["properties"]:
            content = RECORDED["lineup"]
        else:
            content = RECORDED["advice"][self.advised % len(RECORDED["advice"])]
            self.advised += 1
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content}}]})


def test_a_language_model_manager_plays_a_full_match_with_substitutions(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    api = Recorded()
    manager = LanguageModel(assistants=1, transport=httpx.MockTransport(api))
    laya, jev = Fake("Laya"), Fake("Jev")
    staff = staffed(manager, options=({"bot": None, "laya": laya, "jev": jev}, {"bot": None}),
                    match=Match(half_length=60.0, seed=1))  # fmt: skip
    sent = play(staff)
    assert staff.match.phase == "full_time"
    assert all(request.headers["authorization"] == f"Bearer {KEY}" for request in api.requests)
    first = json.loads(api.requests[0].content)
    assert first["model"] == managers.DEFAULT_MODEL and "Kick-off is next" in first["messages"][1]["content"]
    made = {(m["off"], m["on"]) for m in sent if m.get("kind") == "substitution" and m["team"] == 0
            and m["type"] == "event"}  # fmt: skip
    assert made == {(8, 26), (11, 28)}
    assert staff.squad.model_name(26) == "Laya" and staff.squad.model_name(28) == "Jev"
    told = [m for m in sent if m["type"] == "manager" and m["kind"] == "instruction"]
    assert {m["player"] for m in told} >= {1, 2, 3}
    assistant = [json.loads(r.content) for r in api.requests if "response_format" not in json.loads(r.content)]
    assert assistant and assistant[0]["model"] == managers.ASSISTANT_MODEL
    advised = [json.loads(r.content)["messages"][1]["content"] for r in api.requests[1:]]
    assert any("Assistant 1: Right now every player" in feed for feed in advised)


def test_a_failed_consultation_changes_nothing_and_never_shows_the_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", KEY)

    def fail(request):
        return httpx.Response(500, json={"error": {"message": f"overloaded for {KEY}"}})

    staff = staffed(LanguageModel(transport=httpx.MockTransport(fail)))
    asyncio.run(staff.line_up())  # falls back to the built-in line-up
    asyncio.run(staff.consult(0))
    assert staff.drain() == []
    feed = staff.feed(0)
    assert "Your last consultation failed (HTTP 500" in feed and KEY not in feed


class RecordedClaude:
    """Anthropic's Messages API replaying the same recorded answers as Recorded."""

    def __init__(self):
        self.requests, self.advised = [], 0

    def __call__(self, request):
        body = json.loads(request.content)
        self.requests.append(request)
        schema = body["output_config"].get("format", {}).get("schema")
        if schema is None:
            content = RECORDED["assistant"]
        elif "lineup" in schema["properties"]:
            content = RECORDED["lineup"]
        else:
            content = RECORDED["advice"][self.advised % len(RECORDED["advice"])]
            self.advised += 1
        return httpx2.Response(200, json={
            "id": "msg_test", "type": "message", "role": "assistant", "model": body["model"],
            "content": [{"type": "text", "text": content}], "stop_reason": "end_turn",
            "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1},
        })  # fmt: skip


def test_claude_manages_a_full_match_with_substitutions(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)
    api = RecordedClaude()
    manager = Claude(assistants=1, http_client=DefaultAsyncHttpxClient(transport=httpx2.MockTransport(api)))
    staff = staffed(manager, options=({"bot": None, "laya": Fake("Laya"), "jev": Fake("Jev")}, {"bot": None}),
                    match=Match(half_length=60.0, seed=1))  # fmt: skip
    sent = play(staff)
    assert staff.match.phase == "full_time"
    assert all(request.headers["x-api-key"] == KEY for request in api.requests)
    bodies = [json.loads(request.content) for request in api.requests]
    assert {body["model"] for body in bodies} == {managers.CLAUDE_MODEL}
    assert bodies[0]["output_config"]["effort"] == "low" and "Kick-off is next" in bodies[0]["messages"][0]["content"]
    made = {(m["off"], m["on"]) for m in sent if m.get("kind") == "substitution" and m["team"] == 0
            and m["type"] == "event"}  # fmt: skip
    assert made == {(8, 26), (11, 28)}
    assert any("format" not in body["output_config"] for body in bodies)  # an assistant's note


def test_a_failed_claude_consultation_never_shows_the_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", KEY)

    def fail(request):
        return httpx2.Response(400, json={"type": "error", "error": {"type": "invalid_request_error",
                                                                     "message": f"bad request for {KEY}"}})

    staff = staffed(Claude(http_client=DefaultAsyncHttpxClient(transport=httpx2.MockTransport(fail))))
    asyncio.run(staff.line_up())  # falls back to the built-in line-up
    asyncio.run(staff.consult(0))
    feed = staff.feed(0)
    assert "Your last consultation failed (HTTP 400" in feed and KEY not in feed


def test_the_page_is_told_each_team_s_manager_and_models(monkeypatch):
    staff = staffed(options=({"laya": Fake("Laya")}, {"bot": None}))
    asyncio.run(staff.line_up())
    teams = hello(staff.match, staff.squad, staff)["teams"]
    assert [team["manager"] for team in teams] == ["Built-in", "Built-in"]
    assert [team["assistants"] for team in teams] == [[], []]
    assert {p["model"] for p in teams[0]["players"]} == {"Laya"}
    assert {p["model"] for p in teams[1]["players"]} == {None}


def test_the_page_is_told_each_manager_s_assistant_models(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    helped = LanguageModel(assistants=2, transport=httpx.MockTransport(Recorded()))
    alone = LanguageModel(transport=httpx.MockTransport(Recorded()))
    for away, expected in ((alone, []), (BuiltIn(), [])):
        staff = staffed(helped, away)
        teams = hello(staff.match, staff.squad, staff)["teams"]
        assert teams[0]["manager"] == managers.DEFAULT_MODEL
        assert teams[0]["assistants"] == [managers.ASSISTANT_MODEL, managers.ASSISTANT_MODEL]
        assert teams[1]["assistants"] == expected
    asyncio.run(helped.aclose())
    asyncio.run(alone.aclose())


@pytest.mark.parametrize("manager, key", [("openai", "OPENAI_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY")])
def test_a_language_model_manager_without_its_key_says_which_key(manager, key, capsys, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)  # no .env
    monkeypatch.delenv(key, raising=False)
    with pytest.raises(SystemExit) as stopped:
        main(["--headless", "--home-manager", manager])
    assert stopped.value.code == 2
    assert key in capsys.readouterr().err


def test_a_headless_match_with_built_in_managers_prints_their_advice(capsys):
    main(["--headless", "--half-length", "60", "--seed", "3"])
    out = capsys.readouterr().out
    assert "manager: " in out and "substitution Harbour" in out

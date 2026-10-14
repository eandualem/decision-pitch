"""Each team's manager: it picks a decision model for every player before kick-off, then
follows the match through a text feed and guides its players with instructions and
substitutions, within the substitution rules.

The built-in manager follows simple rules and needs no model. The language-model manager
asks an LLM, optionally helped by assistant models. Both are consulted by the same staff,
on the same schedule, with the same feed."""

from __future__ import annotations

import asyncio
import json
import statistics
from dataclasses import dataclass, field
from typing import Protocol

import anthropic
import httpx

from decision_pitch.arena import apis
from decision_pitch.arena.models import Model
from decision_pitch.match import RESTARTS, Match
from decision_pitch.physics import Player
from decision_pitch.players import BOT, Players

QUIET = ("throw_in", "goal_kick", "free_kick")  # restarts left out of the feed: too many to read
CONSULT_EVERY = 15.0  # s of play between one consultation's answer and the next question
INSTRUCTION_LENGTH = 80  # characters
UNMEASURED = 1.0  # s assumed for a model whose answer time is not measured yet
SLOWEST_TO_PICK = 1.5  # s: the bot plays a position only when every model is expected slower
ORDER = ("FW", "MF", "DF", "GK")  # the order line-ups are picked in
POSITIONS = {"GK": "goalkeeper", "DF": "defender", "MF": "midfielder", "FW": "forward"}


@dataclass(frozen=True)
class Traits:
    """A model's stated characteristics, as a manager is told them."""

    label: str
    runs: str
    seconds: float | None  # typical answer time measured here, warm, one question at a time
    one_at_a_time: bool = False  # answers one question at a time for the whole team


TRAITS = {
    BOT: Traits("the built-in bot", "in the match engine: no model, the same fixed rules for every "
                "bot, and it reads no instructions", 0.0),
    "laya": Traits("Laya", "on this computer", 0.2, one_at_a_time=True),
    "d1": Traits("d1-3B", "on this computer", None, one_at_a_time=True),
    "jev": Traits("Jev", "on TypeSafe's API", 0.3),
    "openai": Traits("GPT-6 Luna Decisions", "on OpenAI's API", 0.33),
    "perplexity": Traits("Perplexity Decider", "on Perplexity's API", 0.42),
    "aplomb": Traits("Aplomb 1", "on EmpirioLabs' API", 0.3),
    "microsoft": Traits("Microsoft Decision-1", "through Vercel's AI Gateway", None),
    "liquid": Traits("Liquid D1", "through Vercel's AI Gateway", None),
    "clef": Traits("Clef-flash", "on Cloudflare's API", 0.4),
}  # fmt: skip


def describe(name: str) -> str:
    """One line of a model's stated characteristics."""
    t = TRAITS[name]
    speed = "answer time not measured yet" if t.seconds is None else f"typically {t.seconds:.2f} s an answer"
    if name == BOT:
        speed = "decides instantly"
    shared = ", answers one question at a time for the whole team" if t.one_at_a_time else ""
    return f"{name}: {t.label}, runs {t.runs}{shared}, {speed}"


@dataclass
class Advice:
    instructions: list[tuple[int, str]] = field(default_factory=list)  # (player, text)
    substitutions: list[tuple[int, int, str]] = field(default_factory=list)  # (off, on, model)
    reasons: dict[int, str] = field(default_factory=dict)  # by the player leaving


@dataclass
class Situation:
    """What a manager is consulted with: the match from its team's side, as text and as the
    match itself for a manager that follows rules."""

    match: Match
    squad: Players
    team: int
    options: tuple[str, ...]  # the models it may choose from
    models: dict[int, str]  # the model each of its players is on, by the name it is chosen with
    feed: str


class Manager(Protocol):
    name: str
    assistants: tuple[str, ...]  # the model of each assistant helping it, for the page

    async def lineup(self, situation: Situation) -> dict[int, str]: ...

    async def advise(self, situation: Situation) -> Advice: ...

    async def aclose(self) -> None: ...


def minute(m: Match) -> float:
    return m.elapsed / m.half_length * 45 + (45 if m.period == 2 else 0)


# -- the built-in manager -----------------------------------------------------------------


class BuiltIn:
    """Picks models by their stated answer times and substitutes by simple rules."""

    name = "Built-in"
    assistants: tuple[str, ...] = ()
    SCHEDULE = (55, 65, 75)  # minutes at which the slowest outfield player is replaced
    BOOKED_FROM = 60  # minute from which a player on a yellow card is replaced
    FAILING = 3  # failed answers in the last five that get a player replaced
    LATE = 70  # minute from which the losing or winning team is told how to play

    def __init__(self) -> None:
        self._scheduled: set[int] = set()  # the minutes whose substitution is done
        self._told: dict[int, str] = {}

    async def lineup(self, situation: Situation) -> dict[int, str]:
        m, team = situation.match, situation.team
        chosen: dict[int, str] = {}
        players = sorted((p for p in m.players if p.team == team), key=lambda p: ORDER.index(p.position))
        for p in players:
            chosen[p.id] = _quickest(situation.options, list(chosen.values()))
        return chosen

    async def advise(self, situation: Situation) -> Advice:
        m, squad, team = situation.match, situation.squad, situation.team
        advice = Advice()
        pending = {off for off, _ in m.pending} | {on for _, on in m.pending}
        bench = [q for q in m.bench if q.team == team and q.id not in pending]
        ours = [p for p in m.players if p.team == team and p.id not in pending]
        now = minute(m)
        leaving: list[tuple[Player, str]] = []
        for p in ours:
            seat = squad.seats.get(p.id)
            if seat and list(seat.outcomes).count(False) >= self.FAILING:
                leaving.append((p, "its model keeps failing"))
            elif now >= self.BOOKED_FROM and m.yellows.get(p.id):
                leaving.append((p, "on a yellow card"))
        for at in self.SCHEDULE:  # one substitution for each scheduled minute passed
            if now < at or at in self._scheduled:
                continue
            self._scheduled.add(at)
            starters = [p for p in ours if p.number <= 11 and p.position != "GK"]
            starters = [p for p in starters if p.id not in {q.id for q, _ in leaving}]
            if starters:
                leaving.append((max(starters, key=lambda p: _slowness(squad, p)), "fresh legs"))
        on_pitch = [situation.models[p.id] for p in m.players if p.team == team]
        for p, reason in leaving:
            sub = next((q for q in bench if q.position == p.position), None)
            if sub is None and p.position != "GK":
                sub = next((q for q in bench if q.position != "GK"), None)
            if sub is None:
                continue
            bench.remove(sub)
            on_pitch.remove(situation.models[p.id])
            model = _quickest(situation.options, on_pitch)
            on_pitch.append(model)
            advice.substitutions.append((p.id, sub.id, model))
            advice.reasons[p.id] = reason
        if now >= self.LATE:
            lead = m.score[team] - m.score[1 - team]
            unit, text = ("FW", "Shoot when you can.") if lead < 0 else ("DF", "Hold your shape and clear danger.")
            staying = [p for p in ours if p.id not in {q.id for q, _ in leaving}]
            if lead != 0:
                for p in staying:
                    if p.position == unit and self._told.get(p.id) != text:
                        self._told[p.id] = text
                        advice.instructions.append((p.id, text))
        return advice

    async def aclose(self) -> None:
        pass


def _quickest(options: tuple[str, ...], taken: list[str | None]) -> str:
    """The model expected to answer a player soonest, given the teammates already on each:
    a model answering one question at a time takes its time once for each of them. The
    bot plays only when there is no model, or every model is expected too slow."""

    def expected(name: str) -> float:
        t = TRAITS[name]
        seconds = UNMEASURED if t.seconds is None else t.seconds
        return seconds * (taken.count(name) + 1) if t.one_at_a_time else seconds

    models = [name for name in options if name != BOT]
    if models:
        best = min(models, key=expected)
        if expected(best) <= SLOWEST_TO_PICK or BOT not in options:
            return best
    return BOT


def _slowness(squad: Players, p: Player) -> tuple:
    """Slower answers first; with equal answers, forwards first, then the higher number."""
    seat = squad.seats.get(p.id)
    median = statistics.median(seat.times) if seat and seat.times else 0.0
    return median, -ORDER.index(p.position), p.number


# -- the language-model manager -------------------------------------------------------------

DEFAULT_MODEL = "gpt-5.4-mini"
ASSISTANT_MODEL = "gpt-5.4-nano"
CHAT = "https://api.openai.com/v1/chat/completions"
CLAUDE_MODEL = "claude-haiku-5-5"  # the manager and its assistants on Anthropic
BRIEF = (
    "You manage a soccer team in a real-time match between decision models. Each of your "
    "players is driven by a decision model that is asked again as soon as its last answer "
    "is applied, so a faster model acts more often. The decision models are the "
    "contestants; the built-in bot is a stand-in that plays by fixed rules. You cannot move "
    "players yourself. Players are named by their id, the number in square brackets."
)
LINEUP = (
    BRIEF + " Before kick-off, choose a model for each of your eleven players from the "
    "models listed, using their stated characteristics. Name every player once."
)
ADVICE = (
    BRIEF + " You are consulted every 15 seconds with a feed of the match. Answer with any "
    "instructions (one short line each, for a player on the pitch; it replaces that "
    "player's previous instruction and the player reads it with its state; bots read "
    "none) and substitutions (a player on the pitch, a substitute on your bench and the "
    "substitute's model, made at the next stoppage within the substitution rules). "
    "Give each substitution a reason of at most ten words. Change things only when it "
    "helps; empty lists are a good answer."
)
ASSISTANTS = (
    "You assist a soccer team's manager. Watch the decision models driving its players: "
    "who answers slowly, who fails, which models are worth more players. In at most two "
    "sentences, tell the manager what you see and what you would change.",
    "You assist a soccer team's manager. Watch the run of play: the score, possession, "
    "fouls, cards and where the team is struggling. In at most two sentences, tell the "
    "manager what you see and what you would change.",
)


class LanguageModel:
    """A manager that asks an LLM on OpenAI's Chat Completions API, with its answer held to
    a JSON schema. The key comes from the environment only and is never shown."""

    assistant = ASSISTANT_MODEL

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        assistants: int = 0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not 0 <= assistants <= len(ASSISTANTS):
            raise ValueError(f"a manager can have up to {len(ASSISTANTS)} assistants")
        self.name, self._model, self._assistants = model, model, ASSISTANTS[:assistants]
        self.assistants = (ASSISTANT_MODEL,) * assistants
        self._key = apis._key("OPENAI_API_KEY", "The OpenAI manager")
        self._http = httpx.AsyncClient(
            transport=transport, headers={"Authorization": f"Bearer {self._key}"}, timeout=30.0
        )

    async def lineup(self, situation: Situation) -> dict[int, str]:
        ids = [p.id for p in situation.match.players if p.team == situation.team]
        schema = _object({"lineup": {"type": "array", "items": _object({
            "player": {"type": "integer", "enum": ids},
            "model": {"type": "string", "enum": list(situation.options)},
        })}})  # fmt: skip
        answer = await self._ask(self._model, LINEUP, situation.feed, schema)
        return {item["player"]: item["model"] for item in answer["lineup"]}

    async def advise(self, situation: Situation) -> Advice:
        feed = situation.feed
        if self._assistants:
            notes = await asyncio.gather(
                *(self._ask(self.assistant, brief, feed) for brief in self._assistants),
                return_exceptions=True,
            )
            heard = [f"Assistant {i + 1}: {note}" for i, note in enumerate(notes) if isinstance(note, str)]
            if heard:
                feed += "\n\n" + "\n".join(heard)
        m, team = situation.match, situation.team
        on_pitch = [p.id for p in m.players if p.team == team]
        bench = [q.id for q in m.bench if q.team == team] or [0]  # an empty enum is no schema
        schema = _object({
            "instructions": {"type": "array", "items": _object({
                "player": {"type": "integer", "enum": on_pitch}, "text": {"type": "string"},
            })},
            "substitutions": {"type": "array", "items": _object({
                "off": {"type": "integer", "enum": on_pitch}, "on": {"type": "integer", "enum": bench},
                "model": {"type": "string", "enum": list(situation.options)},
                "reason": {"type": "string"},
            })},
        })  # fmt: skip
        answer = await self._ask(self._model, ADVICE, feed, schema)
        advice = Advice(
            [(i["player"], i["text"]) for i in answer["instructions"]],
            [(s["off"], s["on"], s["model"]) for s in answer["substitutions"]],
        )
        advice.reasons = {s["off"]: s["reason"] for s in answer["substitutions"]}
        return advice

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _ask(self, model: str, system: str, feed: str, schema: dict | None = None):
        """The model's answer to `feed`: an object held to `schema`, or else plain text."""
        request: dict = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": feed}],
            "reasoning_effort": "low",
        }
        if schema:
            request["response_format"] = {
                "type": "json_schema", "json_schema": {"name": "answer", "strict": True, "schema": schema},
            }  # fmt: skip
        response = await self._http.post(CHAT, json=request)
        if not response.is_success:
            raise RuntimeError(f"HTTP {response.status_code}: {apis._detail(response, self._key)}")
        content = response.json()["choices"][0]["message"]["content"]
        return json.loads(content) if schema else content.strip()


class Claude(LanguageModel):
    """A manager that asks Claude on Anthropic's Messages API, with its answer held to a
    JSON schema by structured outputs. The key comes from the environment only and is
    never shown."""

    assistant = CLAUDE_MODEL

    def __init__(
        self,
        model: str = CLAUDE_MODEL,
        assistants: int = 0,
        http_client: anthropic.DefaultAsyncHttpxClient | None = None,
    ) -> None:
        if not 0 <= assistants <= len(ASSISTANTS):
            raise ValueError(f"a manager can have up to {len(ASSISTANTS)} assistants")
        self.name, self._model, self._assistants = model, model, ASSISTANTS[:assistants]
        self._key = apis._key("ANTHROPIC_API_KEY", "The Anthropic manager")
        self._client = anthropic.AsyncAnthropic(api_key=self._key, http_client=http_client, timeout=30.0)

    async def aclose(self) -> None:
        await self._client.close()

    async def _ask(self, model: str, system: str, feed: str, schema: dict | None = None):
        """The model's answer to `feed`: an object held to `schema`, or else plain text."""
        config: dict = {"effort": "low"}
        if schema:
            config["format"] = {"type": "json_schema", "schema": schema}
        try:
            response = await self._client.messages.create(
                model=model, max_tokens=8000, system=system,
                messages=[{"role": "user", "content": feed}], output_config=config,
            )  # fmt: skip
        except anthropic.APIStatusError as exc:
            raise RuntimeError(f"HTTP {exc.status_code}: {apis._detail(exc.response, self._key)}") from None
        content = "".join(block.text for block in response.content if block.type == "text")
        return json.loads(content) if schema else content.strip()


def _object(properties: dict) -> dict:
    return {"type": "object", "properties": properties, "required": list(properties),
            "additionalProperties": False}  # fmt: skip


# -- the staff: consulting both managers during the match ------------------------------------


class Staff:
    """Both teams' managers: their line-ups before kick-off, then a consultation for each
    every CONSULT_EVERY seconds of play, with its advice checked and applied."""

    def __init__(
        self,
        match: Match,
        squad: Players,
        managers: tuple[Manager, Manager],
        options: tuple[dict[str, Model | None], dict[str, Model | None]],
    ) -> None:
        self.match, self.squad, self.managers, self.options = match, squad, managers, options
        self.next = [CONSULT_EVERY, CONSULT_EVERY]  # match time of each team's next consultation
        self.heard: tuple[list[str], list[str]] = ([], [])  # what each feed has not told yet
        self.held = [0, 0]  # steps each team has had the ball
        self.messages: list[dict] = []  # for the page, drained by the server

    def situation(self, team: int, lineup: bool = False) -> Situation:
        return Situation(self.match, self.squad, team, tuple(self.options[team]), self.models(team),
                         self.feed(team, lineup))  # fmt: skip

    def models(self, team: int) -> dict[int, str]:
        """The model each of `team`'s players is on, by the name it is chosen with."""
        names = {id(model): name for name, model in self.options[team].items()}
        return {
            p.id: names.get(id(seat.model), BOT) if (seat := self.squad.seats.get(p.id)) else BOT
            for p in self.match.everyone.values()
            if p.team == team
        }

    async def line_up(self) -> None:
        """Ask both managers for their line-ups and seat each player on its model. A line-up
        that fails, or misses a player, is completed by the built-in manager's."""
        answers = await asyncio.gather(
            *(manager.lineup(self.situation(team, True)) for team, manager in enumerate(self.managers)),
            return_exceptions=True,
        )
        for team, answer in enumerate(answers):
            fallback = await BuiltIn().lineup(self.situation(team))
            chosen = answer if isinstance(answer, dict) else {}
            for pid, name in fallback.items():
                pick = chosen.get(pid)
                self.squad.seat(pid, self.options[team][pick if pick in self.options[team] else name])

    def observe(self, events: list[dict]) -> None:
        """Called after every step with the events it made."""
        m = self.match
        if m.owner is not None:
            self.held[m.player(m.owner).team] += 1
        for event in events:
            if event["kind"] in QUIET:
                continue
            for team in (0, 1):
                self.heard[team].append(_told(m, event, team))

    def due(self, team: int) -> bool:
        m = self.match
        return m.phase not in ("half_time", "full_time") and m.t >= self.next[team]

    async def run(self) -> None:
        """Consult each team's manager whenever it is due, until full time."""

        async def follow(team: int) -> None:
            while self.match.phase != "full_time":
                if self.due(team):
                    await self.consult(team)
                else:
                    await asyncio.sleep(0.1)

        await asyncio.gather(follow(0), follow(1))

    async def consult(self, team: int) -> None:
        situation = self.situation(team)
        self.heard[team].clear()
        try:
            advice = await self.managers[team].advise(situation)
        except Exception as exc:  # noqa: BLE001 - a failed consultation changes nothing
            self.heard[team].append(f"Your last consultation failed ({_failure(exc)}).")
        else:
            self.apply(team, advice)
        self.next[team] = self.match.t + CONSULT_EVERY

    def apply(self, team: int, advice: Advice) -> None:
        """Make the advice that keeps to the rules; tell the manager why the rest was not."""
        m, squad = self.match, self.squad
        for off, on, model in advice.substitutions:
            p, q = m.everyone.get(off), m.everyone.get(on)
            if p is None or p.team != team or model not in self.options[team]:
                refused = "that is not your player or model"
            else:
                refused = m.substitute(off, on)
            if refused:
                self.heard[team].append(f"Substitution of [{on}] for [{off}] refused: {refused}.")
                continue
            squad.seat(on, self.options[team][model])
            text = f"{q.name} ({TRAITS[model].label}) to come on for {p.name}"
            if reason := _cut(advice.reasons.get(off, "")):
                text += f": {reason}"
            self.messages.append({"type": "manager", "team": team, "kind": "substitution",
                                  "off": off, "on": on, "model": model, "text": text})  # fmt: skip
        for pid, text in advice.instructions:
            p = m.everyone.get(pid)
            text = _cut(text)
            if p is None or p.team != team or p not in m.players or not text:
                continue
            squad.instruct(pid, text)
            self.messages.append({"type": "manager", "team": team, "kind": "instruction",
                                  "player": pid, "text": text})  # fmt: skip

    def drain(self) -> list[dict]:
        messages, self.messages = self.messages, []
        return messages

    async def aclose(self) -> None:
        for manager in self.managers:
            await manager.aclose()

    def feed(self, team: int, lineup: bool = False) -> str:
        """The match from `team`'s side, as its manager reads it; before kick-off, for its
        line-up, only the players and the models."""
        m, squad = self.match, self.squad
        ours, theirs = m.teams[team].name, m.teams[1 - team].name
        half = "1st" if m.period == 1 else "2nd"
        phase = "play is on" if m.phase == "play" else m.phase.replace("_", " ")
        total = sum(self.held) or 1
        lines = [
            f"You manage {ours}. {m.clock()}, {half} half, {ours} {m.score[team]}-{m.score[1 - team]} "
            f"{theirs}; {phase}. Possession so far: {ours} {round(100 * self.held[team] / total)}%.",
        ]
        if lineup:
            lines = [f"You manage {ours} against {theirs}. Kick-off is next. Your players:"]
            lines.extend(f"- [{p.id}] {p.name}, {POSITIONS[p.position]}" for p in m.players if p.team == team)
            lines.append("Models you may choose from:")
            lines.extend(f"- {describe(name)}" for name in self.options[team])
            return "\n".join(lines)
        if self.heard[team]:
            lines.append("Since you last looked: " + " ".join(self.heard[team]))
        lines.append("Your players ([id] name, position: model, answers, median answer time "
                     "of the last ten, failed answers, current action, your instruction):")  # fmt: skip
        models = self.models(team)
        for p in (p for p in m.players if p.team == team):
            seat = squad.seats.get(p.id)
            if seat is None:
                line = f"{BOT}{_booked(m, p)}"
            else:
                median = f"{statistics.median(seat.times):.2f} s" if seat.times else "no answer yet"
                line = (f"{models[p.id]}, {seat.answers} answers, {median}, {seat.failures} failed, "
                        f"doing {seat.action}{_booked(m, p)}"
                        + (f", told: {seat.instruction}" if seat.instruction else ""))  # fmt: skip
            lines.append(f"- [{p.id}] {p.name}, {POSITIONS[p.position]}: {line}")
        bench = [q for q in m.bench if q.team == team]
        lines.append("Your bench: " + ("; ".join(f"[{q.id}] {q.name}, {POSITIONS[q.position]}"
                                                 for q in bench) or "empty") + ".")  # fmt: skip
        waiting = [f"{m.player(on).name} for {m.player(off).name}" for off, on in m.pending
                   if m.player(off).team == team]  # fmt: skip
        lines.append(
            f"Substitutions: {m.substitutions[team]} of 5 made, in {m.windows[team]} of 3 stoppages"
            " (half time not counted)" + (f"; waiting for a stoppage: {', '.join(waiting)}" if waiting else "")
            + ". A substitute takes the place and position of the player it replaces."
        )
        lines.append("Models you may choose from:")
        lines.extend(f"- {describe(name)}" for name in self.options[team])
        return "\n".join(lines)


def _cut(text: str) -> str:
    """`text` on one line, cut at a word to at most INSTRUCTION_LENGTH characters."""
    text = " ".join(text.split())
    if len(text) > INSTRUCTION_LENGTH:
        text = text[: INSTRUCTION_LENGTH + 1].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return text


def _booked(m: Match, p: Player) -> str:
    return ", on a yellow card" if m.yellows.get(p.id) else ""


def _told(m: Match, event: dict, team: int) -> str:
    """One event in the words a manager reads it, from its team's side."""
    kind, side = event["kind"], event["team"]
    who = "" if side is None else ("you" if side == team else m.teams[side].name)
    name = m.player(event["player"]).name if "player" in event else None
    if kind == "goal":
        told = f"goal, {who} ({name})"
    elif kind == "foul":
        told = f"foul by {name} on {m.player(event['fouled']).name}, free kick to {who}"
    elif kind in ("yellow", "red"):
        told = f"{kind} card for {name} ({who})"
    elif kind == "substitution":
        told = f"substitution, {who}: {m.player(event['on']).name} on for {m.player(event['off']).name}"
    elif kind == "offside":
        told = f"offside, {name}"
    elif kind in RESTARTS:
        told = f"{kind.replace('_', ' ')} to {who}"
    else:
        told = kind.replace("_", " ")
    return f"{m.clock()} {told}."


def _failure(exc: Exception) -> str:
    text = str(exc)
    return text[:120] if isinstance(exc, RuntimeError) and text.startswith("HTTP ") else type(exc).__name__

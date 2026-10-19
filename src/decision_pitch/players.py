"""Who drives each player, and the real-time loop that asks each player's decision model.

Every model-driven player has its own loop: build its state, ask its model, apply the
answer as soon as it arrives, ask again. Each has at most one question in flight, and the
match never waits: until a new answer arrives the player keeps carrying out its last one.
Players without a model are played by the built-in bot."""

from __future__ import annotations

import asyncio
import shutil
import time
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from decision_pitch import actions, bots, vision
from decision_pitch.arena import apis, local
from decision_pitch.arena.apis import MissingKey
from decision_pitch.arena.models import Answer, Model, Question
from decision_pitch.match import Command, Match

FAILURE_WAIT = 0.5  # s before asking again after a failed answer
BOT = "bot"

# Decision Arena's text and image adapters, using the same request formats.
APIS: dict[str, Callable[[], apis.DecisionAPI]] = {
    "jev": apis.jev,
    "openai": apis.openai,
    "perplexity": apis.perplexity,
    "aplomb": apis.aplomb,
    "microsoft": apis.microsoft,
    "liquid": apis.liquid,
    "clef": apis.clef,
    "openai-image": lambda: apis.openai(image=True),
    "perplexity-image": lambda: apis.perplexity(image=True),
    "aplomb-image": lambda: apis.aplomb(image=True),
    "clef-image": lambda: apis.clef(image=True),
}
LOCAL: dict[str, Callable[[], apis.DecisionAPI]] = {"laya": local.laya, "d1": local.d1}
NAMES = (*LOCAL, *APIS)
PROBE = Question("Decision Pitch is starting.", {"yes": "it is", "no": "it is not"}, "Is this a test?")


class OneAtATime:
    """A local model server answers one question at a time; asked several at once it
    answers each more slowly and fewer in all. This queues the questions in the order
    they are asked, so each waits its turn here instead."""

    def __init__(self, model: apis.DecisionAPI) -> None:
        self.model, self.name = model, model.name
        self._turn = asyncio.Lock()

    async def decide(self, question: Question, match: Match | None = None) -> Answer:
        while True:
            async with self._turn:
                if match is None or not match.paused:
                    return await self.model.decide(question)
            await asyncio.sleep(0.1)


@dataclass
class Seat:
    """A model-driven player: its model, the action it is carrying out, its model's most
    recent answer time and its manager's instruction, with how its recent answers went
    for the manager's feed."""

    model: Model
    action: str = "hold"
    answer: float | None = None  # seconds
    instruction: str | None = None
    answers: int = 0  # answers applied so far
    command: Command | None = None  # the command last given for its action
    commanded: int = 0  # how many answers had been applied when it was given
    times: deque = field(default_factory=lambda: deque(maxlen=10))  # recent answer times, s
    outcomes: deque = field(default_factory=lambda: deque(maxlen=5))  # recent answers: True if usable
    failures: int = 0
    late: Counter = field(default_factory=Counter)


class Players:
    """The match's players: a seat for each one driven by a model, bots for the rest."""

    def __init__(self, match: Match, models: dict[int, Model] | None = None) -> None:
        self.match = match
        self.seats = {pid: Seat(model) for pid, model in (models or {}).items()}
        self.decisions: list[dict] = []  # for the page, drained by the server
        self._loops: dict[int, asyncio.Task] | None = None  # while running

    def seat(self, player_id: int, model: Model | None) -> None:
        """Drive `player_id` with `model` from now on, or with the bot if None. A substitute
        seated before it comes on starts asking once it is on."""
        if self._loops is not None and player_id in self._loops:
            self._loops.pop(player_id).cancel()
        if model is None:
            self.seats.pop(player_id, None)
            return
        self.seats[player_id] = Seat(model)
        if self._loops is not None:
            self._loops[player_id] = asyncio.create_task(self._ask(player_id))

    def instruct(self, player_id: int, text: str) -> None:
        """Give a model-driven player its manager's instruction; a bot reads none."""
        if seat := self.seats.get(player_id):
            seat.instruction = text

    def model_name(self, player_id: int) -> str | None:
        seat = self.seats.get(player_id)
        return seat.model.name if seat else None

    def play(self) -> None:
        """Give every player its command for this step."""
        m = self.match
        for p in m.players:
            seat = self.seats.get(p.id)
            if seat is None:
                m.command(p.id, bots.command(m, p))
                continue
            # Once the kick is made, the engine replaces the kick command and the kicker
            # recovers. If no answer has arrived since that command was given, the kick was
            # this action: it is done.
            replaced = seat.command is not None and m.commands[p.id] is not seat.command
            kicked = replaced and p.id in m.recovering
            if kicked and seat.action in actions.KICKS and seat.answers == seat.commanded:
                seat.action = "hold"
            seat.command, seat.commanded = actions.command(m, p, seat.action), seat.answers
            m.command(p.id, seat.command)

    def drain_decisions(self) -> list[dict]:
        decisions, self.decisions = self.decisions, []
        return decisions

    async def run(self) -> None:
        """Ask every seated player's model, each in its own loop, until full time. A
        player seated while this runs gets its own loop too."""
        self._loops = {pid: asyncio.create_task(self._ask(pid)) for pid in self.seats}
        try:
            while self.match.phase != "full_time":
                await asyncio.sleep(0.25)
                for loop in list(self._loops.values()):
                    if loop.done() and not loop.cancelled():
                        loop.result()  # a loop that crashed fails the match loudly
        finally:
            for loop in self._loops.values():
                loop.cancel()

    async def _ask(self, player_id: int) -> None:
        m, seat = self.match, self.seats[player_id]
        p = m.player(player_id)
        while m.phase != "full_time" and (p in m.players or p in m.bench):  # until it leaves
            if m.paused or m.phase == "half_time" or p in m.bench:
                await asyncio.sleep(0.1)
                continue
            question = question_for(m, p, seat.model, seat.action, seat.answer, seat.instruction)
            asked, had_ball = m.t, m.owner == p.id
            start = time.perf_counter()
            try:
                answer = await seat.model.decide(question, m) if isinstance(seat.model, OneAtATime) else await seat.model.decide(question)
            except Exception as exc:  # noqa: BLE001 - any failure: wait, then ask again
                ms = round((time.perf_counter() - start) * 1000)
                seat.outcomes.append(False)
                seat.failures += 1
                self.decisions.append(_decision(player_id, seat, ms, error=_error(exc)))
                await asyncio.sleep(FAILURE_WAIT)
                continue
            latency = time.perf_counter() - start
            while m.paused:
                await asyncio.sleep(0.1)
            seat.answer = latency
            note = _late(m, p, answer.move, asked, had_ball)
            if note:
                seat.late[note] += 1
            seat.action = "hold" if note == "already played" else answer.move
            seat.answers += 1
            seat.times.append(seat.answer)
            seat.outcomes.append(True)
            self.decisions.append(_decision(player_id, seat, round(seat.answer * 1000), action=answer.move, note=note))


def question_for(match, player, model, action="hold", answer=None, instruction=None) -> Question:
    """The same state and image format for live players and off-pitch measurements."""
    question = actions.question(match, player, action, answer, instruction)
    if getattr(model, "image", None):
        question = replace(question, image=vision.overhead(match, player), state=question.state +
                           " Image: yellow ring and YOU mark you; names and shirt numbers identify players. "
                           "Your team attacks right. White dot is the ball; arrows show movement.")
    return question


def _error(exc: Exception) -> str:
    """What went wrong, safe to show. The adapters' own messages have the key taken out;
    any other error is named only by its type, since its text can carry a request header."""
    text = str(exc)
    if isinstance(exc, (RuntimeError, ValueError)) and text.startswith(("HTTP ", "unusable answer")):
        return text[:120]
    return type(exc).__name__


def _late(m: Match, p, action: str, asked: float, had_ball: bool) -> str | None:
    """Whether an answer for the ball came too late for it: "already played" if the player
    passed, shot or cleared the ball itself since it was asked, "no ball" if it is carried out
    without the ball (docs/decisions.md, section 4), else None."""
    if m.phase != "play" or m.owner == p.id or action not in actions.ON_THE_BALL or action == "sprint":
        return None
    if had_ball and m.kicked.get(p.id, -1.0) >= asked:
        return "already played"
    return "no ball"


def _decision(
    player_id: int, seat: Seat, ms: int, error: str | None = None, action: str | None = None,
    note: str | None = None,
) -> dict:
    decision = {"type": "decision", "player": player_id, "model": seat.model.name, "ms": ms}
    if error is None:
        decision["action"] = action or seat.action
        if note:
            decision["note"] = note
    else:
        decision["error"] = error
    return decision


# -- which models can play --------------------------------------------------------------


async def available(names=None) -> dict[str, str | None]:
    """Every model by name, with None if it can play here or else what to check. Each API
    model whose key is set is asked one question, so a wrong key shows up at startup."""
    reasons: dict[str, str | None] = {BOT: None}
    reasons["laya"] = None if local.engine_python() else f"Laya needs its engine: {local.INSTALL}"
    reasons["d1"] = None if shutil.which("llama-server") else f"d1-3B needs llama-server: {local.D1_INSTALL}"

    async def probe(name: str) -> str | None:
        try:
            model = APIS[name]()
        except MissingKey as exc:
            return str(exc)
        try:
            question = PROBE
            if model.image:
                match = Match()
                question = replace(PROBE, image=vision.overhead(match, match.player(7)))
            await model.decide(question)
            return None
        except Exception as exc:  # noqa: BLE001 - any failure: name the key to check
            return f"{model.name} did not answer ({_error(exc)[:80]}); check {model.key_name}"
        finally:
            await model.aclose()

    selected = [name for name in APIS if names is None or name in names]
    answers = await asyncio.gather(*(probe(name) for name in selected))
    return reasons | dict(zip(selected, answers, strict=True))


def start(name: str) -> Model:
    """A model ready to play: local servers are started and answer one question at a time."""
    if name in LOCAL:
        return OneAtATime(LOCAL[name]())
    model = APIS[name]()
    labels = {"openai": "GPT-6 Luna", "perplexity": "Perplexity Decider", "aplomb": "Aplomb 1",
              "clef": "Clef-flash", "microsoft": "Microsoft Decision-1", "liquid": "Liquid D1"}
    base = name.removesuffix("-image")
    model.name = labels.get(base, model.name) + (" image" if name.endswith("-image") else "")
    return model

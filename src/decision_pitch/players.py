"""Who drives each player, and the real-time loop that asks each player's decision model.

Every model-driven player has its own loop: build its state, ask its model, apply the
answer as soon as it arrives, ask again. Each has at most one question in flight, and the
match never waits: until a new answer arrives the player keeps carrying out its last one.
Players without a model are played by the built-in bot."""

from __future__ import annotations

import asyncio
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass

from decision_pitch import actions, bots
from decision_pitch.arena import apis, local
from decision_pitch.arena.apis import MissingKey
from decision_pitch.arena.models import Answer, Model, Question
from decision_pitch.match import Match

FAILURE_WAIT = 0.5  # s before asking again after a failed answer
BOT = "bot"

# Decision Arena's models, by the name they are chosen with. Image twins are left out: the
# match has no picture to send.
APIS: dict[str, Callable[[], apis.DecisionAPI]] = {
    "jev": apis.jev,
    "openai": apis.openai,
    "perplexity": apis.perplexity,
    "aplomb": apis.aplomb,
    "microsoft": apis.microsoft,
    "liquid": apis.liquid,
    "clef": apis.clef,
}
LOCAL: dict[str, Callable[[], apis.DecisionAPI]] = {"laya": local.laya, "d1": local.d1}
NAMES = (BOT, *LOCAL, *APIS)
PROBE = Question("Decision Pitch is starting.", {"yes": "it is", "no": "it is not"}, "Is this a test?")


class OneAtATime:
    """A local model server answers one question at a time; asked several at once it
    answers each more slowly and fewer in all. This queues the questions in the order
    they are asked, so each waits its turn here instead."""

    def __init__(self, model: apis.DecisionAPI) -> None:
        self.model, self.name = model, model.name
        self._turn = asyncio.Lock()

    async def decide(self, question: Question) -> Answer:
        async with self._turn:
            return await self.model.decide(question)


@dataclass
class Seat:
    """A model-driven player: its model, the action it is carrying out, its model's most
    recent answer time and its manager's instruction."""

    model: Model
    action: str = "hold"
    answer: float | None = None  # seconds
    instruction: str | None = None


class Players:
    """The match's players: a seat for each one driven by a model, bots for the rest."""

    def __init__(self, match: Match, models: dict[int, Model] | None = None) -> None:
        self.match = match
        self.seats = {pid: Seat(model) for pid, model in (models or {}).items()}
        self.decisions: list[dict] = []  # for the page, drained by the server

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
            if seat.action in actions.KICKS and p.id in m.recovering:
                seat.action = "hold"  # the ball is kicked: the action is done
            m.command(p.id, actions.command(m, p, seat.action))

    def drain_decisions(self) -> list[dict]:
        decisions, self.decisions = self.decisions, []
        return decisions

    async def run(self) -> None:
        """Ask every seated player's model, each in its own loop, until full time."""
        loops = [asyncio.create_task(self._ask(pid)) for pid in self.seats]
        try:
            await asyncio.gather(*loops)
        finally:
            for loop in loops:
                loop.cancel()

    async def _ask(self, player_id: int) -> None:
        m, seat = self.match, self.seats[player_id]
        p = m.player(player_id)
        while m.phase != "full_time":
            if m.phase == "half_time":
                await asyncio.sleep(0.1)
                continue
            question = actions.question(m, p, seat.action, seat.answer, seat.instruction)
            start = time.perf_counter()
            try:
                answer = await seat.model.decide(question)
            except Exception as exc:  # noqa: BLE001 - any failure: wait, then ask again
                ms = round((time.perf_counter() - start) * 1000)
                error = str(exc)[:120] or type(exc).__name__
                self.decisions.append(_decision(player_id, seat, ms, error=error))
                await asyncio.sleep(FAILURE_WAIT)
                continue
            seat.answer = time.perf_counter() - start
            seat.action = answer.move
            self.decisions.append(_decision(player_id, seat, round(seat.answer * 1000)))


def _decision(player_id: int, seat: Seat, ms: int, error: str | None = None) -> dict:
    decision = {"type": "decision", "player": player_id, "model": seat.model.name, "ms": ms}
    if error is None:
        decision["action"] = seat.action
    else:
        decision["error"] = error
    return decision


# -- which models can play --------------------------------------------------------------


async def available() -> dict[str, str | None]:
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
            await model.decide(PROBE)
            return None
        except Exception as exc:  # noqa: BLE001 - any failure: name the key to check
            return f"{model.name} did not answer ({str(exc)[:80] or type(exc).__name__}); check {model.key_name}"
        finally:
            await model.aclose()

    answers = await asyncio.gather(*(probe(name) for name in APIS))
    return reasons | dict(zip(APIS, answers, strict=True))


def start(name: str) -> Model:
    """A model ready to play: local servers are started and answer one question at a time."""
    if name in LOCAL:
        return OneAtATime(LOCAL[name]())
    return APIS[name]()

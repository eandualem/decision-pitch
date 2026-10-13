# Copied from Decision Arena (https://github.com/eandualem/decision-arena), commit 770bb4a,
# src/decision_arena/models.py, under the MIT licence in LICENSE beside this file. Changes:
# only the question and answer types and the model protocol are kept; the runner's moves
# and question text are left out, and the instructions have no default.

"""Decision models: one async method that turns a question into a move."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Question:
    state: str
    options: dict[str, str]
    instructions: str
    image: str | None = None  # a JPEG data URI, for an image twin


@dataclass(frozen=True)
class Answer:
    move: str  # one of the question's options
    probabilities: dict[str, float]  # each option's probability, as the model gave them


class Model(Protocol):
    name: str

    async def decide(self, question: Question) -> Answer: ...

# Copied from Decision Arena (https://github.com/eandualem/decision-arena), commit 770bb4a,
# src/decision_arena/apis.py, under the MIT licence in LICENSE beside this file. Changes:
# imports from this package; an answer is checked against the question's own options
# instead of the runner's fixed five moves.

"""Decision models behind an HTTP API: Jev at TypeSafe, OpenAI's and Perplexity's Decisions
APIs, Cloudflare's Clef, EmpirioLabs' Aplomb, and Microsoft's and Liquid's through Vercel's
AI Gateway. OpenAI, Perplexity, Clef and Aplomb also race as image twins, which get a picture
of their runner's view with the question; each API takes the picture its own way.

They take the request shape Entune uses (TypeSafe's System One API): a shared `state`,
and named choice questions whose options are described in text. OpenAI takes the same
question as a list. Each answers with a choice and a probability for every option.
There are no retries: the runner asks again.
"""

from __future__ import annotations

import math
import os
import re
from typing import Any

import httpx

from decision_pitch.arena.models import Answer, Question

QUESTION = "move"  # the one question asked each time


class MissingKey(Exception):
    """The model's API key is not in the environment."""


class DecisionAPI:
    def __init__(
        self,
        name: str,
        url: str,
        model: str,
        key: str,
        shape: str = "systemone",  # or "openai"
        transport: httpx.AsyncBaseTransport | None = None,
        local: bool = False,  # on this computer: reached directly, never through a proxy
        key_name: str | None = None,  # where the key comes from, to say which one failed
        image: str | None = None,  # an image twin: how this API takes the picture (see _with_image)
    ) -> None:
        self.name, self._url, self._model, self._shape = name, url, model, shape
        self.key_name = key_name
        self.image = image
        self._key = key
        self._http = httpx.AsyncClient(
            transport=transport,
            headers={"Authorization": f"Bearer {key}"},
            timeout=5.0,  # as Entune: a slower answer is too late to matter
            trust_env=not local,
        )

    async def decide(self, question: Question) -> Answer:
        response = await self._http.post(self._url, json=self._request(question))
        if not response.is_success:
            raise RuntimeError(f"HTTP {response.status_code}: {_detail(response, self._key)}")
        return _answer(response.json(), self._shape, tuple(question.options))

    async def aclose(self) -> None:
        await self._http.aclose()

    def _request(self, question: Question) -> dict[str, Any]:
        request = self._text_request(question)
        if self.image and question.image:
            _with_image(request, self.image, question.image)
        return request

    def _text_request(self, question: Question) -> dict[str, Any]:
        if self._shape == "openai":
            return {
                "model": self._model,
                "input": question.state,
                "questions": [
                    {
                        "type": "choice",
                        "name": QUESTION,
                        "instructions": question.instructions,
                        "choices": [
                            {"value": move, "description": text}
                            for move, text in question.options.items()
                        ],
                    }
                ],
            }
        return {
            "model": self._model,
            "state": question.state,
            "questions": {
                QUESTION: {
                    "type": "choice",
                    "instructions": question.instructions,
                    "criteria": question.options,
                }
            },
        }


def _with_image(request: dict[str, Any], how: str, image: str) -> None:
    """Add the picture (a data URI) the way each API reads it, all checked against a test
    picture: OpenAI, a user message with the text and the image; Perplexity, an image part
    after the text in `state`; Clef, an `images` list; Aplomb, an image node in `state`."""
    text = request.pop("input") if how == "message" else request["state"]
    if how == "message":
        request["input"] = [
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": text},
                    {"type": "input_image", "image_url": image},
                ],
            }
        ]
    elif how == "part":
        request["state"] = [text, {"type": "image_url", "image_url": {"url": image}}]
    elif how == "images":
        request["images"] = [image]
    elif how == "node":
        mime, data = image.removeprefix("data:").split(";base64,", 1)
        request["state"] = [text, {"type": "image", "data": data, "mime": mime}]


def _detail(response: httpx.Response, key: str) -> str:
    """What went wrong, short enough to show, with the key and anything like one (a masked
    key an API echoes back) taken out."""
    try:
        error = response.json().get("error")
        text = error.get("message") if isinstance(error, dict) else error
    except (ValueError, AttributeError):
        text = None
    text = str(text or response.text).replace(key, "")
    return re.sub(r"\b[a-z]{2,8}-[\w*-]{6,}", "[key]", text).strip()[:120]


def _answer(data: Any, shape: str, moves: tuple[str, ...]) -> Answer:
    """The validated choice and probabilities, one for each of `moves`. Jev rounds each
    probability to two decimals, so five can sum to 0.98, as Entune allows; anything
    unusable raises, and the player asks again."""
    if isinstance(data, dict) and isinstance(data.get("result"), dict):
        data = data["result"]  # Cloudflare wraps its answer
    answers = data.get("answers") if isinstance(data, dict) else None
    if shape == "openai" and isinstance(answers, list):
        answers = {
            a.get("name"): {
                "choice": a.get("choice"),
                "probabilities": {
                    p.get("value"): p.get("probability")
                    for p in a.get("probabilities") or []
                    if isinstance(p, dict)
                },
            }
            for a in answers
            if isinstance(a, dict)
        }
    answer = answers.get(QUESTION) if isinstance(answers, dict) else None
    if not isinstance(answer, dict):
        raise ValueError("unusable answer: no answer to the move question")
    probabilities = answer.get("probabilities")
    choice = answer.get("choice")
    if (
        not isinstance(probabilities, dict)
        or set(probabilities) != set(moves)
        or not all(
            type(p) in (int, float) and math.isfinite(p) and 0 <= p <= 1
            for p in probabilities.values()
        )
        or not math.isclose(sum(probabilities.values()), 1.0, abs_tol=0.005 * len(moves))
        or choice not in moves
    ):
        raise ValueError("unusable answer: choice or probabilities malformed")
    return Answer(choice, {m: float(probabilities[m]) for m in moves})


def _key(variable: str, name: str) -> str:
    key = os.environ.get(variable, "").strip()
    if not key:
        raise MissingKey(f"{name} needs {variable}: set it in .env or in your shell")
    return key


def _api(
    name: str, url: str, model: str, variable: str, shape: str = "systemone",
    image: str | None = None,
) -> DecisionAPI:
    if image:
        name += " image"
    return DecisionAPI(name, url, model, _key(variable, name), shape, key_name=variable, image=image)


def jev() -> DecisionAPI:
    return _api("Jev", "https://api.typesafe.ai/v1/systemone", "jev-1.13.0", "TYPESAFE_API_KEY")


def openai(image: bool = False) -> DecisionAPI:
    return _api(
        "OpenAI", "https://api.openai.com/v1/decisions", "gpt-6-luna", "OPENAI_API_KEY", "openai",
        "message" if image else None,
    )


def perplexity(image: bool = False) -> DecisionAPI:
    return _api(
        "Perplexity",
        "https://api.perplexity.ai/v1/decisions",
        "pplx-decider-v1.1-27b",
        "PERPLEXITY_API_KEY",
        image="part" if image else None,
    )


def aplomb(image: bool = False) -> DecisionAPI:
    """EmpirioLabs' Aplomb 1, which takes Jev's request shape."""
    return _api(
        "Aplomb",
        "https://api.empiriolabs.ai/v1/decisions",
        "aplomb-1",
        "EMPIRIO_LABS_API_KEY",
        image="node" if image else None,
    )


# Vercel's AI Gateway reaches many decision models with one key, in OpenAI's shape.
GATEWAY = "https://ai-gateway.vercel.sh/v1/decisions"


def microsoft() -> DecisionAPI:
    return _api(
        "Microsoft", GATEWAY, "microsoft/microsoft-decision-1", "AI_GATEWAY_API_KEY", "openai"
    )


def liquid() -> DecisionAPI:
    return _api("Liquid", GATEWAY, "liquid/d1", "AI_GATEWAY_API_KEY", "openai")


def clef(image: bool = False) -> DecisionAPI:
    """Cloudflare's Clef-flash, its fast decision model, on Workers AI."""
    account = _key("CLOUDFLARE_ACCOUNT_ID", "Clef")
    return _api(
        "Clef",
        f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef-flash",
        "clef-flash",
        "CLOUDFLARE_AUTH_TOKEN",
        image="images" if image else None,
    )

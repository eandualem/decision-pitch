"""The command: serve the match page on this computer, open it in the browser, and stream
the match to it over one WebSocket."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import math
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from starlette.applications import Starlette
from starlette.routing import Mount, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from decision_pitch import bots, pitch, players
from decision_pitch.arena.models import Model
from decision_pitch.match import Match
from decision_pitch.players import Players
from decision_pitch.physics import STEP

WEB = Path(__file__).parent / "web"

# The pitch in metres, as docs/protocol.md describes it.
PITCH = {
    "length": pitch.LENGTH,
    "width": pitch.WIDTH,
    "goalWidth": pitch.GOAL_WIDTH,
    "goalHeight": pitch.GOAL_HEIGHT,
}
VERSION = 1
SNAPSHOT_EVERY = 2  # physics steps per snapshot: 30 a second


def hello(match: Match, squad: Players | None = None) -> dict:
    """The first message on every connection: what the page needs before the first snapshot."""
    teams = match.hello_teams()
    if squad:
        for team in teams:
            for player in team["players"]:
                player["model"] = squad.model_name(player["id"])
    return {"type": "hello", "version": VERSION, "pitch": PITCH, "teams": teams}


async def run(match: Match, send, squad: Players | None = None) -> None:
    """Play `match` in real time, sending snapshots, events and decisions. Players with a
    model in `squad` are asked in their own loops; the rest are played by bots."""
    squad = squad or Players(match)
    asking = asyncio.create_task(squad.run())
    loop = asyncio.get_running_loop()
    due = loop.time()
    steps = 0
    try:
        while match.phase != "full_time":
            squad.play()
            match.step()
            steps += 1
            for message in [*match.drain_events(), *squad.drain_decisions()]:
                await send(message)
            if steps % SNAPSHOT_EVERY == 0 or match.phase == "full_time":
                await send(match.snapshot())
            due += STEP
            await asyncio.sleep(max(0.0, due - loop.time()))
    finally:
        asking.cancel()


def seat(match: Match, home: Model | None, away: Model | None) -> Players:
    """Each team's players on its model, or on bots where it has none."""
    models = {p.id: (home, away)[p.team] for p in match.players}
    return Players(match, {pid: model for pid, model in models.items() if model is not None})


def app(
    half_length: float = 180.0, home: Model | None = None, away: Model | None = None
) -> Starlette:
    """The page and the socket the match is streamed over. Each page that connects watches
    a new match, with halves of `half_length` seconds, each team played by its model or by
    bots."""

    async def socket(websocket: WebSocket) -> None:
        # Only this page may connect: the socket will carry model decisions, and any other
        # site open in the browser could otherwise read them. The host must be this computer
        # too, so a renamed host cannot pass.
        host, origin = websocket.headers.get("host", ""), websocket.headers.get("origin")
        if host.rsplit(":", 1)[0] not in ("127.0.0.1", "localhost") or (
            origin is not None and origin != f"http://{host}"
        ):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        match = Match(half_length=half_length)
        squad = seat(match, home, away)
        await websocket.send_text(json.dumps(hello(match, squad)))

        async def send(message: dict) -> None:
            await websocket.send_text(json.dumps(message))

        playing = asyncio.create_task(run(match, send, squad))
        try:
            with contextlib.suppress(WebSocketDisconnect):
                while True:
                    await websocket.receive_text()
        finally:
            playing.cancel()

    return Starlette(
        routes=[
            WebSocketRoute("/ws", socket),
            Mount("/", StaticFiles(directory=WEB, html=True)),
        ]
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="decision-pitch", description="Decision models play a real-time 3D soccer match."
    )
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="don't open the page")
    parser.add_argument(
        "--half-length", type=_seconds, default=180.0, help="seconds per half (default: 180)"
    )
    parser.add_argument(
        "--headless", action="store_true", help="play one match as fast as it runs and print it"
    )
    parser.add_argument("--seed", type=int, default=0, help="for --headless")
    for team in ("home", "away"):
        parser.add_argument(
            f"--{team}", type=str.lower, choices=players.NAMES, default=players.BOT,
            help=f"the {team} team's decision model (default: bot)",
        )
    args = parser.parse_args(argv)
    # API keys from .env in the current folder; a variable already set in the shell wins
    load_dotenv(Path.cwd() / ".env", override=False)
    home, away = _models(parser, args.home, args.away)
    if args.headless:
        match = Match(half_length=args.half_length, seed=args.seed)
        if home is None and away is None:
            headless(match)
        else:
            asyncio.run(headless_live(match, seat(match, home, away)))
        return
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Decision Pitch at {url}", flush=True)
    server = uvicorn.Server(
        uvicorn.Config(app(args.half_length, home, away), host="127.0.0.1", port=args.port, log_level="warning")
    )
    if not args.no_browser:
        threading.Thread(target=_open_when_listening, args=(server, url), daemon=True).start()
    with contextlib.suppress(KeyboardInterrupt):  # Ctrl+C ends it quietly
        server.run()


def _models(
    parser: argparse.ArgumentParser, home: str, away: str
) -> tuple[Model | None, Model | None]:
    """Check which models can play here, then start the chosen ones. A local model gets
    one server per team, so neither team waits behind the other's questions."""
    reasons = asyncio.run(players.available())
    print("Models: " + ", ".join(name for name, reason in reasons.items() if reason is None), flush=True)
    for name, reason in reasons.items():
        if reason and name in players.APIS and "did not answer" in reason:
            print(f"  {reason}", flush=True)
    for name in {home, away}:
        if reasons[name]:
            parser.error(reasons[name])
    started: dict[str, Model] = {}
    models = []
    for name in (home, away):
        if name == players.BOT:
            models.append(None)
        elif name in players.LOCAL or name not in started:
            started[name] = players.start(name)
            models.append(started[name])
        else:
            models.append(started[name])
    return models[0], models[1]


def _seconds(text: str) -> float:
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a positive number of seconds")
    return value


def headless(match: Match) -> None:
    """Play `match` to full time with bots and print its events and the result."""
    names = [team.name for team in match.teams]
    while match.phase != "full_time":
        bots.play(match)
        match.step()
        for event in match.drain_events():
            team = "" if event["team"] is None else f" {names[event['team']]}"
            print(f"{match.clock()} {event['kind'].replace('_', ' ')}{team}", flush=True)
    print(f"{names[0]} {match.score[0]} - {match.score[1]} {names[1]}", flush=True)


async def headless_live(match: Match, squad: Players) -> None:
    """Play `match` in real time with its models and print its events, then the result and
    how often each model answered."""
    names = [team.name for team in match.teams]
    answers: dict[str, list[int]] = {}
    failures: dict[str, int] = {}

    async def send(message: dict) -> None:
        if message["type"] == "event":
            team = "" if message["team"] is None else f" {names[message['team']]}"
            print(f"{match.clock()} {message['kind'].replace('_', ' ')}{team}", flush=True)
        elif message["type"] == "decision":
            if "error" in message:
                failures[message["model"]] = failures.get(message["model"], 0) + 1
            else:
                answers.setdefault(message["model"], []).append(message["ms"])

    await run(match, send, squad)
    print(f"{names[0]} {match.score[0]} - {match.score[1]} {names[1]}", flush=True)
    for model in sorted(set(answers) | set(failures)):
        times = sorted(answers.get(model, []))
        median = f", median {times[len(times) // 2]} ms" if times else ""
        print(f"{model}: {len(times)} answers{median}, {failures.get(model, 0)} failed", flush=True)


def _open_when_listening(server: uvicorn.Server, url: str) -> None:
    while not server.started:
        if server.should_exit:
            return
        time.sleep(0.05)
    webbrowser.open(url)

"""The command: serve the match page on this computer, open it in the browser, and stream
the match to it over one WebSocket."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.routing import Mount, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from decision_pitch import bots, pitch
from decision_pitch.match import Match
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


def hello(match: Match) -> dict:
    """The first message on every connection: what the page needs before the first snapshot."""
    return {"type": "hello", "version": VERSION, "pitch": PITCH, "teams": match.hello_teams()}


async def run(match: Match, send) -> None:
    """Play `match` in real time with bots on every player, sending snapshots and events."""
    loop = asyncio.get_running_loop()
    due = loop.time()
    steps = 0
    while match.phase != "full_time":
        bots.play(match)
        match.step()
        steps += 1
        for event in match.drain_events():
            await send(event)
        if steps % SNAPSHOT_EVERY == 0 or match.phase == "full_time":
            await send(match.snapshot())
        due += STEP
        await asyncio.sleep(max(0.0, due - loop.time()))


def app(half_length: float = 180.0) -> Starlette:
    """The page and the socket the match is streamed over. Each page that connects watches
    a new match, with halves of `half_length` seconds."""

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
        await websocket.send_text(json.dumps(hello(match)))

        async def send(message: dict) -> None:
            await websocket.send_text(json.dumps(message))

        playing = asyncio.create_task(run(match, send))
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
        "--half-length", type=float, default=180.0, help="seconds per half (default: 180)"
    )
    parser.add_argument(
        "--headless", action="store_true", help="play one match as fast as it runs and print it"
    )
    parser.add_argument("--seed", type=int, default=0, help="for --headless")
    args = parser.parse_args(argv)
    if args.headless:
        headless(Match(half_length=args.half_length, seed=args.seed))
        return
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Decision Pitch at {url}", flush=True)
    server = uvicorn.Server(
        uvicorn.Config(app(args.half_length), host="127.0.0.1", port=args.port, log_level="warning")
    )
    if not args.no_browser:
        threading.Thread(target=_open_when_listening, args=(server, url), daemon=True).start()
    with contextlib.suppress(KeyboardInterrupt):  # Ctrl+C ends it quietly
        server.run()


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


def _open_when_listening(server: uvicorn.Server, url: str) -> None:
    while not server.started:
        if server.should_exit:
            return
        time.sleep(0.05)
    webbrowser.open(url)

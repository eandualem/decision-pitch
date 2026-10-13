"""The command: serve the match page on this computer, open it in the browser, and stream
the match to it over one WebSocket."""

from __future__ import annotations

import argparse
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

WEB = Path(__file__).parent / "web"

# The pitch in metres, as docs/protocol.md describes it.
PITCH = {"length": 105.0, "width": 68.0, "goalWidth": 7.32, "goalHeight": 2.44}
VERSION = 1


def hello() -> dict:
    """The first message on every connection: what the page needs before the first snapshot."""
    return {"type": "hello", "version": VERSION, "pitch": PITCH, "teams": []}


def app() -> Starlette:
    """The page and the socket the match is streamed over."""

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
        await websocket.send_text(json.dumps(hello()))
        with contextlib.suppress(WebSocketDisconnect):
            while True:
                await websocket.receive_text()

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
    args = parser.parse_args(argv)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Decision Pitch at {url}", flush=True)
    server = uvicorn.Server(
        uvicorn.Config(app(), host="127.0.0.1", port=args.port, log_level="warning")
    )
    if not args.no_browser:
        threading.Thread(target=_open_when_listening, args=(server, url), daemon=True).start()
    with contextlib.suppress(KeyboardInterrupt):  # Ctrl+C ends it quietly
        server.run()


def _open_when_listening(server: uvicorn.Server, url: str) -> None:
    while not server.started:
        if server.should_exit:
            return
        time.sleep(0.05)
    webbrowser.open(url)

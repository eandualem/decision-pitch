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

from decision_pitch import managers, pitch, players
from decision_pitch.arena.apis import MissingKey
from decision_pitch.arena.models import Model
from decision_pitch.managers import Manager, Staff
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


def hello(match: Match, squad: Players | None = None, staff: Staff | None = None) -> dict:
    """The first message on every connection: what the page needs before the first snapshot."""
    teams = match.hello_teams()
    if squad:
        for team in teams:
            for player in team["players"]:
                player["model"] = squad.model_name(player["id"])
    if staff:
        for team, manager in zip(teams, staff.managers, strict=True):
            team["manager"] = manager.name
            team["managerEffort"] = getattr(manager, "effort", None)
            team["assistants"] = list(manager.assistants)
    return {"type": "hello", "version": VERSION, "pitch": PITCH, "teams": teams}


async def run(match: Match, send, squad: Players | None = None, staff: Staff | None = None) -> None:
    """Play `match` in real time, sending snapshots, events, decisions and the managers'
    advice. Players with a model in `squad` are asked in their own loops; the rest are
    played by bots. The `staff` consults both managers in its own loop."""
    squad = squad or Players(match)
    asking = asyncio.create_task(squad.run())
    managing = asyncio.create_task(staff.run()) if staff else None
    loop = asyncio.get_running_loop()
    due = loop.time()
    steps = 0
    try:
        while match.phase != "full_time":
            squad.play()
            match.step()
            steps += 1
            events = match.drain_events()
            if staff:
                staff.observe(events)
            for message in [*events, *squad.drain_decisions(), *(staff.drain() if staff else [])]:
                await send(_detailed(message, match, squad))
            if steps % SNAPSHOT_EVERY == 0 or match.phase == "full_time":
                await send(match.snapshot())
            due += STEP
            await asyncio.sleep(max(0.0, due - loop.time()))
    finally:
        asking.cancel()
        if managing:
            managing.cancel()


def _detailed(message: dict, match: Match, squad: Players) -> dict:
    """`message` with what the page shows beyond the engine's event: the incoming player's
    model at a substitution, and the score at the half-time and full-time whistles."""
    if message["type"] == "event":
        if message["kind"] == "substitution":
            message["model"] = squad.model_name(message["on"])
        elif message["kind"] in ("half_time", "full_time"):
            message["score"] = list(match.score)
    return message


def seat(match: Match, home: Model | None, away: Model | None) -> Players:
    """Each team's players on its model, or on bots where it has none."""
    models = {p.id: (home, away)[p.team] for p in match.players}
    return Players(match, {pid: model for pid, model in models.items() if model is not None})


Options = dict[str, Model | None]  # the models a manager may choose from, by name; None: the bot
BOTS: Options = {players.BOT: None}


def app(
    half_length: float = 90.0,
    options: tuple[Options, Options] = (BOTS, BOTS),
    hire: tuple = (managers.BuiltIn, managers.BuiltIn),
) -> Starlette:
    """The page and the socket the match is streamed over. Each page that connects watches
    a new match, with halves of `half_length` seconds, each team's players on the models
    its manager chooses from its `options`. `hire` makes each team's manager."""

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
        squad = Players(match)
        staff = Staff(match, squad, (hire[0](), hire[1]()), options)
        try:
            await staff.line_up()
            await websocket.send_text(json.dumps(hello(match, squad, staff)))

            async def send(message: dict) -> None:
                await websocket.send_text(json.dumps(message))

            playing = asyncio.create_task(run(match, send, squad, staff))
            try:
                with contextlib.suppress(WebSocketDisconnect):
                    while True:
                        await websocket.receive_text()
            finally:
                playing.cancel()
        finally:
            await staff.aclose()

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
        "--half-length", type=_seconds, default=90.0, help="seconds per half (default: 90)"
    )
    parser.add_argument(
        "--headless", action="store_true", help="play one match as fast as it runs and print it"
    )
    parser.add_argument("--seed", type=int, default=0, help="for --headless")
    for team in ("home", "away"):
        parser.add_argument(
            f"--{team}", type=_names, default=(players.BOT,), metavar="MODELS",
            help=f"the models the {team} team's manager may choose from, separated by commas "
            f"(default: bot); available checks all configured API models: {', '.join(players.NAMES)}",
        )
        parser.add_argument(
            f"--{team}-manager", type=_manager, default="builtin", metavar="MANAGER",
            help=f"the {team} team's manager: builtin (default), openai, openai:MODEL, anthropic or anthropic:MODEL",
        )
        parser.add_argument(f"--{team}-effort", choices=("low", "medium", "high"), default="low",
                            help="reasoning effort sent to this team's LLM manager (default: low)")
    parser.add_argument(
        "--assistants", type=int, choices=range(len(managers.ASSISTANTS) + 1), default=0,
        help="assistant models helping each language-model manager (default: 0)",
    )
    args = parser.parse_args(argv)
    # API keys from .env in the current folder; a variable already set in the shell wins
    load_dotenv(Path.cwd() / ".env", override=False)
    hire = tuple(_hire(parser, spec, args.assistants, effort) for spec, effort in
                 ((args.home_manager, args.home_effort), (args.away_manager, args.away_effort)))
    options = _models(parser, args.home, args.away)
    if args.headless:
        match = Match(half_length=args.half_length, seed=args.seed)
        asyncio.run(headless(match, options, hire))
        return
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Decision Pitch at {url}", flush=True)
    server = uvicorn.Server(
        uvicorn.Config(app(args.half_length, options, hire), host="127.0.0.1", port=args.port, log_level="warning")
    )
    if not args.no_browser:
        threading.Thread(target=_open_when_listening, args=(server, url), daemon=True).start()
    with contextlib.suppress(KeyboardInterrupt):  # Ctrl+C ends it quietly
        server.run()


def _names(text: str) -> tuple[str, ...]:
    if text.strip().lower() == "available":
        return ("available",)
    names = tuple(dict.fromkeys(name.strip().lower() for name in text.split(",") if name.strip()))
    if not names or any(name not in players.NAMES for name in names):
        raise argparse.ArgumentTypeError(f"choose from {', '.join(players.NAMES)}")
    return names


def _manager(text: str) -> str:
    if text != "builtin" and text.split(":", 1)[0] not in ("openai", "anthropic"):
        raise argparse.ArgumentTypeError("builtin, openai, openai:MODEL, anthropic or anthropic:MODEL")
    return text


def _hire(parser: argparse.ArgumentParser, spec: str, assistants: int, effort: str = "low"):
    """What makes a team's manager for each match, checked now so a missing key shows at once."""
    if spec == "builtin":
        return managers.BuiltIn
    provider, _, model = spec.partition(":")
    kind = managers.Claude if provider == "anthropic" else managers.LanguageModel
    model = model or (managers.CLAUDE_MODEL if provider == "anthropic" else managers.DEFAULT_MODEL)
    try:
        asyncio.run(kind(model, assistants, effort=effort).aclose())
    except MissingKey as exc:
        parser.error(str(exc))
    return lambda: kind(model, assistants, effort=effort)


def _models(
    parser: argparse.ArgumentParser, home: tuple[str, ...], away: tuple[str, ...]
) -> tuple[Options, Options]:
    """Check which models can play here, then start the ones each manager may choose. A
    local model gets one server per team, so neither team waits behind the other's
    questions; an API model is shared."""
    auto = "available" in (*home, *away)
    reasons = asyncio.run(players.available(None if auto else (*home, *away)))
    offered = tuple(name for name in players.APIS if reasons.get(name) is None) if auto else ()
    if auto and not offered:
        parser.error("no configured API models answered; choose bot or a local model explicitly")
    home = offered if home == ("available",) else home
    away = offered if away == ("available",) else away
    print("Models: " + ", ".join(name for name, reason in reasons.items() if reason is None), flush=True)
    for name, reason in reasons.items():
        if reason and name in players.APIS and "did not answer" in reason:
            print(f"  {reason}", flush=True)
    for name in dict.fromkeys((*home, *away)):
        if reasons[name]:
            parser.error(reasons[name])
    shared: dict[str, Model] = {}
    options: list[Options] = []
    for names in (home, away):
        team: Options = {}
        for name in names:
            if name == players.BOT:
                team[name] = None
            elif name in players.LOCAL:
                team[name] = players.start(name)
            else:
                team[name] = shared.setdefault(name, players.start(name))
        options.append(team)
    return options[0], options[1]


def _seconds(text: str) -> float:
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a positive number of seconds")
    return value


async def headless(match: Match, options: tuple[Options, Options], hire: tuple) -> None:
    """Play `match` and print its events and the managers' advice, then the result and how
    often each model answered. With only bots and built-in managers it runs as fast as it
    can; otherwise in real time, as the page would watch it."""
    squad = Players(match)
    staff = Staff(match, squad, (hire[0](), hire[1]()), options)
    names = [team.name for team in match.teams]
    answers: dict[str, list[int]] = {}
    failures: dict[str, int] = {}

    async def send(message: dict) -> None:
        if message["type"] == "event":
            team = "" if message["team"] is None else f" {names[message['team']]}"
            print(f"{match.clock()} {message['kind'].replace('_', ' ')}{team}", flush=True)
        elif message["type"] == "manager":
            to = f" to {match.player(message['player']).name}" if "player" in message else ""
            print(f"{match.clock()} {names[message['team']]} manager{to}: {message['text']}", flush=True)
        elif message["type"] == "decision":
            if "error" in message:
                failures[message["model"]] = failures.get(message["model"], 0) + 1
            else:
                answers.setdefault(message["model"], []).append(message["ms"])

    try:
        await staff.line_up()
        if squad.seats or any(isinstance(m, managers.LanguageModel) for m in staff.managers):
            await run(match, send, squad, staff)
        else:
            await fast(match, send, squad, staff)
    finally:
        await staff.aclose()
    print(f"{names[0]} {match.score[0]} - {match.score[1]} {names[1]}", flush=True)
    for model in sorted(set(answers) | set(failures)):
        times = sorted(answers.get(model, []))
        median = f", median {times[len(times) // 2]} ms" if times else ""
        print(f"{model}: {len(times)} answers{median}, {failures.get(model, 0)} failed", flush=True)


async def fast(match: Match, send, squad: Players, staff: Staff) -> None:
    """Play `match` to full time as fast as it runs, with every player on its bot and each
    manager consulted when it is due."""
    while match.phase != "full_time":
        squad.play()
        match.step()
        events = match.drain_events()
        staff.observe(events)
        for team in (0, 1):
            if staff.due(team):
                await staff.consult(team)
        for message in [*events, *staff.drain()]:
            await send(_detailed(message, match, squad))


def _open_when_listening(server: uvicorn.Server, url: str) -> None:
    while not server.started:
        if server.should_exit:
            return
        time.sleep(0.05)
    webbrowser.open(url)

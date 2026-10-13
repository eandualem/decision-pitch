# Copied from Decision Arena (https://github.com/eandualem/decision-arena), commit 770bb4a,
# src/decision_arena/local.py, under the MIT licence in LICENSE beside this file. Changes:
# imports from this package; the warm-up question and the start-up log are named after
# this game.

"""Decision models run on this computer: Laya, and Liquid's d1-3B.

Laya is an open-weight decision model from Convai Innovations. Its engine is the `laya` package with its server extra, installed once with
`uv tool install 'laya[serve]'` (about 750 MB including PyTorch). Choosing Laya starts
that installation's server on 127.0.0.1, as Entune does, and it ends when this program
ends. The first start downloads its English model, about 850 MB. The server answers the
same System One questions as Jev.

d1-3B is Liquid's open decision model, served by llama.cpp's `llama-server`, build 11483
or newer (installed with `brew install llama.cpp`, or from github.com/ggml-org/llama.cpp). Choosing it
starts `llama-server` the same way; the first start downloads the model, about 2.9 GB.
"""

from __future__ import annotations

import contextlib
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

from decision_pitch.arena.apis import DecisionAPI, MissingKey

INSTALL = "uv tool install 'laya[serve]'"
D1_INSTALL = "brew install llama.cpp, or a release from github.com/ggml-org/llama.cpp/releases"
D1_BUILD = 11483  # the first llama.cpp build that knows d1-3B
STALL = 300.0  # seconds a first-start download may stall before giving up
D1_MODEL = "LiquidAI/d1-3B-GGUF:Q8_0"
# The server exits when this program closes the pipe, or exits for any reason.
LAUNCH = (
    "import os, sys, threading\n"
    "threading.Thread(target=lambda: (sys.stdin.read(), os._exit(0)), daemon=True).start()\n"
    "from laya.serve import main\n"
    "main()\n"
)
# The same for llama-server, which cannot watch the pipe itself: this stops it when the pipe
# closes (killing it if it hasn't stopped in 5 s), and exits when it does.
WATCH = (
    "import subprocess, sys, threading\n"
    "server = subprocess.Popen(sys.argv[1:])\n"
    "def stop():\n"
    "    sys.stdin.read()\n"
    "    server.terminate()\n"
    "    try:\n"
    "        server.wait(5)\n"
    "    except subprocess.TimeoutExpired:\n"
    "        server.kill()\n"
    "threading.Thread(target=stop, daemon=True).start()\n"
    "sys.exit(server.wait())\n"
)
# The first answer pays the warm-up; a match's first question should not.
WARM_UP = {
    "model": "laya",
    "state": "Decision Pitch is starting.",
    "questions": {
        "warm_up": {
            "type": "choice",
            "instructions": "Is this a test?",
            "criteria": {"yes": None, "no": None},
        }
    },
}


def engine_python() -> Path | None:
    """The Python of the `laya` tool installation, or None when there is none."""
    roots = [Path(os.environ["UV_TOOL_DIR"])] if os.environ.get("UV_TOOL_DIR") else []
    roots.append(Path.home() / ".local" / "share" / "uv" / "tools")
    for root in roots:
        python = root / "laya" / "bin" / "python"
        if python.exists():
            return python
    found = shutil.which("laya-serve")
    if found and (python := Path(found).resolve().parent / "python").exists():
        return python
    return None


def laya(ready_seconds: float = 1800.0) -> DecisionAPI:
    """Start Laya's server, wait until it has answered once, and return it as a player."""
    python = engine_python()
    if python is None:
        raise MissingKey(f"Laya needs its engine. Install it with: {INSTALL}")
    port, token = _port(), secrets.token_urlsafe(32)
    env = {
        **os.environ,
        "LAYA_HOST": "127.0.0.1",
        "LAYA_PORT": str(port),
        "LAYA_MODELS": "english",
        "LAYA_PRELOAD": "1",
        "LAYA_LOG_LEVEL": "warning",
        "LAYA_API_KEY": token,
        "HF_HUB_DISABLE_TELEMETRY": "1",
    }
    print("Starting Laya (its first start downloads about 850 MB)…", flush=True)
    return _start("Laya", "laya", [str(python), "-c", LAUNCH], env, port, token, ready_seconds)


def d1(ready_seconds: float = 1800.0) -> DecisionAPI:
    """Start d1-3B in llama-server, wait until it has answered once, and return it."""
    server = shutil.which("llama-server")
    if server is None:
        raise MissingKey(f"d1-3B needs llama.cpp's llama-server. Install it with: {D1_INSTALL}")
    version = subprocess.run([server, "--version"], capture_output=True, text=True, timeout=30)
    build = re.search(r"build (\d+)", version.stdout + version.stderr)
    if build and int(build[1]) < D1_BUILD:
        raise MissingKey(
            f"d1-3B needs llama.cpp build {D1_BUILD} or newer; {server} is build {build[1]}. "
            f"Update it ({D1_INSTALL})."
        )
    port, token = _port(), secrets.token_urlsafe(32)
    argv = [
        sys.executable, "-c", WATCH, server, "-hf", D1_MODEL, "--no-mmproj",
        "--host", "127.0.0.1", "--port", str(port), "--api-key", token,
    ]
    env = {**os.environ, "HF_HUB_DISABLE_TELEMETRY": "1"}
    print("Starting d1-3B (its first start downloads about 2.9 GB)…", flush=True)
    return _start("d1-3B", "d1-3B", argv, env, port, token, ready_seconds)


def _stop(process: subprocess.Popen[bytes]) -> None:
    """Close the pipe, which stops the server (and llama-server behind its watcher, which
    kills it after 5 s); kill it only if it does not stop."""
    with contextlib.suppress(OSError):
        process.stdin.close()  # type: ignore[union-attr]
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def _downloading() -> int:
    """Bytes in the model downloads under way in the Hugging Face cache, where Laya's engine
    and llama-server both download to."""
    hub = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"
    total, fresh = 0, time.time() - 60
    for part in [*hub.glob("*/blobs/*.incomplete"), *hub.glob("*/blobs/*.downloadInProgress")]:
        with contextlib.suppress(OSError):
            if (stat := part.stat()).st_mtime > fresh:
                total += stat.st_size
    return total


def _say(text: str, end: str = "") -> None:
    """One status line, rewritten in place in a terminal."""
    if sys.stdout.isatty():
        print(f"\r{text}\033[K", end=end, flush=True)
    elif end:
        print(text, flush=True)


def _port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _start(
    name: str, model: str, argv: list[str], env: dict[str, str], port: int, token: str,
    ready_seconds: float,
) -> DecisionAPI:
    """Run a local System One server (its key keeps any page in a browser from asking),
    wait until it is healthy and has answered once, and return it as a player. It gives up
    after `ready_seconds`, or later while a download is still coming in."""
    log_path = Path(tempfile.gettempdir()) / f"decision-pitch-{name.lower()}.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, env=env
        )
    url = f"http://127.0.0.1:{port}"
    deadline, got = time.monotonic() + ready_seconds, 0
    with httpx.Client(timeout=5.0, trust_env=False) as http:
        while True:
            if process.poll() is not None:
                raise MissingKey(f"{name} stopped while starting; see {log_path}")
            # a first start downloads the model: show it, and wait as long as it keeps coming
            if (now := _downloading()) > got:
                got, deadline = now, max(deadline, time.monotonic() + STALL)
                _say(f"  downloading {name}: {got / 1e9:.2f} GB so far")
            if time.monotonic() > deadline:
                _stop(process)
                raise MissingKey(f"{name} did not start in time; see {log_path}")
            try:
                if http.get(f"{url}/health").json().get("status") == "ok":
                    break
            except (httpx.HTTPError, ValueError, AttributeError):
                pass
            time.sleep(0.5)
        if got:
            _say(f"  {name} downloaded, loading…", end="\n")
        try:
            warm = http.post(
                f"{url}/v1/systemone",
                json={**WARM_UP, "model": model},
                headers={"Authorization": f"Bearer {token}"},
                timeout=60.0,
            )
            warm.raise_for_status()
        except httpx.HTTPError as exc:
            _stop(process)
            raise MissingKey(f"{name} started but could not answer ({exc}); see {log_path}") from exc
    model = DecisionAPI(name, f"{url}/v1/systemone", model, token, local=True)
    model.process = process  # held so the pipe, and so the server, lives as long as we do
    return model

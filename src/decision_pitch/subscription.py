"""OpenAI managers using Codex's saved ChatGPT subscription login."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from decision_pitch.managers import ASSISTANTS, LanguageModel

DEFAULT_MODEL = "gpt-6-astra"
TIMEOUT = 180.0


def environment() -> dict[str, str]:
    """Pass runtime paths, never the game's provider keys or agent identity."""
    return {key: os.environ[key] for key in (
        "PATH", "HOME", "USER", "TMPDIR", "SYSTEMROOT", "CODEX_HOME",
    ) if key in os.environ}


def check_login() -> None:
    if not shutil.which("codex"):
        raise RuntimeError("OpenAI managers need the Codex CLI; install it and run codex login.")
    try:
        result = subprocess.run(
            ["codex", "login", "status"], env=environment(), capture_output=True,
            text=True, timeout=15, check=False,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Codex login check timed out; run codex login status.") from None
    if result.returncode or "Logged in using ChatGPT" not in result.stdout + result.stderr:
        raise RuntimeError("OpenAI managers require a ChatGPT subscription login; run codex login.")


class SubscriptionManager(LanguageModel):
    """Reuse the manager prompts and schemas, with subscription-only transport."""

    def __init__(self, model: str = DEFAULT_MODEL, assistants: int = 0, effort: str = "low"):
        if not 0 <= assistants <= len(ASSISTANTS):
            raise ValueError(f"a manager can have up to {len(ASSISTANTS)} assistants")
        self.name = self._model = self.assistant = model
        self._assistants = ASSISTANTS[:assistants]
        self.effort = effort

    async def aclose(self) -> None:
        pass

    async def _ask(self, model: str, system: str, feed: str, schema: dict | None = None):
        with tempfile.TemporaryDirectory(prefix="decision-pitch-manager-") as directory:
            output = Path(directory) / "answer.json"
            shape = Path(directory) / "schema.json"
            shape.write_text(json.dumps(schema or {
                "type": "object", "properties": {"text": {"type": "string"}},
                "required": ["text"], "additionalProperties": False,
            }))
            command = [
                "codex", "exec", "--ignore-user-config", "--ephemeral",
                "--skip-git-repo-check", "--sandbox", "read-only",
                "--disable", "hooks", "--disable", "shell_snapshot",
                "--disable", "shell_tool", "-c", "approval_policy=never",
                "-c", "forced_login_method=chatgpt", "-c", "service_tier=default",
                "-c", "web_search=disabled", "-c", "project_doc_max_bytes=0",
                "-c", f"model_reasoning_effort={self.effort}", "--model", model,
                "--output-schema", str(shape), "--output-last-message", str(output), "-",
            ]
            prompt = (system + "\nReturn only the requested structured answer. Do not use tools.\n\n" + feed)
            process = await asyncio.create_subprocess_exec(
                *command, cwd=directory, env=environment(), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(process.communicate(prompt.encode()), TIMEOUT)
                if process.returncode or not output.is_file():
                    raise RuntimeError("Codex manager failed; check ChatGPT login, model access and usage limits.")
                answer = json.loads(output.read_text())
                return answer if schema else answer["text"]
            except TimeoutError:
                raise RuntimeError("Codex manager timed out.") from None
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()

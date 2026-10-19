import argparse
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from decision_pitch import subscription
from decision_pitch.server import _hire


def test_openai_manager_requires_subscription_not_game_api_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-player-key")
    monkeypatch.setattr(subscription.shutil, "which", lambda _: "/bin/codex")
    monkeypatch.setattr(subscription.subprocess, "run", lambda *a, **k:
                        SimpleNamespace(returncode=0, stdout="", stderr="Logged in using an API key"))
    with pytest.raises(SystemExit):
        _hire(argparse.ArgumentParser(), "openai:gpt-6-sol", 0, "high")
    monkeypatch.setattr(subscription.subprocess, "run", lambda *a, **k:
                        SimpleNamespace(returncode=0, stdout="", stderr="Logged in using ChatGPT"))
    manager = _hire(argparse.ArgumentParser(), "openai:gpt-6-sol", 1, "high")()
    assert manager.name == "gpt-6-sol" and manager.effort == "high"
    assert manager.assistants == ("gpt-6-sol",)


def test_subscription_request_uses_schema_and_excludes_provider_credentials(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-player-key")
    monkeypatch.setenv("CODEX_API_KEY", "test-api-key")
    monkeypatch.setenv("BACKBONE_AGENT", "test-agent")
    calls = []

    async def spawn(*args, **kwargs):
        calls.append((args, kwargs))
        assert not any(key in kwargs["env"] for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "BACKBONE_AGENT"))
        assert "forced_login_method=chatgpt" in args
        assert "model_reasoning_effort=high" in args
        assert "--ignore-user-config" in args and "read-only" in args
        shape = json.loads(Path(args[args.index("--output-schema") + 1]).read_text())

        class Process:
            returncode = None

            async def communicate(self, prompt):
                assert b"game feed" in prompt
                answer = {"lineup": []} if "lineup" in shape["properties"] else {"text": "Press higher."}
                Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(answer))
                self.returncode = 0

        return Process()

    monkeypatch.setattr(subscription.asyncio, "create_subprocess_exec", spawn)
    manager = subscription.SubscriptionManager(effort="high")
    shape = {"type": "object", "properties": {"lineup": {"type": "array"}}}
    assert asyncio.run(manager._ask(manager.name, "brief", "game feed", shape)) == {"lineup": []}
    assert asyncio.run(manager._ask(manager.name, "brief", "game feed")) == "Press higher."
    assert all(not Path(kwargs["cwd"]).exists() for _, kwargs in calls)


@pytest.mark.parametrize("cancel", [False, True])
def test_pending_manager_is_terminated_on_timeout_or_disconnect(monkeypatch, cancel):
    class Process:
        returncode = None
        killed = False

        async def communicate(self, prompt):
            await asyncio.sleep(60)

        def kill(self):
            self.killed = True
            self.returncode = -9

        async def wait(self):
            pass

    process = Process()

    async def spawn(*args, **kwargs):
        return process

    monkeypatch.setattr(subscription.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(subscription, "TIMEOUT", 0.01)

    async def run():
        task = asyncio.create_task(subscription.SubscriptionManager()._ask("gpt-6-astra", "brief", "feed"))
        await asyncio.sleep(0)
        if cancel:
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else RuntimeError):
            await task

    asyncio.run(run())
    assert process.killed

import pytest

KEYS = (
    "TYPESAFE_API_KEY", "OPENAI_API_KEY", "PERPLEXITY_API_KEY", "EMPIRIO_LABS_API_KEY",
    "AI_GATEWAY_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN", "ANTHROPIC_API_KEY",
    "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
)  # fmt: skip


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    """No test may reach a paid API, whatever keys the shell or a .env file has."""
    monkeypatch.setattr("decision_pitch.server.load_dotenv", lambda *args, **kwargs: None)
    for key in KEYS:
        monkeypatch.delenv(key, raising=False)

import asyncio
import json

import httpx
import pytest

from decision_pitch import managers, subscription, tracing

pytest.importorskip('opentelemetry.sdk')
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest


@pytest.fixture
def exports(monkeypatch):
    tracing.close()
    posts = []
    original = httpx.Client

    def client(**kwargs):
        def respond(request):
            posts.append(request)
            return httpx.Response(200)
        return original(transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr(tracing.httpx, "Client", client)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test-only")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test-only")
    monkeypatch.setenv("LANGFUSE_BASE_URL", "https://traces.example.test")
    monkeypatch.setenv("OPENAI_API_KEY", "provider-secret-test")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "other=unrelated-secret")
    monkeypatch.setenv("OTEL_RESOURCE_ATTRIBUTES", "other=unrelated-secret")
    tracing.configure()
    yield posts
    tracing.close()


def attributes(posts):
    result = []
    for request in posts:
        message = ExportTraceServiceRequest.FromString(request.content)
        for resource in message.resource_spans:
            for scope in resource.scope_spans:
                for span in scope.spans:
                    result.append({a.key: a.value.string_value for a in span.attributes})
    return result


def test_manager_prompt_answer_and_group_are_exported_without_auth_material(exports):
    seen = []

    def respond(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"lineup": []}'}}]})

    async def go():
        manager = managers.LanguageModel(transport=httpx.MockTransport(respond), effort="high")
        with tracing.context("test-match", 0, "lineup"):
            await manager._ask("model", "system instructions", "live telemetry", {"type": "object"})
        await manager.aclose()
        await tracing.flush()
    asyncio.run(go())
    [post] = exports
    assert str(post.url) == "https://traces.example.test/api/public/otel/v1/traces"
    assert post.headers['authorization'].startswith('Basic ')
    assert post.headers['x-langfuse-ingestion-version'] == '4'
    assert 'other' not in post.headers
    assert b'provider-secret-test' not in post.content and b'unrelated-secret' not in post.content
    [span] = attributes(exports)
    recorded = json.loads(span['langfuse.observation.input'])
    assert recorded['messages'] == seen[0]['messages']
    assert recorded['schema'] == seen[0]['response_format']['json_schema']['schema']
    assert json.loads(span['langfuse.observation.output']) == {"lineup": []}
    assert span['langfuse.session.id'] == 'test-match'
    assert span['langfuse.observation.metadata.team'] == '0'


def test_subscription_trace_contains_the_actual_cli_prompt_and_failure_is_sanitized(exports, monkeypatch):
    sent = []

    async def subprocess(*args, **kwargs):
        class Process:
            returncode = 1
            async def communicate(self, prompt):
                sent.append(prompt.decode())
        return Process()

    monkeypatch.setattr(subscription.asyncio, 'create_subprocess_exec', subprocess)

    async def go():
        manager = subscription.SubscriptionManager(effort='high')
        with pytest.raises(RuntimeError):
            await manager._ask('model', 'brief', 'football feed')
        await tracing.flush()
    asyncio.run(go())
    [span] = attributes(exports)
    payload = json.loads(span['langfuse.observation.input'])
    assert payload['prompt'] == sent[0]
    assert payload['schema']['required'] == ['text']
    assert span['langfuse.observation.status_message'] == 'RuntimeError'
    assert 'langfuse.observation.output' not in span


def test_without_credentials_no_exporter_is_created(monkeypatch):
    tracing.close()
    monkeypatch.delenv('LANGFUSE_SECRET_KEY', raising=False)
    tracing.configure()
    assert tracing._provider is None


def test_trace_failure_does_not_replace_a_model_answer(exports, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError('trace unavailable')
    monkeypatch.setattr(tracing._provider, 'get_tracer', broken)
    class Manager:
        effort = 'high'
        trace_input = managers.LanguageModel.trace_input
        @tracing.manager_request
        async def ask(self, model, system, feed, schema=None):
            return 'still answered'
    assert asyncio.run(Manager().ask('model', 'brief', 'feed')) == 'still answered'

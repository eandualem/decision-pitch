"""Optional manager generations exported to Langfuse, without provider credentials.

The isolated OTLP exporter is adapted from Entune's app/tracing.py at bf5ca5a.
Copyright (c) 2026 Elias Andualem; MIT license in ENTUNE_LICENSE.
"""

import asyncio
import base64
import contextvars
import functools
import json
import logging
import os
from contextlib import contextmanager

import httpx

LOG = logging.getLogger(__name__)
_context = contextvars.ContextVar("manager_trace", default={})
_provider = None


def configure():
    """Called at startup after .env is loaded; no keys means no exporter or network."""
    global _provider
    public, secret = os.getenv("LANGFUSE_PUBLIC_KEY"), os.getenv("LANGFUSE_SECRET_KEY")
    if not (public and secret):
        return
    host = os.getenv("LANGFUSE_BASE_URL", "https://cloud.langfuse.com").rstrip("/")
    try:
        url = httpx.URL(host)
        if (url.scheme not in ("http", "https") or not url.host or url.userinfo or url.query or url.fragment
                or (url.scheme == "http" and url.host not in ("localhost", "127.0.0.1", "::1"))):
            raise ValueError("invalid destination")
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.sdk.trace.sampling import ALWAYS_ON
        authorization = "Basic " + base64.b64encode(f"{public}:{secret}".encode()).decode()
        provider = TracerProvider(sampler=ALWAYS_ON, resource=Resource({"service.name": "decision-pitch"}))
        provider.add_span_processor(BatchSpanProcessor(_exporter(host + "/api/public/otel/v1/traces", authorization)))
        _provider = provider
    except ImportError:
        LOG.warning('Langfuse disabled: install with uv sync --extra tracing.')
    except Exception as exc:
        LOG.warning("Langfuse disabled: %s", type(exc).__name__)


def _exporter(endpoint, authorization):
    from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
    from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

    class Exporter(SpanExporter):
        def __init__(self):
            self.client = httpx.Client(timeout=5, trust_env=False, headers={
                "Authorization": authorization, "Content-Type": "application/x-protobuf",
            })

        def export(self, spans):
            try:
                response = self.client.post(endpoint, content=encode_spans(spans).SerializeToString())
                if response.is_success:
                    return SpanExportResult.SUCCESS
                LOG.warning("Langfuse export failed: HTTP %s", response.status_code)
            except Exception as exc:
                LOG.warning("Langfuse export failed: %s", type(exc).__name__)
            return SpanExportResult.FAILURE

        def shutdown(self):
            self.client.close()

        def force_flush(self, timeout_millis=30000):
            return True

    return Exporter()


@contextmanager
def context(match, team, stage):
    token = _context.set({"match": match, "team": team, "stage": stage})
    try:
        yield
    finally:
        _context.reset(token)


def _safe_json(value):
    """Exact game content except any configured credential accidentally echoed in it."""
    text = json.dumps(value, ensure_ascii=False)
    for name, secret in os.environ.items():
        if secret and len(secret) >= 4 and (name.endswith(("_KEY", "_TOKEN", "_SECRET"))):
            text = text.replace(secret, "[redacted]")
    return text


def manager_request(method):
    """Wrap all three manager transports and assistants at the actual request boundary."""
    @functools.wraps(method)
    async def wrapped(self, model, system, feed, schema=None):
        span = None
        if _provider is not None:
            try:
                context = _context.get()
                stage = "assistant" if schema is None else context.get("stage", "manager")
                request = self.trace_input(system, feed, schema)
                span = _provider.get_tracer("decision-pitch").start_span(
                    stage, attributes={
                        "langfuse.observation.type": "generation",
                        "langfuse.trace.name": "Decision Pitch manager",
                        "langfuse.session.id": context.get("match", "ungrouped"),
                        "langfuse.observation.metadata.team": str(context.get("team", "unknown")),
                        "langfuse.observation.metadata.transport": type(self).__name__,
                        "langfuse.observation.model.name": model,
                        "langfuse.observation.model.parameters": _safe_json({"reasoning_effort": self.effort}),
                        "langfuse.observation.input": _safe_json(request),
                    },
                )
            except Exception:
                LOG.warning("Langfuse could not start a manager trace")
        try:
            answer = await method(self, model, system, feed, schema)
        except BaseException as exc:
            if span is not None:
                _update(span, {"langfuse.observation.level": "ERROR",
                               "langfuse.observation.status_message": type(exc).__name__})
            raise
        else:
            if span is not None:
                _update(span, {"langfuse.observation.output": _safe_json(answer)})
            return answer
        finally:
            if span is not None:
                try:
                    span.end()
                except Exception:
                    LOG.warning("Langfuse could not end a manager trace")
    return wrapped


def _update(span, attributes):
    try:
        span.set_attributes(attributes)
    except Exception:
        LOG.warning("Langfuse could not update a manager trace")


async def flush():
    if _provider is not None:
        try:
            await asyncio.to_thread(_provider.force_flush, timeout_millis=2000)
        except Exception:
            LOG.warning("Langfuse could not flush manager traces")


def close():
    global _provider
    provider, _provider = _provider, None
    if provider is not None:
        provider.shutdown()

"""Tests for build_runtime auth failure handling."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from myharness.api.client import ApiMessageRequest
from myharness.api.errors import AuthenticationFailure
from myharness.api.openai_client import OpenAICompatibleClient
from myharness.ui.runtime import (
    MissingAuthClient,
    _next_prompt_profile,
    _runtime_system_prompt,
    build_runtime,
    close_runtime,
    refresh_runtime_client,
)


@pytest.mark.asyncio
async def test_build_runtime_uses_missing_auth_client_when_auth_resolution_fails(monkeypatch):
    """build_runtime should start and surface auth failures through the API client."""

    def fake_resolve_auth(self):
        raise ValueError("No credentials found")

    monkeypatch.setattr("myharness.config.settings.Settings.resolve_auth", fake_resolve_auth)

    bundle = await build_runtime(active_profile="claude-api")

    assert isinstance(bundle.api_client, MissingAuthClient)
    with pytest.raises(AuthenticationFailure, match="API key|No credentials found"):
        async for _ in bundle.api_client.stream_message(
            ApiMessageRequest(model="claude-test", messages=[], system_prompt="")
        ):
            pass


@pytest.mark.asyncio
async def test_build_runtime_uses_missing_auth_client_for_openai_format(monkeypatch):
    """Same check for the openai-compatible path."""

    def fake_resolve_auth(self):
        raise ValueError("No credentials found")

    monkeypatch.setattr("myharness.config.settings.Settings.resolve_auth", fake_resolve_auth)

    bundle = await build_runtime(active_profile="openai-compatible", api_format="openai")

    assert isinstance(bundle.api_client, MissingAuthClient)


@pytest.mark.asyncio
async def test_build_runtime_keeps_pgpt_raw_sse_disabled_by_default(monkeypatch):
    monkeypatch.setenv("PGPT_API_KEY", "pgpt-key")
    monkeypatch.setenv("PGPT_EMPLOYEE_NO", "123456")
    monkeypatch.delenv("MYHARNESS_PGPT_RAW_SSE", raising=False)
    monkeypatch.delenv("MYHARNESS_PROMPT_CACHE_RETENTION", raising=False)

    bundle = await build_runtime(active_profile="p-gpt")

    assert isinstance(bundle.api_client, OpenAICompatibleClient)
    assert getattr(bundle.api_client, "_raw_stream") is False
    assert getattr(bundle.api_client, "_enable_prompt_cache_options") is True
    assert getattr(bundle.api_client, "_include_usage_with_tools") is True
    assert getattr(bundle.api_client, "_prompt_cache_retention") == "24h"


@pytest.mark.asyncio
async def test_build_runtime_enables_pgpt_raw_sse_with_env_flag(monkeypatch):
    monkeypatch.setenv("PGPT_API_KEY", "pgpt-key")
    monkeypatch.setenv("PGPT_EMPLOYEE_NO", "123456")
    monkeypatch.setenv("MYHARNESS_PGPT_RAW_SSE", "1")

    bundle = await build_runtime(active_profile="p-gpt")

    assert isinstance(bundle.api_client, OpenAICompatibleClient)
    assert getattr(bundle.api_client, "_raw_stream") is True


@pytest.mark.asyncio
async def test_build_runtime_enables_openai_prompt_cache_options(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "openai-key")
    monkeypatch.delenv("MYHARNESS_PROMPT_CACHE_RETENTION", raising=False)

    bundle = await build_runtime(active_profile="openai-compatible")

    assert isinstance(bundle.api_client, OpenAICompatibleClient)
    assert getattr(bundle.api_client, "_enable_prompt_cache_options") is True
    assert getattr(bundle.api_client, "_include_usage_with_tools") is True
    assert getattr(bundle.api_client, "_prompt_cache_retention") == "24h"


@pytest.mark.asyncio
async def test_refresh_runtime_client_closes_replaced_owned_client(monkeypatch):
    class _ClosableClient:
        def __init__(self):
            self.closed = False

        async def aclose(self):
            self.closed = True

    previous = _ClosableClient()
    replacement = _ClosableClient()
    settings = SimpleNamespace(model="gpt-5.6-sol", effective_max_tokens=lambda: 32_000)
    engine = SimpleNamespace(
        tool_metadata={},
        set_api_client=lambda client: None,
        set_model=lambda model: None,
        set_max_tokens=lambda max_tokens: None,
        set_system_prompt=lambda prompt: None,
    )
    hook_executor = SimpleNamespace(update_context=lambda **kwargs: None)
    bundle = SimpleNamespace(
        current_settings=lambda: settings,
        external_api_client=False,
        api_client=previous,
        engine=engine,
        hook_executor=hook_executor,
        cwd=".",
        extra_skill_dirs=(),
        extra_plugin_roots=(),
        task_worker=False,
    )
    refresh_mcp = AsyncMock(return_value=False)
    monkeypatch.setattr(
        "myharness.ui.runtime._resolve_api_client_from_settings",
        lambda current: replacement,
    )
    monkeypatch.setattr("myharness.ui.runtime.refresh_runtime_mcp", refresh_mcp)
    monkeypatch.setattr("myharness.ui.runtime.build_runtime_system_prompt", lambda *args, **kwargs: "prompt")
    monkeypatch.setattr("myharness.ui.runtime.sync_app_state", lambda current: None)

    await refresh_runtime_client(bundle)

    assert bundle.api_client is replacement
    assert previous.closed is True
    assert replacement.closed is False
    refresh_mcp.assert_awaited_once_with(bundle)


@pytest.mark.asyncio
async def test_close_runtime_closes_api_client_after_other_cleanup_failure(monkeypatch):
    events: list[str] = []

    class _ClosableClient:
        async def aclose(self):
            events.append("api")

    class _FailingMcpManager:
        async def close(self):
            events.append("mcp")
            raise RuntimeError("mcp close failed")

    class _HookExecutor:
        async def execute(self, event, payload):
            events.append("hook")

    async def _stop_sandbox():
        events.append("sandbox")

    monkeypatch.setattr("myharness.sandbox.session.stop_docker_sandbox", _stop_sandbox)
    monkeypatch.setattr(
        "myharness.personalization.session_hook.update_rules_from_session",
        lambda messages: None,
    )
    bundle = SimpleNamespace(
        prefix_cache_warmup_task=None,
        engine=SimpleNamespace(messages=[]),
        mcp_manager=_FailingMcpManager(),
        hook_executor=_HookExecutor(),
        cwd=".",
        external_api_client=False,
        api_client=_ClosableClient(),
    )

    await close_runtime(bundle)

    assert events == ["sandbox", "mcp", "hook", "api"]


def test_next_prompt_profile_keeps_codex_full_for_cache_stability():
    bundle = SimpleNamespace(
        engine=SimpleNamespace(
            messages=[object()],
            tool_metadata={"active_profile": "codex", "provider": "openai_codex"},
        )
    )

    assert _next_prompt_profile(bundle) == "full"


def test_next_prompt_profile_keeps_non_codex_full_for_cache_stability():
    bundle = SimpleNamespace(
        engine=SimpleNamespace(
            messages=[object()],
            tool_metadata={"active_profile": "p-gpt", "provider": "openai"},
        )
    )

    assert _next_prompt_profile(bundle) == "full"


def test_runtime_system_prompt_reuses_existing_prompt_without_rebuild(monkeypatch):
    def fail_build(*args, **kwargs):
        raise AssertionError("prompt should not be rebuilt")

    monkeypatch.setattr("myharness.ui.runtime.build_runtime_system_prompt", fail_build)
    bundle = SimpleNamespace(
        engine=SimpleNamespace(system_prompt="stable prompt", tool_metadata={}),
    )

    assert _runtime_system_prompt(bundle, "new user text") == "stable prompt"


def test_runtime_system_prompt_forced_rebuild_ignores_latest_user_prompt(monkeypatch):
    captured = {}

    def fake_build(*args, **kwargs):
        captured.update(kwargs)
        return "rebuilt prompt"

    monkeypatch.setattr("myharness.ui.runtime.build_runtime_system_prompt", fake_build)
    metadata = {"force_full_prompt_next": True}
    bundle = SimpleNamespace(
        engine=SimpleNamespace(system_prompt="old prompt", tool_metadata=metadata),
        current_settings=lambda: object(),
        cwd=".",
        extra_skill_dirs=(),
        extra_plugin_roots=(),
        task_worker=False,
    )

    assert _runtime_system_prompt(bundle, "volatile user text") == "rebuilt prompt"
    assert captured["latest_user_prompt"] is None
    assert metadata == {}

"""Tests for build_runtime auth failure handling."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from myharness.api.client import ApiMessageRequest
from myharness.api.errors import AuthenticationFailure
from myharness.api.openai_client import OpenAICompatibleClient
from myharness.ui.runtime import MissingAuthClient, _next_prompt_profile, _runtime_system_prompt, build_runtime


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

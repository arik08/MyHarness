"""Tests for build_runtime auth failure handling."""

from __future__ import annotations

import pytest

from myharness.api.client import ApiMessageRequest
from myharness.api.errors import AuthenticationFailure
from myharness.api.openai_client import OpenAICompatibleClient
from myharness.ui.runtime import MissingAuthClient, build_runtime


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

    bundle = await build_runtime(active_profile="p-gpt")

    assert isinstance(bundle.api_client, OpenAICompatibleClient)
    assert getattr(bundle.api_client, "_raw_stream") is False


@pytest.mark.asyncio
async def test_build_runtime_enables_pgpt_raw_sse_with_env_flag(monkeypatch):
    monkeypatch.setenv("PGPT_API_KEY", "pgpt-key")
    monkeypatch.setenv("PGPT_EMPLOYEE_NO", "123456")
    monkeypatch.setenv("MYHARNESS_PGPT_RAW_SSE", "1")

    bundle = await build_runtime(active_profile="p-gpt")

    assert isinstance(bundle.api_client, OpenAICompatibleClient)
    assert getattr(bundle.api_client, "_raw_stream") is True

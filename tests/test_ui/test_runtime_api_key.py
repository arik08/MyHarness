"""Tests for build_runtime auth failure handling."""

from __future__ import annotations

import pytest

from myharness.api.client import ApiMessageRequest
from myharness.api.errors import AuthenticationFailure
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

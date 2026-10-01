"""Policy changes must not trap a running session in an unavailable profile."""

import json
from unittest.mock import AsyncMock

import pytest

from myharness.config.settings import Settings, save_settings
from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost
from myharness.ui.protocol import FrontendRequest
from myharness.ui.runtime import build_runtime, close_runtime, handle_line


@pytest.mark.parametrize("target", ["p-gpt", "codex"])
@pytest.mark.parametrize("command", ["runtime_model", "provider", "model", "prompt"])
@pytest.mark.parametrize("disabled", [[], ["unregistered-future-model"]])
async def test_selection_recovers_from_previous_profile_policy(
    tmp_path, monkeypatch, target, command, disabled,
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    previous = "codex" if target == "p-gpt" else "p-gpt"
    settings = Settings(active_profile=previous).materialize_active_profile()
    save_settings(settings)
    client = AsyncMock()
    host = ReactBackendHost(BackendHostConfig(api_client=client))
    bundle = await build_runtime(
        api_client=client, active_profile=previous, model=settings.model,
        effort="low", connect_mcp=False,
    )
    host._bundle = bundle
    host._emit = AsyncMock()
    try:
        # Both providers share this model; matching model names must not hide
        # the need to refresh the provider at the next prompt boundary.
        model = settings.model if command == "prompt" else settings.merged_profiles()[target].allowed_models[-1]
        settings.enabled_models_by_profile = {previous: disabled, target: [model]}
        save_settings(settings)
        recovered = bundle.current_settings()
        assert recovered.active_profile == target
        assert recovered.model == model
        assert recovered.effort == "low"
        assert bundle.settings_overrides["active_profile"] == target
        assert "model" not in bundle.settings_overrides

        value = (
            json.dumps({"profile": target, "model": model}) if command == "runtime_model"
            else target if command == "provider" else model
        )
        if command == "prompt":
            await handle_line(
                bundle, "/help", print_system=AsyncMock(), render_event=AsyncMock(),
                clear_output=AsyncMock(), persist_session=False,
            )
        else:
            await host._apply_runtime_selection_request(FrontendRequest(
                type="apply_select_command", command=command, value=value,
                request_id="recover-selection",
            ))
            events = [call.args[0] for call in host._emit.await_args_list]
            assert not any(event.type == "error" for event in events)
            assert events[-1].request_id == "recover-selection"
        assert bundle.engine.model == model
        assert bundle.engine.tool_metadata["active_profile"] == target

        # A fresh request for the now unavailable profile must still be rejected.
        for rejected_command, rejected_value in (
            ("provider", previous),
            ("provider", "unregistered-profile"),
            ("runtime_model", json.dumps({"profile": previous, "model": model})),
            ("runtime_model", json.dumps({"profile": target, "model": "new-model"})),
        ):
            host._emit.reset_mock()
            before = dict(bundle.settings_overrides)
            await host._apply_runtime_selection_request(FrontendRequest(
                type="apply_select_command", command=rejected_command,
                value=rejected_value, request_id="reject-selection",
            ))
            events = [call.args[0] for call in host._emit.await_args_list]
            assert any(event.type == "error" for event in events)
            assert events[-1].request_id == "reject-selection"
            assert bundle.settings_overrides == before
            assert bundle.engine.model == model
    finally:
        await close_runtime(bundle)

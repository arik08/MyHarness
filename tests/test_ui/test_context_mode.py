from unittest.mock import AsyncMock

import pytest

from myharness.api.client import ApiMessageCompleteEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage
from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost
from myharness.ui.runtime import build_runtime, close_runtime, refresh_runtime_client
from myharness.config.settings import Settings


class LocalClient:
    async def stream_message(self, request):
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role="assistant", content=[]),
            usage=UsageSnapshot(input_tokens=10, output_tokens=1),
            stop_reason=None,
        )


@pytest.mark.asyncio
async def test_live_context_switch_keeps_history_and_reaches_next_query(tmp_path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    host = ReactBackendHost(BackendHostConfig(gpt56_context_mode="cost-saver"))
    host._bundle = await build_runtime(cwd=tmp_path, model="gpt-5.6-luna", api_client=LocalClient(), connect_mcp=False)
    host._emit = AsyncMock()
    engine = host._bundle.engine
    engine.load_messages([ConversationMessage.from_user_text("기존 대화 유지")])
    session_id = host._bundle.session_id
    import myharness.engine.query_engine as engine_module
    original_query = engine_module.run_query
    thresholds = []

    async def observed_query(*args, **kwargs):
        context = kwargs.get("context") or args[0]
        thresholds.append(context.auto_compact_threshold_tokens)
        async for event in original_query(*args, **kwargs):
            yield event

    monkeypatch.setattr(engine_module, "run_query", observed_query)
    try:
        for mode, expected in [("full-context", 1_000_000), ("cost-saver", 231_200)]:
            await host._apply_select_command("context_mode", mode)
            assert host._bundle.engine is engine
            assert host._bundle.session_id == session_id
            assert engine.messages[0].text == "기존 대화 유지"
            assert host._status_snapshot().state["runtime_options"]["context_mode"] == mode
            async for _ in engine.submit_message("계속"):
                pass
            assert thresholds[-1] == expected
        for busy, value in [(True, "full-context"), (False, "invalid")]:
            host._busy = busy
            await host._apply_select_command("context_mode", value)
            assert host._config.gpt56_context_mode == "cost-saver"
            assert host._emit.call_args.args[0].type == "error"
    finally:
        await close_runtime(host._bundle)


@pytest.mark.asyncio
async def test_switch_and_refresh_preserve_smaller_user_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    host = ReactBackendHost(BackendHostConfig())
    host._bundle = await build_runtime(cwd=tmp_path, model="gpt-5.6-luna", api_client=LocalClient(), connect_mcp=False)
    host._emit = AsyncMock()
    engine = host._bundle.engine
    try:
        smaller = Settings(model="gpt-5.6-luna", context_window_tokens=256_000, auto_compact_threshold_tokens=90_000)
        monkeypatch.setattr(host._bundle, "current_settings", lambda: smaller)
        await host._apply_select_command("context_mode", "full-context")
        await refresh_runtime_client(host._bundle)
        assert engine._context_window_tokens == 256_000
        assert engine._auto_compact_threshold_tokens == 90_000
        await host._apply_select_command("context_mode", "cost-saver")
        assert engine._auto_compact_threshold_tokens == 90_000
        # Returning to the original model retains the chosen mode on refresh.
        smaller = Settings(model="gpt-5.6-luna")
        await refresh_runtime_client(host._bundle)
        assert engine._auto_compact_threshold_tokens == 231_200
        await host._apply_select_command("context_mode", "full-context")
        await refresh_runtime_client(host._bundle)
        assert engine._auto_compact_threshold_tokens == 1_000_000
    finally:
        await close_runtime(host._bundle)

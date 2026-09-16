"""Regressions discovered with real Luna compaction/recovery requests."""
import re

import pytest

from myharness.api.client import ApiMessageCompleteEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock
from myharness.engine.query_engine import QueryEngine
from myharness.permissions import PermissionChecker, PermissionMode
from myharness.config.settings import PermissionSettings
from myharness.services.compact import compact_conversation
from myharness.services.session_documents import store_session_document
from myharness.tools.base import ToolExecutionContext, ToolRegistry
from myharness.tools.session_document_tool import (
    SessionDocumentSearchTool, SessionDocumentSearchToolInput,
    SessionDocumentReadTool, SessionDocumentReadToolInput,
)


@pytest.mark.asyncio
@pytest.mark.parametrize('indexed', [True, False])
async def test_long_line_search_cursor_and_lossless_bounded_read(tmp_path, indexed):
    source = 'İ한글 prefix ' * 20000 + 'TARGET-7429 amount=7319' + ' tail' * 5000
    metadata = {'session_id': 'abc123abc123'}
    entry = store_session_document(cwd=tmp_path, session_id=metadata['session_id'], text=source,
                                   metadata=metadata, source_kind='conversation_checkpoint')
    if not indexed:
        from pathlib import Path
        Path(entry['index_path']).unlink()
    context = ToolExecutionContext(cwd=tmp_path, metadata=metadata)
    search = await SessionDocumentSearchTool().execute(
        SessionDocumentSearchToolInput(document_id=entry['id'], query='TARGET-7429'), context)
    assert 'TARGET-7429 amount=7319' in search.output
    match = re.search(r'start_line=(\d+) start_column=(\d+)', search.output)
    assert match and int(match[2]) == source.index('TARGET-7429') + 1
    first = await SessionDocumentReadTool().execute(SessionDocumentReadToolInput(
        document_id=entry['id'], start_column=int(match[2]), max_chars=256), context)
    assert len(first.output) < 500 and 'TARGET-7429 amount=7319' in first.output
    cursor = re.search(r'start_line=(\d+), start_column=(\d+)', first.output)
    assert cursor
    second = await SessionDocumentReadTool().execute(SessionDocumentReadToolInput(
        document_id=entry['id'], start_line=int(cursor[1]), start_column=int(cursor[2]), max_chars=256), context)
    a = first.output.split('\n')[0].split('\t', 1)[1]
    b = second.output.split('\n')[0].split('\t', 1)[1]
    assert a + b == source[int(match[2])-1:int(match[2])-1+len(a)+len(b)]


class SummaryClient:
    def __init__(self, fail_first=False):
        self.calls = 0
        self.fail_first = fail_first

    async def stream_message(self, request):
        self.calls += 1
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role='assistant', content=[TextBlock(text='Keep CODE=7429; do not publish.')]),
            usage=UsageSnapshot(input_tokens=100, output_tokens=20, cached_input_tokens=50, cache_write_tokens=5),
            stop_reason='length' if self.fail_first and self.calls == 1 else 'stop')


@pytest.mark.asyncio
async def test_summary_retry_usage_is_counted_before_validation(tmp_path):
    billed = []
    await compact_conversation(
        [ConversationMessage.from_user_text('evidence ' * 10000)] * 8,
        api_client=SummaryClient(fail_first=True), model='gpt-5.6-luna', preserve_recent=1,
        usage_callback=billed.append)
    assert len(billed) == 2
    assert sum(x.input_tokens for x in billed) == 200
    assert sum(x.cache_write_tokens for x in billed) == 10


@pytest.mark.asyncio
async def test_engine_total_includes_summary_and_answer(tmp_path):
    engine = QueryEngine(api_client=SummaryClient(), tool_registry=ToolRegistry(),
        permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
        cwd=tmp_path, model='gpt-5.6-luna', system_prompt='Be concise.', auto_compact_threshold_tokens=12000,
        auto_skill_learning_enabled=False)
    engine.load_messages([ConversationMessage.from_user_text('evidence ' * 2000) for _ in range(10)])
    events = [event async for event in engine.submit_message('Continue.')]
    assert engine.total_usage.input_tokens == 200
    assert engine.total_usage.output_tokens == 40
    assert engine.total_usage.cached_input_tokens == 100
    assert engine.total_usage.cache_write_tokens == 10
    assert any(type(event).__name__ == 'UsageUpdated' for event in events)

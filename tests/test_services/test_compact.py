"""Tests for compaction and token estimation helpers."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from myharness.api.client import ApiMessageCompleteEvent
from myharness.api.errors import RequestFailure
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, ImageBlock, TextBlock, ToolResultBlock, ToolUseBlock
from myharness.hooks import HookEvent
from myharness.services import (
    build_post_compact_messages,
    compact_conversation,
    compact_messages,
    estimate_conversation_tokens,
    estimate_message_tokens,
    estimate_tokens,
    summarize_messages,
)
from myharness.services.compact import (
    AutoCompactState,
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    archive_user_inputs,
    auto_compact_if_needed,
    get_autocompact_threshold,
    get_compact_prompt,
    get_context_window,
    should_autocompact,
    try_context_collapse,
    try_session_memory_compaction,
)
from myharness.services.session_documents import get_session_document_dir


def test_token_estimation_helpers():
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("안녕하세요", model="gpt-5.5") == 2
    assert estimate_message_tokens(["abcd", "abcdefgh"]) == 2


def test_compact_and_summarize_messages():
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text="first question")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="first answer")]),
        ConversationMessage(role="user", content=[TextBlock(text="second question")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="second answer")]),
    ]

    summary = summarize_messages(messages, max_messages=2)
    assert "user: second question" in summary
    assert "assistant: second answer" in summary

    compacted = compact_messages(messages, preserve_recent=2)
    assert len(compacted) == 3
    assert "[conversation summary]" in compacted[0].text
    assert estimate_conversation_tokens(compacted) >= 1


def test_compact_messages_shifts_boundary_to_keep_tool_pair_intact():
    messages = [
        ConversationMessage.from_user_text("first"),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="toolu_pair", name="read_file", input={"path": "x"})],
        ),
        ConversationMessage(
            role="user",
            content=[ToolResultBlock(tool_use_id="toolu_pair", content="ok", is_error=False)],
        ),
        ConversationMessage(role="assistant", content=[TextBlock(text="done")]),
    ]

    compacted = compact_messages(messages, preserve_recent=2)

    assert any(
        isinstance(block, ToolUseBlock) and block.id == "toolu_pair"
        for message in compacted
        for block in message.content
    )
    assert any(
        isinstance(block, ToolResultBlock) and block.tool_use_id == "toolu_pair"
        for message in compacted
        for block in message.content
    )


def test_compact_messages_drops_dangling_preserved_tool_use():
    messages = [
        ConversationMessage.from_user_text("first"),
        ConversationMessage(role="assistant", content=[TextBlock(text="second")]),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="toolu_orphan", name="edit_file", input={"path": "x"})],
        ),
    ]

    compacted = compact_messages(messages, preserve_recent=1)

    assert not any(
        isinstance(block, ToolUseBlock) and block.id == "toolu_orphan"
        for message in compacted
        for block in message.content
    )


class _CompactApiClient:
    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []

    async def stream_message(self, request):
        self.requests.append(request)
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if asyncio.iscoroutinefunction(response):
            await response()
            return
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role="assistant", content=[TextBlock(text=response)]),
            usage=UsageSnapshot(input_tokens=1, output_tokens=1),
            stop_reason=None,
        )


class _HookExecutorStub:
    def __init__(self) -> None:
        self.events: list[tuple[HookEvent, dict[str, object]]] = []

    async def execute(self, event: HookEvent, payload: dict[str, object]):
        self.events.append((event, payload))
        from myharness.hooks.types import AggregatedHookResult

        return AggregatedHookResult()


class _PromptTooLargeApiClient:
    async def stream_message(self, request):
        del request
        raise RequestFailure("Your input exceeds the context window of this model. (code=context_length_exceeded)")


def test_try_session_memory_compaction_reduces_long_history():
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text=(f"user {index} " * 200).strip())])
        if index % 2 == 0
        else ConversationMessage(role="assistant", content=[TextBlock(text=(f"assistant {index} " * 200).strip())])
        for index in range(20)
    ]

    metadata: dict[str, object] = {}
    result = try_session_memory_compaction(messages, metadata=metadata)

    assert result is not None
    rebuilt = build_post_compact_messages(result)
    assert len(rebuilt) < len(messages)
    assert rebuilt[0].text.startswith("[Compact boundary marker]")
    assert any("Session handoff" in message.text for message in rebuilt)
    assert result.compact_metadata["preserve_recent"] == 6
    assert isinstance(metadata.get("user_input_archive"), list)
    assert any("user 0" in entry["text"] for entry in metadata["user_input_archive"])


def test_archive_user_inputs_deduplicates_and_skips_tool_results():
    metadata: dict[str, object] = {}
    messages = [
        ConversationMessage.from_user_text("중요한 사용자 요구사항 원문"),
        ConversationMessage.from_user_text("중요한 사용자 요구사항 원문"),
        ConversationMessage(role="user", content=[ToolResultBlock(tool_use_id="toolu_1", content="tool output")]),
        ConversationMessage.from_user_text("This session is being continued from compact history"),
    ]

    added = archive_user_inputs(messages, metadata)

    assert len(added) == 1
    archive = metadata.get("user_input_archive")
    assert isinstance(archive, list)
    assert archive[0]["text"] == "중요한 사용자 요구사항 원문"
    assert archive[0]["id"].startswith("user-")


def test_compact_prompt_prefers_user_verbatim_and_archive_recovery_over_transcript_copy():
    prompt = get_compact_prompt()

    assert "User-authored content has priority" in prompt
    assert "preserve it verbatim" in prompt
    assert "conversation_history_search" in prompt
    assert "Do not produce a full chronological transcript" in prompt
    assert "All User Messages" not in prompt


def test_try_context_collapse_trims_oversized_messages():
    giant = ("alpha " * 1200).strip()
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text=giant)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=giant)]),
        ConversationMessage(role="user", content=[TextBlock(text=giant)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=giant)]),
        ConversationMessage(role="user", content=[TextBlock(text=giant)]),
        ConversationMessage(role="assistant", content=[TextBlock(text="keep recent")]),
        ConversationMessage(role="user", content=[TextBlock(text="latest")]),
    ]

    result = try_context_collapse(messages, preserve_recent=2)

    assert result is not None
    assert "[collapsed" in result[0].text


def test_try_context_collapse_can_trim_recent_tool_results():
    giant = ("search result " * 1000).strip()
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text="search this")]),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="call_search", name="web_search", input={"query": "large"})],
        ),
        ConversationMessage(
            role="user",
            content=[ToolResultBlock(tool_use_id="call_search", content=giant)],
        ),
    ]

    result = try_context_collapse(messages, preserve_recent=6, include_preserved=True)

    assert result is not None
    tool_result = result[-1].content[0]
    assert isinstance(tool_result, ToolResultBlock)
    assert "[collapsed" in tool_result.content


@pytest.mark.asyncio
async def test_auto_compact_stores_oversized_current_user_input_as_session_document(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    long_text = "\n".join(
        f"{index:05d}. 조직업무분장 자료: 부서별 임무와 정원, 현안, 개편 영향 검토가 모두 중요합니다."
        for index in range(12000)
    )
    messages = [
        ConversationMessage.from_user_text(
            f"{long_text}\n\n위 조직업무분장 자료 전체를 근거로 조직 개편안을 검토해줘."
        )
    ]
    metadata: dict[str, object] = {"session_id": "abc123def456"}

    compacted, was_compacted = await auto_compact_if_needed(
        messages,
        api_client=_PromptTooLargeApiClient(),
        model="gpt-5.5",
        state=AutoCompactState(),
        carryover_metadata=metadata,
        cwd=tmp_path,
        context_window_tokens=4000,
    )

    assert was_compacted is True
    assert len(compacted) == 1
    compacted_text = compacted[0].text
    assert "Session document stored" in compacted_text
    assert "session_document_search" in compacted_text
    assert "session_document_read" in compacted_text
    assert "03000. 조직업무분장 자료" not in compacted_text
    assert estimate_conversation_tokens(compacted, model="gpt-5.5") < 8000
    docs = metadata.get("session_documents")
    assert isinstance(docs, list)
    assert len(docs) == 1
    entry = docs[0]
    assert isinstance(entry, dict)
    assert entry["line_count"] >= 12000
    document_path = Path(str(entry["path"]))
    assert document_path.is_file()
    assert document_path.parent == get_session_document_dir(tmp_path, "abc123def456")
    assert "11999. 조직업무분장 자료" in document_path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_forced_auto_compact_returns_collapsed_messages_when_summary_prompt_is_too_large():
    giant = ("search result " * 1000).strip()
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text="search this")]),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="call_search", name="web_search", input={"query": "large"})],
        ),
        ConversationMessage(
            role="user",
            content=[ToolResultBlock(tool_use_id="call_search", content=giant)],
        ),
    ]

    compacted, was_compacted = await auto_compact_if_needed(
        messages,
        api_client=_PromptTooLargeApiClient(),
        model="gpt-5.5",
        state=AutoCompactState(),
        force=True,
        trigger="reactive",
    )

    assert was_compacted is True
    tool_result = compacted[-1].content[0]
    assert isinstance(tool_result, ToolResultBlock)
    assert "[collapsed" in tool_result.content


@pytest.mark.asyncio
async def test_compact_conversation_retries_after_incomplete_response():
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text="alpha")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="beta")]),
        ConversationMessage(role="user", content=[TextBlock(text="gamma")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="delta")]),
        ConversationMessage(role="user", content=[TextBlock(text="epsilon")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="zeta")]),
        ConversationMessage(role="user", content=[TextBlock(text="eta")]),
    ]

    compacted = await compact_conversation(
        messages,
        api_client=_CompactApiClient(["", "<summary>condensed</summary>"]),
        model="claude-test",
    )

    rebuilt = build_post_compact_messages(compacted)
    assert rebuilt[0].text.startswith("[Compact boundary marker]")
    assert any(message.text.startswith("This session is being continued") for message in rebuilt)


@pytest.mark.asyncio
async def test_compact_conversation_runs_hooks_and_preserves_carryover_state(tmp_path):
    image_path = tmp_path / "sample.png"
    image_path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
        b"\x00\x00\x00\x0cIDAT\x08\x99c``\x00\x00\x00\x04\x00\x01\xf6\x178U"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    hook_executor = _HookExecutorStub()
    messages = [
        ConversationMessage(role="user", content=[ImageBlock.from_path(image_path)]),
        ConversationMessage(role="assistant", content=[TextBlock(text="Looking at the attachment")]),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(name="read_file", input={"path": str(image_path)})],
        ),
        ConversationMessage(role="user", content=[TextBlock(text="Please keep going")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="Working through it")]),
        ConversationMessage(role="user", content=[TextBlock(text="And preserve context")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="Sure")]),
    ]

    compacted = await compact_conversation(
        messages,
        api_client=_CompactApiClient(["<summary>condensed</summary>"]),
        model="claude-test",
        preserve_recent=2,
        hook_executor=hook_executor,
        carryover_metadata={
            "permission_mode": "plan",
            "session_id": "sess123",
            "task_focus_state": {
                "goal": "Confirm issue #98 and fix the logger formatting bug",
                "recent_goals": [
                    "Look into issue #98",
                    "Confirm issue #98 and fix the logger formatting bug",
                ],
                "active_artifacts": [str(image_path), "src/myharness/ui/runtime.py:398"],
                "verified_state": ["Issue #98 is about logger placeholder formatting"],
                "next_step": "Patch the logger formatting and rerun focused tests",
            },
            "read_file_state": [
                {
                    "path": str(image_path),
                    "span": "lines 1-20",
                    "preview": "1\tPNG header",
                    "timestamp": 123.0,
                }
            ],
            "invoked_skills": ["pikastream-video-meeting"],
            "async_agent_state": ["Spawned async agent [task_id=task_123]"],
            "recent_work_log": ["Ran pytest -q tests/test_compact.py [41 passed]"],
            "recent_verified_work": [
                "Issue #98 is about logger placeholder formatting",
                "matrix.py still contains mixed {} / %s logging",
            ],
            "compact_last": {"checkpoint": "query_auto_triggered", "token_count": 12345},
        },
    )

    assert [event for event, _payload in hook_executor.events] == [HookEvent.PRE_COMPACT, HookEvent.POST_COMPACT]
    rebuilt = build_post_compact_messages(compacted)
    joined = "\n\n".join(message.text for message in rebuilt)
    assert rebuilt[0].text.startswith("[Compact boundary marker]")
    assert any(message.text.startswith("This session is being continued") for message in rebuilt)
    assert "[Compact attachment: task_focus]" in joined
    assert "Current working focus" in joined
    assert "logger formatting bug" in joined
    assert "[Compact attachment: recent_verified_work]" in joined
    assert "Issue #98 is about logger placeholder formatting" in joined
    assert "[Compact attachment: plan]" in joined
    assert "Plan mode is still active" in joined
    assert str(image_path) in joined
    assert "[Compact attachment: recent_files]" in joined
    assert "Recently read files" in joined
    assert "[Compact attachment: invoked_skills]" in joined
    assert "[Compact attachment: async_agents]" in joined
    assert "[Compact attachment: recent_work_log]" in joined
    assert "41 passed" in joined


@pytest.mark.asyncio
async def test_compact_conversation_archives_and_preserves_recent_user_inputs():
    api_client = _CompactApiClient(["<summary>condensed</summary>"])
    metadata: dict[str, object] = {}
    long_user_context = "사용자가 붙여넣은 긴 근거 " + ("중요자료 " * 400)
    messages = [
        ConversationMessage.from_user_text(long_user_context),
        ConversationMessage(role="assistant", content=[TextBlock(text="noted")]),
        ConversationMessage.from_user_text("요약에서는 너무 길면 archive id로 회수하게 해줘"),
        ConversationMessage(role="assistant", content=[TextBlock(text="working")]),
        ConversationMessage.from_user_text("최근 요구는 원문으로 남겨줘"),
    ]

    compacted = await compact_conversation(
        messages,
        api_client=api_client,
        model="claude-test",
        preserve_recent=2,
        carryover_metadata=metadata,
    )

    assert api_client.requests[0].max_tokens == MAX_OUTPUT_TOKENS_FOR_SUMMARY == 4_000
    archive = metadata.get("user_input_archive")
    assert isinstance(archive, list)
    assert archive[0]["text"] == long_user_context.strip()
    prompt_text = "\n".join(message.text for message in api_client.requests[0].messages)
    assert "Archived user input:" in prompt_text
    rebuilt_text = "\n".join(message.text for message in build_post_compact_messages(compacted))
    assert "[Compact attachment: recent_user_inputs]" in rebuilt_text
    assert "[Compact attachment: user_input_archive]" in rebuilt_text
    assert long_user_context.strip() not in rebuilt_text
    assert "Full text is archived; retrieve it with conversation_history_search by ID if needed." in rebuilt_text


@pytest.mark.asyncio
async def test_compact_conversation_preserves_user_prompt_when_tool_loop_pushes_it_out():
    important_prompt = "사용자가 직접 쓴 매우 중요한 지시: 이 요구사항 원문은 다음 답변에도 그대로 필요합니다."
    messages = [ConversationMessage.from_user_text(important_prompt)]
    for index in range(4):
        tool_id = f"call_search_{index}"
        messages.extend([
            ConversationMessage(
                role="assistant",
                content=[ToolUseBlock(id=tool_id, name="web_search", input={"query": f"topic {index}"})],
            ),
            ConversationMessage(
                role="user",
                content=[ToolResultBlock(tool_use_id=tool_id, content=("검색 결과 " * 500), is_error=False)],
            ),
        ])
    messages.append(ConversationMessage(role="assistant", content=[TextBlock(text="final")]))

    compacted = await compact_conversation(
        messages,
        api_client=_CompactApiClient(["<summary>condensed</summary>"]),
        model="claude-test",
        preserve_recent=3,
        carryover_metadata={},
    )

    rebuilt_text = "\n".join(message.text for message in build_post_compact_messages(compacted))
    assert "[Compact attachment: recent_user_inputs]" in rebuilt_text
    assert important_prompt in rebuilt_text


@pytest.mark.asyncio
async def test_compact_conversation_preserves_final_assistant_output_over_tool_results():
    final_output = "최종 결과물: outputs/포스코_언론동향_브리핑.html 파일 작성을 완료했습니다."
    messages = [
        ConversationMessage.from_user_text("포스코 언론동향 웹보고서를 작성해줘"),
        ConversationMessage(role="assistant", content=[TextBlock(text="검색을 진행합니다.")]),
    ]
    for index in range(3):
        tool_id = f"call_fetch_{index}"
        messages.extend([
            ConversationMessage(
                role="assistant",
                content=[ToolUseBlock(id=tool_id, name="web_fetch", input={"url": f"https://example.com/{index}"})],
            ),
            ConversationMessage(
                role="user",
                content=[ToolResultBlock(tool_use_id=tool_id, content=("기사 본문 " * 600), is_error=False)],
            ),
        ])
    messages.extend([
        ConversationMessage(role="assistant", content=[TextBlock(text=final_output)]),
        ConversationMessage.from_user_text("다른 주제로 이어서 질문합니다"),
        ConversationMessage(role="assistant", content=[TextBlock(text="다음 작업을 시작합니다.")]),
        ConversationMessage.from_user_text("계속"),
    ])

    compacted = await compact_conversation(
        messages,
        api_client=_CompactApiClient(["<summary>condensed</summary>"]),
        model="claude-test",
        preserve_recent=2,
        carryover_metadata={},
    )

    rebuilt_text = "\n".join(message.text for message in build_post_compact_messages(compacted))
    assert "[Compact attachment: recent_assistant_outputs]" in rebuilt_text
    assert final_output in rebuilt_text


@pytest.mark.asyncio
async def test_compact_conversation_keeps_tool_pair_when_boundary_would_split_it():
    messages = [
        ConversationMessage.from_user_text("alpha"),
        ConversationMessage(role="assistant", content=[TextBlock(text="beta")]),
        ConversationMessage(role="user", content=[TextBlock(text="gamma")]),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="toolu_pair", name="read_file", input={"path": "demo.txt"})],
        ),
        ConversationMessage(
            role="user",
            content=[ToolResultBlock(tool_use_id="toolu_pair", content="contents", is_error=False)],
        ),
        ConversationMessage(role="assistant", content=[TextBlock(text="used the tool")]),
        ConversationMessage(role="user", content=[TextBlock(text="continue")]),
    ]

    compacted = await compact_conversation(
        messages,
        api_client=_CompactApiClient(["<summary>condensed</summary>"]),
        model="claude-test",
        preserve_recent=3,
    )

    rebuilt = build_post_compact_messages(compacted)
    pair_positions: list[tuple[int, str]] = []
    for index, message in enumerate(rebuilt):
        for block in message.content:
            if isinstance(block, ToolUseBlock) and block.id == "toolu_pair":
                pair_positions.append((index, "use"))
            if isinstance(block, ToolResultBlock) and block.tool_use_id == "toolu_pair":
                pair_positions.append((index, "result"))

    assert pair_positions == [(2, "use"), (3, "result")]


@pytest.mark.asyncio
async def test_compact_conversation_drops_orphan_preserved_tool_use():
    messages = [
        ConversationMessage.from_user_text("alpha"),
        ConversationMessage(role="assistant", content=[TextBlock(text="beta")]),
        ConversationMessage(role="user", content=[TextBlock(text="gamma")]),
        ConversationMessage(
            role="assistant",
            content=[ToolUseBlock(id="toolu_orphan", name="edit_file", input={"path": "demo.txt"})],
        ),
    ]

    compacted = await compact_conversation(
        messages,
        api_client=_CompactApiClient(["<summary>condensed</summary>"]),
        model="claude-test",
        preserve_recent=1,
    )

    rebuilt = build_post_compact_messages(compacted)
    assert not any(
        isinstance(block, ToolUseBlock) and block.id == "toolu_orphan"
        for message in rebuilt
        for block in message.content
    )


@pytest.mark.asyncio
async def test_compact_post_messages_keep_boundary_summary_recent_then_attachments():
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text="first")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="second")]),
        ConversationMessage(role="user", content=[TextBlock(text="third")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="fourth")]),
        ConversationMessage(role="user", content=[TextBlock(text="fifth")]),
        ConversationMessage(role="assistant", content=[TextBlock(text="sixth")]),
        ConversationMessage(role="user", content=[TextBlock(text="seventh")]),
    ]

    compacted = await compact_conversation(
        messages,
        api_client=_CompactApiClient(["<summary>condensed</summary>"]),
        model="claude-test",
        preserve_recent=2,
        carryover_metadata={
            "task_focus_state": {
                "goal": "Stabilize compact carry-over",
                "recent_goals": ["Stabilize compact carry-over"],
                "active_artifacts": ["/tmp/demo.py"],
                "verified_state": ["Focused compact test fixture prepared"],
                "next_step": "Run the focused compact tests",
            },
            "read_file_state": [{"path": "/tmp/demo.py", "span": "lines 1-20", "preview": "print('hi')"}],
            "recent_work_log": ["Ran pytest -q tests/test_services/test_compact.py [ok]"],
            "recent_verified_work": ["Focused compact test fixture prepared"],
        },
    )

    rebuilt = build_post_compact_messages(compacted)

    assert rebuilt[0].text.startswith("[Compact boundary marker]")
    assert rebuilt[1].text.startswith("This session is being continued")
    assert rebuilt[2].text == "sixth"
    assert rebuilt[3].text == "seventh"
    assert rebuilt[4].text.startswith("[Compact attachment:")
    assert any("[Compact attachment: task_focus]" in message.text for message in rebuilt)


@pytest.mark.asyncio
async def test_auto_compact_records_richer_checkpoint_metadata(monkeypatch):
    monkeypatch.setattr("myharness.services.compact.try_session_memory_compaction", lambda *args, **kwargs: None)
    monkeypatch.setattr("myharness.services.compact.should_autocompact", lambda *args, **kwargs: True)
    long_text = "alpha " * 50000
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
    ]
    metadata: dict[str, object] = {}

    result, was_compacted = await auto_compact_if_needed(
        messages,
        api_client=_CompactApiClient(["<summary>condensed</summary>"]),
        model="claude-sonnet-4-6",
        state=AutoCompactState(),
        carryover_metadata=metadata,
    )

    assert was_compacted is True
    assert result[0].text.startswith("[Compact boundary marker]")
    checkpoints = metadata.get("compact_checkpoints")
    assert isinstance(checkpoints, list)
    checkpoint_names = [entry["checkpoint"] for entry in checkpoints]
    assert "query_auto_triggered" in checkpoint_names
    assert "query_microcompact_end" in checkpoint_names
    assert "compact_end" in checkpoint_names
    assert isinstance(metadata.get("compact_last"), dict)
    assert metadata["compact_last"]["checkpoint"] == "compact_end"


@pytest.mark.asyncio
async def test_auto_compact_if_needed_returns_original_messages_after_timeout(monkeypatch):
    async def _stall():
        await asyncio.sleep(0.05)

    monkeypatch.setattr("myharness.services.compact.COMPACT_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr("myharness.services.compact.try_session_memory_compaction", lambda *args, **kwargs: None)
    monkeypatch.setattr("myharness.services.compact.should_autocompact", lambda *args, **kwargs: True)
    long_text = "alpha " * 50000
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="assistant", content=[TextBlock(text=long_text)]),
        ConversationMessage(role="user", content=[TextBlock(text=long_text)]),
    ]

    result, was_compacted = await auto_compact_if_needed(
        messages,
        api_client=_CompactApiClient([_stall]),
        model="claude-sonnet-4-6",
        state=AutoCompactState(),
    )

    assert was_compacted is False
    assert result == messages


def test_get_autocompact_threshold_respects_manual_override():
    assert get_autocompact_threshold(
        "claude-sonnet-4-6",
        auto_compact_threshold_tokens=12345,
    ) == 12345


def test_get_autocompact_threshold_caps_large_context_models_at_safe_ratio():
    assert get_autocompact_threshold("gpt-5.5") == 787_500
    assert get_autocompact_threshold("gpt-5") == 300_000
    assert get_autocompact_threshold("claude-sonnet-4-6") == 150_000
    assert get_autocompact_threshold("gpt-5.3-codex-spark") == 96_000


def test_get_context_window_uses_current_openai_model_limits():
    assert get_context_window("gpt-5.5") == 1_050_000
    assert get_context_window("gpt-5.5-pro") == 1_050_000
    assert get_context_window("gpt-5.4") == 1_050_000
    assert get_context_window("gpt-5.4-2026-03-17") == 1_050_000
    assert get_context_window("gpt-5.4-mini") == 400_000
    assert get_context_window("gpt-5.4-nano") == 400_000
    assert get_context_window("gpt-5.3-codex-spark") == 128_000
    assert get_context_window("gpt-5.3-codex") == 400_000
    assert get_context_window("gpt-4.1") == 1_047_576


def test_should_autocompact_uses_custom_context_window():
    messages = [
        ConversationMessage(role="user", content=[TextBlock(text="alpha " * 6000)]),
    ]
    assert should_autocompact(
        messages,
        "claude-sonnet-4-6",
        AutoCompactState(),
        context_window_tokens=4000,
    ) is True

"""Tests for the long report generation tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from myharness.api.client import ApiMessageCompleteEvent, ApiMessageRequest, ApiTextDeltaEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock
from myharness.services.long_report_progress import read_long_report_progress_state
from myharness.services.token_estimation import estimate_tokens
from myharness.tools import create_default_tool_registry
from myharness.tools.base import ToolExecutionContext
from myharness.tools.long_report_tool import (
    LongReportTool,
    LongReportToolInput,
    _render_html_blocks,
    _render_html_report,
    _resolve_target_tokens,
    _section_prompt,
    _trim_text_to_token_budget,
)


class FakeReportClient:
    def __init__(self, responses: list[tuple[str, str | None]]) -> None:
        self.responses = list(responses)
        self.requests: list[ApiMessageRequest] = []

    async def stream_message(self, request: ApiMessageRequest):
        self.requests.append(request)
        text, stop_reason = self.responses.pop(0)
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role="assistant", content=[TextBlock(text=text)]),
            usage=UsageSnapshot(input_tokens=10, output_tokens=20),
            stop_reason=stop_reason,
        )


class StreamingReportClient:
    def __init__(self, output_path: Path) -> None:
        self.output_path = output_path
        self.requests: list[ApiMessageRequest] = []
        self.saw_partial_file = False
        self.state_after_first_delta: dict[str, int] = {}

    async def stream_message(self, request: ApiMessageRequest):
        self.requests.append(request)
        if len(self.requests) == 1:
            yield ApiMessageCompleteEvent(
                message=ConversationMessage(role="assistant", content=[TextBlock(text="- 배경")]),
                usage=UsageSnapshot(input_tokens=10, output_tokens=20),
                stop_reason=None,
            )
            return
        if len(self.requests) == 2:
            yield ApiTextDeltaEvent(text="첫 문단이 ")
            self.state_after_first_delta = read_long_report_progress_state(
                self.output_path.parent.parent,
                self.output_path,
            )
            self.saw_partial_file = self.output_path.exists() and "첫 문단이" in self.output_path.read_text(encoding="utf-8")
            yield ApiTextDeltaEvent(text="스트리밍됩니다.")
            yield ApiMessageCompleteEvent(
                message=ConversationMessage(role="assistant", content=[TextBlock(text="첫 문단이 스트리밍됩니다.")]),
                usage=UsageSnapshot(input_tokens=10, output_tokens=20),
                stop_reason=None,
            )
            return
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role="assistant", content=[TextBlock(text="검토 요약")]),
            usage=UsageSnapshot(input_tokens=10, output_tokens=20),
            stop_reason=None,
        )


@pytest.mark.asyncio
async def test_long_report_uses_lower_gpt55_report_token_limits(tmp_path: Path):
    client = FakeReportClient(
        [
            ("- 배경\n- 영향", None),
            ("배경 본문", None),
            ("영향 본문", None),
            ("검토 요약", None),
        ]
    )
    result = await LongReportTool().execute(
        LongReportToolInput(
            title="긴 보고서",
            brief="테스트용 보고서를 작성하세요.",
            output_path="outputs/long_report.md",
        ),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={
                "api_client": client,
                "model": "gpt-5.5",
                "system_prompt": "system",
                "reasoning_effort": "medium",
            },
        ),
    )

    assert result.is_error is False
    assert [request.max_tokens for request in client.requests] == [8_000, 6_300, 6_300, 8_000]
    report = (tmp_path / "outputs" / "long_report.md").read_text(encoding="utf-8")
    assert "# 긴 보고서" in report
    assert "## 배경" in report
    assert "배경 본문" in report
    assert "## 검토 요약" in report
    assert "outputs/long_report.md" in result.output
    expected_written_tokens = sum(
        estimate_tokens(text, model="gpt-5.5")
        for text in ("배경 본문", "영향 본문", "검토 요약")
    )
    assert f"작성 사용량 합계 {expected_written_tokens:,} tokens" in result.output
    assert "모델 호출 합계 120 tokens" in result.output
    assert result.metadata["document_written_tokens"] == expected_written_tokens
    assert result.metadata["usage_input_tokens"] == 40
    assert result.metadata["usage_output_tokens"] == 80
    assert result.metadata["usage_total_tokens"] == 120
    progress_state = read_long_report_progress_state(tmp_path, "outputs/long_report.md")
    assert progress_state == {
        "document_written_tokens": result.metadata["document_written_tokens"],
        "usage_input_tokens": 40,
        "usage_output_tokens": 80,
        "usage_total_tokens": 120,
    }


@pytest.mark.asyncio
async def test_long_report_uses_gpt54_mini_section_limit_and_continues_truncated_sections(tmp_path: Path):
    client = FakeReportClient(
        [
            ("- 요약", None),
            ("요약 본문 1", "length"),
            (" 이어쓰기", None),
            ("검토 요약", None),
        ]
    )
    result = await LongReportTool().execute(
        LongReportToolInput(title="미니 보고서", brief="짧게", output_path="outputs/mini.md"),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={
                "api_client": client,
                "model": "gpt-5.4-mini",
                "system_prompt": "system",
            },
        ),
    )

    assert result.is_error is False
    assert [request.max_tokens for request in client.requests] == [6_000, 12_495, 12_495, 6_000]
    report = (tmp_path / "outputs" / "mini.md").read_text(encoding="utf-8")
    assert "요약 본문 1 이어쓰기" in report


@pytest.mark.asyncio
async def test_long_report_flushes_partial_file_while_section_streams(tmp_path: Path):
    output_path = tmp_path / "outputs" / "stream.html"
    client = StreamingReportClient(output_path)

    result = await LongReportTool().execute(
        LongReportToolInput(
            title="스트리밍 보고서",
            brief="본문이 생성되는 동안 파일을 갱신하세요.",
            output_path="outputs/stream.html",
            output_format="html",
        ),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={
                "api_client": client,
                "model": "gpt-5.5",
                "system_prompt": "system",
            },
        ),
    )

    assert result.is_error is False
    assert client.saw_partial_file is True
    assert "첫 문단이 스트리밍됩니다." in output_path.read_text(encoding="utf-8")
    assert client.state_after_first_delta["document_written_tokens"] == estimate_tokens(
        "첫 문단이 ",
        model="gpt-5.5",
    )
    assert read_long_report_progress_state(tmp_path, output_path)["document_written_tokens"] == sum(
        estimate_tokens(text, model="gpt-5.5")
        for text in ("첫 문단이 ", "스트리밍됩니다.", "검토 요약")
    )


@pytest.mark.asyncio
async def test_long_report_target_tokens_continue_short_sections_and_render_html(tmp_path: Path):
    long_body = "확장 분석 문장입니다. " * 8_000
    client = FakeReportClient(
        [
            ("- 배경\n- 결론", None),
            ("짧은 배경", None),
            (long_body, None),
            (long_body, None),
            ("검토 요약", None),
        ]
    )

    result = await LongReportTool().execute(
        LongReportToolInput(
            title="초장문 보고서",
            brief="80,000 토큰 수준으로 작성하세요.",
            output_path="outputs/deep.html",
        ),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={
                "api_client": client,
                "model": "gpt-5.5",
                "system_prompt": "system",
            },
        ),
    )

    assert result.is_error is False
    assert [request.max_tokens for request in client.requests] == [8_000, 10_500, 10_500, 10_500, 8_000]
    assert result.metadata["target_tokens"] == 20_000
    report = (tmp_path / "outputs" / "deep.html").read_text(encoding="utf-8")
    assert "<!doctype html>" in report
    assert "<title>초장문 보고서</title>" in report
    assert "본문 약" in report
    assert "목표 20,000 tokens" in report


@pytest.mark.asyncio
async def test_long_report_clamps_sections_to_requested_target_budget(tmp_path: Path):
    runaway_body = "과잉 생성 문장입니다. " * 20_000
    client = FakeReportClient(
        [
            ("- 본론", None),
            (runaway_body, None),
            ("검토 요약", None),
        ]
    )

    result = await LongReportTool().execute(
        LongReportToolInput(
            title="40k 보고서",
            brief="40,000 토큰 수준으로 작성하세요.",
            output_path="outputs/clamped.md",
        ),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={
                "api_client": client,
                "model": "gpt-5.5",
                "system_prompt": "system",
            },
        ),
    )

    assert result.is_error is False
    report = (tmp_path / "outputs" / "clamped.md").read_text(encoding="utf-8")
    assert result.metadata["target_tokens"] == 20_000
    assert estimate_tokens(report, model="gpt-5.5") < 25_000
    assert result.metadata["estimated_tokens"] < 25_000


def test_long_report_infers_user_requested_target_tokens():
    assert _resolve_target_tokens(LongReportToolInput(title="일반 보고서", brief="HTML 보고서를 작성하세요.")) == 0
    assert _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="18k 토큰 보고서로 작성하세요.")) == 18_000
    assert _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="길게 작성해줘")) == 18_000
    assert _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="디테일하게 작성해줘")) == 0
    assert (
        _resolve_target_tokens(
            LongReportToolInput(title="GPT 역사", brief="HTML 보고서를 80,000 토큰 수준으로 작성하세요.")
        )
        == 20_000
    )
    assert (
        _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="초장문 8만 토큰 대보고서로 작성"))
        == 20_000
    )
    assert (
        _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="매우 디테일하게 작성해줘"))
        == 20_000
    )


def test_long_report_token_budget_trim_uses_complete_sentence_boundary():
    text = ("완성 문장입니다. " * 200) + "잘리면 안 되는 미완성 문"

    trimmed = _trim_text_to_token_budget(text, 500, model="gpt-5.5")

    assert trimmed.endswith("완성 문장입니다.")
    assert not trimmed.endswith("미완성 문")
    assert estimate_tokens(trimmed, model="gpt-5.5") <= 500


def test_html_report_renderer_adds_visual_summary_and_section_weight_chart():
    html = _render_html_report(
        "메모리 시장 리포트",
        [
            ("1990년대 일본 DRAM 쇠퇴", "일본 DRAM 기업의 쇠퇴를 설명합니다. " * 60),
            ("2024년 AI/HBM 슈퍼사이클", "HBM 수요와 AI 서버 병목을 설명합니다. " * 180),
        ],
        "검토 요약",
        target_tokens=12_000,
        model="gpt-5.5",
    )

    assert 'class="visual-overview"' in html
    assert 'class="section-weight-chart"' in html
    assert 'aria-label="섹션별 본문 분량 비중"' in html
    assert '<link rel="icon" href="data:,">' in html
    assert "1990년대 일본 DRAM 쇠퇴" in html
    assert "2024년 AI/HBM 슈퍼사이클" in html
    assert "섹션 분량 비중" in html


def test_html_blocks_render_basic_markdown_and_escape_raw_html():
    html = _render_html_blocks(
        "\n".join(
            [
                "### 핵심 포인트",
                "- HBM은 AI 서버 병목과 연결됩니다.",
                "- NAND는 eSSD 수요가 중요합니다.",
                "",
                "| 구분 | 의미 |",
                "| --- | --- |",
                "| HBM | 대역폭 병목 |",
                "",
                "<div>raw html은 그대로 렌더링되면 안 됩니다.</div>",
            ]
        )
    )

    assert "<h3>핵심 포인트</h3>" in html
    assert "<ul>" in html
    assert "<li>HBM은 AI 서버 병목과 연결됩니다.</li>" in html
    assert "<table>" in html
    assert "<th>구분</th>" in html
    assert "<td>대역폭 병목</td>" in html
    assert "&lt;div&gt;raw html은 그대로 렌더링되면 안 됩니다.&lt;/div&gt;" in html
    assert "<p><div" not in html


def test_section_prompt_requires_visualizable_material_without_raw_html():
    prompt = _section_prompt(
        title="메모리 시장 리포트",
        brief="1990년대부터 2026년까지 HTML 보고서를 작성하세요.",
        section_title="AI/HBM 슈퍼사이클",
        source_text="",
        prior_summaries=[],
        index=1,
        total=3,
        target_tokens=0,
    )

    assert "HTML 태그를 쓰지 마세요" in prompt
    assert "표로 정리할 수 있는 수치" in prompt
    assert "차트·타임라인·비교표 후보" in prompt


def test_default_tool_registry_excludes_long_report_tool():
    registry = create_default_tool_registry()

    assert registry.get("write_long_report") is None

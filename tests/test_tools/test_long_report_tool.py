"""Tests for the long report generation tool."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from myharness.api.client import ApiMessageCompleteEvent, ApiMessageRequest, ApiTextDeltaEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock
from myharness.services.long_report_progress import read_long_report_progress_state
from myharness.services.token_estimation import estimate_tokens
from myharness.tools import create_default_tool_registry
from myharness.tools.base import ToolExecutionContext
from myharness.tools import long_report_tool as long_report_module
from myharness.tools.long_report_tool import (
    LongReportTool,
    LongReportToolInput,
    _continuation_prompt,
    _report_design_brief,
    _review_prompt,
    _render_html_blocks,
    _render_html_report,
    _resolve_target_tokens,
    _source_reference_candidates,
    _parse_outline_sections,
    _section_completion_floor_ratio,
    _section_collected_token_budget,
    _max_continuations_for_target,
    _section_prompt,
    _section_request_max_tokens,
    _target_tokens_per_section,
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


class OutlineStreamingReportClient:
    def __init__(self, output_path: Path) -> None:
        self.output_path = output_path
        self.requests: list[ApiMessageRequest] = []
        self.saw_outline_preview = False

    async def stream_message(self, request: ApiMessageRequest):
        self.requests.append(request)
        if len(self.requests) == 1:
            yield ApiTextDeltaEvent(text="- 시장 현황\n")
            self.saw_outline_preview = (
                self.output_path.exists()
                and "시장 현황" in self.output_path.read_text(encoding="utf-8")
            )
            yield ApiTextDeltaEvent(text="- 리스크")
            yield ApiMessageCompleteEvent(
                message=ConversationMessage(role="assistant", content=[TextBlock(text="- 시장 현황\n- 리스크")]),
                usage=UsageSnapshot(input_tokens=10, output_tokens=20),
                stop_reason=None,
            )
            return
        if len(self.requests) <= 3:
            yield ApiMessageCompleteEvent(
                message=ConversationMessage(role="assistant", content=[TextBlock(text="본문")]),
                usage=UsageSnapshot(input_tokens=10, output_tokens=20),
                stop_reason=None,
            )
            return
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role="assistant", content=[TextBlock(text="검토 요약")]),
            usage=UsageSnapshot(input_tokens=10, output_tokens=20),
            stop_reason=None,
        )


class SlowOutlineReportClient:
    def __init__(self) -> None:
        self.requests: list[ApiMessageRequest] = []

    async def stream_message(self, request: ApiMessageRequest):
        self.requests.append(request)
        if len(self.requests) == 1:
            await asyncio.sleep(60)
            if False:
                yield ApiTextDeltaEvent(text="")
            return
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role="assistant", content=[TextBlock(text="본문")]),
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
    assert [request.max_tokens for request in client.requests] == [1_200, 6_300, 6_300, 8_000]
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
    assert result.metadata["model_output"] == result.output
    assert result.metadata["display_output"] == "장문 보고서 생성 완료"
    assert "transcript_output" not in result.metadata
    intermediate_dir = Path(str(result.metadata["intermediate_dir"]))
    assert intermediate_dir.name == "long_report.intermediate"
    assert (intermediate_dir / "outline.md").read_text(encoding="utf-8").count("배경") >= 1
    design_brief = (intermediate_dir / "design_brief.md").read_text(encoding="utf-8")
    assert "디자인·문체 계약" in design_brief
    assert "나중에 다시 LLM으로 재작성하지 않고" in design_brief
    assert (intermediate_dir / "sections" / "01_배경.draft.md").read_text(encoding="utf-8") == "# 1. 배경\n\n배경 본문\n"
    assert (intermediate_dir / "sections" / "02_영향.draft.md").read_text(encoding="utf-8") == "# 2. 영향\n\n영향 본문\n"
    assert (intermediate_dir / "review.md").read_text(encoding="utf-8") == "# 긴 보고서 - 검토 요약\n\n검토 요약\n"
    manifest = json.loads(Path(str(result.metadata["intermediate_manifest_path"])).read_text(encoding="utf-8"))
    assert manifest["intermediate_dir"] == str(intermediate_dir)
    assert "중간 산출물 outputs/long_report.intermediate" in result.output
    progress_state = read_long_report_progress_state(tmp_path, "outputs/long_report.md")
    assert progress_state["document_written_tokens"] == result.metadata["document_written_tokens"]
    assert progress_state["usage_input_tokens"] == 40
    assert progress_state["usage_output_tokens"] == 80
    assert progress_state["usage_total_tokens"] == 120
    assert progress_state["phase"] == "done"
    assert progress_state["phase_label"] == "장문 보고서 생성 완료"
    assert [section["title"] for section in progress_state["outline_sections"]] == ["배경", "영향"]
    assert progress_state["intermediate_dir"] == "outputs/long_report.intermediate"
    intermediate_paths = [item["path"] for item in progress_state["intermediate_files"]]
    assert "outputs/long_report.intermediate/design_brief.md" in intermediate_paths
    assert "outputs/long_report.intermediate/sections/01_배경.draft.md" in intermediate_paths


@pytest.mark.asyncio
async def test_long_report_outline_timeout_falls_back_to_default_sections(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(long_report_module, "OUTLINE_TIMEOUT_SECONDS", 0.01)
    client = SlowOutlineReportClient()

    result = await LongReportTool().execute(
        LongReportToolInput(
            title="지연 목차 보고서",
            brief="목차가 지연되어도 본문으로 넘어가야 합니다.",
            output_path="outputs/timeout.md",
            max_sections=2,
        ),
        ToolExecutionContext(
            cwd=tmp_path,
            metadata={
                "api_client": client,
                "model": "gpt-5.5",
                "system_prompt": "system",
                "reasoning_effort": "high",
            },
        ),
    )

    assert result.is_error is False
    assert [request.max_tokens for request in client.requests] == [1_200, 6_300, 6_300, 8_000]
    assert client.requests[0].reasoning_effort == "minimal"
    report = (tmp_path / "outputs" / "timeout.md").read_text(encoding="utf-8")
    assert "## 데이터 범위와 분석 기준" in report
    progress_state = read_long_report_progress_state(tmp_path, "outputs/timeout.md")
    assert progress_state["phase"] == "done"
    assert [section["title"] for section in progress_state["outline_sections"]] == ["데이터 범위와 분석 기준", "전체 추세와 핵심 지표"]


@pytest.mark.asyncio
async def test_long_report_streams_outline_preview_before_sections(tmp_path: Path):
    output_path = tmp_path / "outputs" / "outline-stream.html"
    client = OutlineStreamingReportClient(output_path)

    result = await LongReportTool().execute(
        LongReportToolInput(
            title="시장 조사 보고서",
            brief="목차부터 투명하게 보여주세요.",
            output_path="outputs/outline-stream.html",
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
    assert client.saw_outline_preview is True
    assert output_path.exists()
    assert "검토 요약" in output_path.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_long_report_accepts_source_notes_and_writes_claim_ledger(tmp_path: Path):
    client = FakeReportClient(
        [
            ("- 시장 현황\n- 리스크", None),
            ("2026년 시장은 15% 성장했습니다. 주요 공급사는 투자를 확대했습니다.", None),
            ("규제 리스크는 2026년 하반기 비용 증가로 이어질 수 있습니다.", None),
            ("OK", None),
            ("검토 요약", None),
        ]
    )

    result = await LongReportTool().execute(
        LongReportToolInput(
            title="시장 조사 보고서",
            brief="최신 시장 현황을 조사 보고서로 작성하세요.",
            output_path="outputs/researched.md",
            source_notes=(
                "Source card [1]\n"
                "Title: Example Market Outlook\n"
                "Date: 2026-05-01\n"
                "URL: https://example.com/market\n"
                "Key facts: 2026년 시장 성장률 15%, 규제 비용 증가 가능성."
            ),
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
    assert "근거 ledger" in result.output
    assert result.metadata["source_notes_present"] is True
    outline_prompt = client.requests[0].messages[0].text
    first_section_prompt = client.requests[1].messages[0].text
    assert "## Research notes" in outline_prompt
    assert "https://example.com/market" in outline_prompt
    assert "섹션 작성자를 위한 routing brief" in outline_prompt
    assert "목차 단계에서 분량을 채우려 하지 마세요" in outline_prompt
    assert "완벽한 목차를 위해 과도하게 숙고하지 말고 즉시 JSON" in outline_prompt
    assert "2026년 시장 성장률 15%" in first_section_prompt
    ledger_path = Path(str(result.metadata["ledger_path"]))
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    assert ledger["research"]["requires_external_research"] is True
    assert ledger["research"]["source_notes_present"] is True
    assert ledger["research"]["sources"][0]["id"] == "source_notes"
    assert ledger["sections"][0]["id"] == "section-1"
    assert ledger["sections"][0]["claims"][0]["citation_candidates"] == ["source_notes"]
    assert ledger["style_consistency"]["audit_present"] is True
    assert ledger["style_consistency"]["revised_section_ids"] == []
    assert ledger["quality"]["status"] == "style_checked"
    assert ledger["quality"]["warnings"] == []


@pytest.mark.asyncio
async def test_long_report_rewrites_flagged_sections_for_style_consistency(tmp_path: Path):
    client = FakeReportClient(
        [
            ("- 시장 현황\n- 리스크", None),
            ("2026년 시장은 15% 성장했습니다. 공식 보고서체입니다.", None),
            ("근데 이건 좀 말투가 튀어요. 비용은 3억 원입니다.", None),
            ("REWRITE section-2: casual wording and unit style drift", None),
            ("2026년 하반기 규제 리스크는 비용 3억 원 증가 가능성으로 정리된다.", None),
            ("검토 요약", None),
        ]
    )

    result = await LongReportTool().execute(
        LongReportToolInput(
            title="시장 조사 보고서",
            brief="최신 시장 현황을 조사 보고서로 작성하세요.",
            output_path="outputs/rewrite.md",
            source_notes="Source card [1]\nURL: https://example.com/market\nKey facts: cost risk 3억 원.",
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
    report = (tmp_path / "outputs" / "rewrite.md").read_text(encoding="utf-8")
    assert "말투가 튀어요" not in report
    assert "비용 3억 원 증가 가능성" in report
    assert "## 출처·근거 후보" in report
    assert "Example" not in report
    assert "목표 토큰 수나 기존 섹션 길이는 참고 가이드일 뿐입니다" in client.requests[4].messages[0].text
    ledger = json.loads(Path(str(result.metadata["ledger_path"])).read_text(encoding="utf-8"))
    assert result.metadata["style_audit_present"] is True
    assert result.metadata["style_revised_section_ids"] == ["section-2"]
    assert ledger["style_consistency"]["revised_section_ids"] == ["section-2"]
    assert ledger["quality"]["status"] == "style_checked"


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
    assert [request.max_tokens for request in client.requests] == [1_200, 12_600, 12_600, 6_000]
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
    long_body = "확장 분석 문장입니다. " * 10_000
    client = FakeReportClient(
        [
            ("- 배경\n- 결론", None),
            ("짧은 배경", None),
            (long_body, None),
            (long_body, None),
            ("OK", None),
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
    assert [request.max_tokens for request in client.requests] == [1_200, 18_000, 18_000, 18_000, 2_000, 8_000]
    assert result.metadata["target_tokens"] == 80_000
    assert result.metadata["target_adherence"]["status"] == "approximate"
    report = (tmp_path / "outputs" / "deep.html").read_text(encoding="utf-8")
    assert "<!doctype html>" in report
    assert "<title>초장문 보고서</title>" in report
    assert "본문 약" not in report
    assert "목표 80,000 tokens" not in report
    assert "본문 추정 토큰" not in report
    assert "생성 목표" not in report


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
    assert result.metadata["target_tokens"] == 40_000
    assert 35_000 <= estimate_tokens(report, model="gpt-5.5") <= 50_000
    assert 35_000 <= result.metadata["estimated_tokens"] <= 50_000


def test_long_report_infers_user_requested_target_tokens():
    assert _resolve_target_tokens(LongReportToolInput(title="일반 보고서", brief="HTML 보고서를 작성하세요.")) == 0
    assert _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="18k 토큰 보고서로 작성하세요.")) == 18_000
    assert _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="길게 작성해줘")) == 18_000
    assert _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="디테일하게 작성해줘")) == 0
    assert (
        _resolve_target_tokens(
            LongReportToolInput(title="GPT 역사", brief="HTML 보고서를 160,000 토큰 수준으로 작성하세요.")
        )
        == 160_000
    )
    assert (
        _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="~160k 수준의 초장문 보고서로 작성"))
        == 160_000
    )
    assert (
        _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="초장문 8만 토큰 대보고서로 작성"))
        == 80_000
    )
    assert (
        _resolve_target_tokens(LongReportToolInput(title="시장 분석", brief="매우 디테일하게 작성해줘"))
        == 160_000
    )


def test_long_report_keeps_large_target_across_section_continuations():
    section_target = _target_tokens_per_section(
        target_tokens=80_000,
        section_count=2,
        section_cap=18_000,
    )

    assert section_target == 40_000
    assert _section_request_max_tokens(section_target, 18_000) == 18_000
    assert _section_collected_token_budget(section_target, allow_overrun=True) == 48_000
    assert _section_completion_floor_ratio(40_000) == 0.8
    assert _section_completion_floor_ratio(16_000) == 0.9
    assert _max_continuations_for_target(section_target) == 6
    assert _max_continuations_for_target(80_000) == 8


def test_long_report_token_budget_trim_uses_complete_sentence_boundary():
    text = ("완성 문장입니다. " * 200) + "잘리면 안 되는 미완성 문"

    trimmed = _trim_text_to_token_budget(text, 500, model="gpt-5.5")

    assert trimmed.endswith("완성 문장입니다.")
    assert not trimmed.endswith("미완성 문")
    assert estimate_tokens(trimmed, model="gpt-5.5") <= 500


def test_long_report_parses_structured_outline_sections():
    outline = json.dumps(
        {
            "sections": [
                {
                    "title": "네트워크 구조 진단",
                    "intent": "공항 연결망의 중심과 주변부를 먼저 구분합니다.",
                    "key_points": ["허브 공항", "노선 집중도"],
                    "analysis_angle": "트래픽과 연결 수를 함께 비교합니다.",
                }
            ]
        },
        ensure_ascii=False,
    )

    sections = _parse_outline_sections(outline, max_sections=8)

    assert sections == [
        {
            "title": "네트워크 구조 진단",
            "intent": "공항 연결망의 중심과 주변부를 먼저 구분합니다.",
            "key_points": ["허브 공항", "노선 집중도"],
            "analysis_angle": "트래픽과 연결 수를 함께 비교합니다.",
        }
    ]


def test_html_report_renderer_adds_visual_summary_and_section_weight_chart():
    source_references = _source_reference_candidates(
        LongReportToolInput(
            title="메모리 시장 리포트",
            brief="시장 조사",
            source_notes="Title: HBM Market Outlook\nDate: 2026-05-01\nURL: https://example.com/hbm",
        )
    )
    html = _render_html_report(
        "메모리 시장 리포트",
        [
            (
                "1990년대 일본 DRAM 쇠퇴",
                "일본 DRAM 기업의 쇠퇴를 설명합니다. 1995년 점유율은 42%였습니다.\n\n"
                "| 기업 | 점유율 | 생산량 |\n"
                "| --- | --- | --- |\n"
                "| A사 | 42% | 120 |\n"
                "| B사 | 27% | 80 |\n"
                "| C사 | 14% | 45 |\n",
            ),
            ("2024년 AI/HBM 슈퍼사이클", "HBM 수요와 AI 서버 병목을 설명합니다. 2024년 성장률은 63%입니다. " * 80),
        ],
        "검토 요약",
        target_tokens=12_000,
        model="gpt-5.5",
        source_references=source_references,
    )

    assert 'class="visual-overview"' in html
    assert 'class="visual-artifact-report"' in html
    assert 'class="executive-lens"' in html
    assert 'class="workflow-map"' in html
    assert 'aria-label="보고서 섹션 workflow"' in html
    assert 'class="data-signal-grid"' in html
    assert 'class="table-derived-visual"' in html
    assert 'class="section-weight-chart"' in html
    assert 'class="source-hint"' in html
    assert 'class="sources-section"' in html
    assert 'aria-label="섹션별 본문 분량 비중"' in html
    assert 'aria-label="표에서 자동 생성한 비교 시각화"' in html
    assert '<link rel="icon" href="data:,">' in html
    assert "Analytical HTML Report" in html
    assert "visual-artifact" in html
    assert "1990년대 일본 DRAM 쇠퇴" in html
    assert "2024년 AI/HBM 슈퍼사이클" in html
    assert "섹션 분량 비중" in html
    assert "보고서 workflow" in html
    assert "원문 표의 수치 열을 자동 비교 시각화했습니다" in html
    assert "HBM Market Outlook" in html
    assert "https://example.com/hbm" in html
    assert "총 섹션" not in html
    assert "본문 추정 토큰" not in html
    assert "생성 목표" not in html
    assert "목표 12,000 tokens" not in html
    assert 'class="metric-grid"' not in html
    assert 'class="pill"' not in html


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
        output_format="html",
        design_brief=_report_design_brief(
            LongReportToolInput(title="메모리 시장 리포트", brief="HTML 보고서"),
            output_format="html",
        ),
    )

    assert "`visual-artifact` 기준의 HTML 보고서" in prompt
    assert "독자-facing 본문" in prompt
    assert "나중에 다시 LLM으로 재작성하지 않고" in prompt
    assert "최종 HTML에 바로 들어갈 본문 조각" in prompt
    assert "분석 workflow" in prompt
    assert "타임라인" in prompt
    assert "HTML 태그를 쓰지 마세요" in prompt
    assert "표로 정리할 수 있는 수치" in prompt
    assert "차트·타임라인·비교표 후보" in prompt
    assert "문체·용어·구조 일관성 계약" in prompt
    assert "같은 개념, 기업명, 제품명, 지표명, 단위, 기간 표기" in prompt


def test_long_report_followup_prompts_preserve_style_consistency_contract():
    continuation = _continuation_prompt(
        "메모리 시장 리포트",
        "AI/HBM 슈퍼사이클",
        "현재 본문입니다.",
        target_tokens=8_000,
        model="gpt-5.5",
        design_brief="최종 HTML에 바로 들어갈 본문 조각입니다.",
    )
    review = _review_prompt("메모리 시장 리포트", ["- AI/HBM 슈퍼사이클: 요약"])

    assert "문체·용어·구조 일관성 계약" in continuation
    assert "최종 HTML에 바로 들어갈 본문 조각입니다." in continuation
    assert "이미 쓴 내용을 요약하거나 반복하지 말고" in continuation
    assert "문체·용어·단위 일관성" in review


def test_default_tool_registry_temporarily_excludes_long_report_tool():
    registry = create_default_tool_registry()

    assert registry.get("write_long_report") is None

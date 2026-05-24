"""Long report generation tool."""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, Field

from myharness.api.client import (
    ApiMessageCompleteEvent,
    ApiMessageRequest,
    ApiTextDeltaEvent,
    SupportsStreamingMessages,
)
from myharness.api.usage import UsageSnapshot
from myharness.config.settings import report_token_limits_for_model
from myharness.engine.messages import ConversationMessage
from myharness.services.long_report_progress import write_long_report_progress_state
from myharness.services.token_estimation import estimate_tokens
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.path_display import display_tool_path


DEFAULT_REPORT_TOKEN_CAP = 12_000
REPORT_TOKEN_HARD_CAP = 160_000
IMPLIED_LONG_REPORT_TARGET_TOKENS = 18_000
IMPLIED_EXTRA_LONG_REPORT_TARGET_TOKENS = REPORT_TOKEN_HARD_CAP
SOURCE_NOTES_MAX_CHARS = 80_000
OUTLINE_REQUEST_MAX_TOKENS = 1_200
OUTLINE_TIMEOUT_SECONDS = 30
STYLE_CONSISTENCY_CONTRACT = (
    "문체·용어·구조 일관성 계약:\n"
    "- 전체 보고서는 존댓말이 아닌 공식 비즈니스 보고서체로 통일하세요.\n"
    "- 같은 개념, 기업명, 제품명, 지표명, 단위, 기간 표기는 모든 섹션에서 같은 표현을 쓰세요.\n"
    "- 각 섹션은 독립 요약문처럼 다시 시작하지 말고, 이전 섹션과 논리적으로 이어지는 분석 본문으로 쓰세요.\n"
    "- 수치의 단위와 기준 연도/지역/범위가 바뀌면 문장 안에서 명확히 표시하세요.\n"
    "- 표, 목록, 단락의 밀도와 톤을 전체 보고서 안에서 비슷하게 유지하세요.\n"
)


class LongReportToolInput(BaseModel):
    """Arguments for the long report generation tool."""

    title: str = Field(description="Human-readable report title")
    brief: str = Field(description="What the report should cover")
    output_path: str = Field(default="", description="Output path. Defaults to outputs/<title>_report.md")
    output_format: Literal["auto", "markdown", "html"] = Field(
        default="auto",
        description="Report file format. Auto follows the output_path extension.",
    )
    target_tokens: int = Field(
        default=0,
        ge=0,
        le=REPORT_TOKEN_HARD_CAP,
        description=(
            "Approximate desired report body length for explicit extra-long artifact requests. Hard-capped at 160,000 tokens."
        ),
    )
    source_paths: list[str] = Field(default_factory=list, description="Optional local text files to use as source material")
    source_notes: str = Field(
        default="",
        description=(
            "Concise research bundle or source cards gathered before writing. Include key facts, dates, URLs, "
            "confidence, and caveats when web/search research was used."
        ),
    )
    max_sections: int = Field(default=8, ge=1, le=30, description="Maximum outline sections to generate")


class LongReportTool(BaseTool):
    """Generate a long report through smaller section-level model calls."""

    name = "write_long_report"
    description = (
        "Generate an explicitly requested extra-long Markdown or HTML report as a file instead of streaming it into chat. "
        "Use this only when the user or MyHarness compose options clearly ask for an artifact around 20,000 tokens or more, "
        "such as 초장문, 20k, 40k, 80k, 160k, 대보고서, or a numeric target above normal report length. "
        "Normal report requests should still use a direct coherent artifact around 10,000-12,000 tokens. "
        "Set target_tokens to the requested body length, up to the 160,000-token hard cap. "
        "When search or research has already been performed, pass the source cards or research digest in source_notes "
        "or pass local research files in source_paths; do not rely on prior chat/tool output being visible inside this tool. "
        "The tool creates a fast model-generated outline, writes sections with lower per-call token caps, reviews the result, "
        "writes a claim/source ledger sidecar, and returns only the output path and short summary."
    )
    input_model = LongReportToolInput

    async def execute(
        self,
        arguments: LongReportToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        api_client = context.metadata.get("api_client")
        if not _is_streaming_client(api_client):
            return ToolResult(output="장문 보고서 생성에는 현재 세션의 API 클라이언트가 필요합니다.", is_error=True)

        model = str(context.metadata.get("model") or "").strip() or "gpt-5.5"
        system_prompt = str(context.metadata.get("system_prompt") or "").strip() or None
        reasoning_effort = str(context.metadata.get("reasoning_effort") or "").strip() or None
        token_limits = report_token_limits_for_model(model)
        output_path = _resolve_output_path(context.cwd, arguments.output_path, arguments.title, arguments.output_format)
        output_format = _resolve_output_format(arguments, output_path)
        target_tokens = _resolve_target_tokens(arguments)
        report_token_budget = target_tokens or DEFAULT_REPORT_TOKEN_CAP
        allow_section_overrun = target_tokens > IMPLIED_LONG_REPORT_TARGET_TOKENS
        source_text = _source_material_for_report(context.cwd, arguments)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        intermediate_writer = _LongReportIntermediateArtifacts(
            output_path=output_path,
            title=arguments.title,
        )
        preview_writer = _ReportPreviewWriter(
            cwd=context.cwd,
            output_path=output_path,
            title=arguments.title,
            output_format=output_format,
            target_tokens=target_tokens,
            model=model,
            intermediate_snapshot=lambda: intermediate_writer.progress_files(context.cwd),
            intermediate_dir=intermediate_writer.display_root(context.cwd),
        )
        report_design_brief = _report_design_brief(arguments, output_format=output_format)
        intermediate_writer.write_design_brief(report_design_brief)
        written_token_counter = _CumulativeTokenCounter(model=model)

        generation_usage = UsageSnapshot()
        outline_prompt = _outline_prompt(arguments, source_text, target_tokens=target_tokens)
        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
            phase="outline",
            phase_label="보고서 뼈대 생성 중",
        )
        outline_parts: list[str] = []

        async def _on_outline_delta(delta: str) -> None:
            outline_parts.append(delta)
            current_outline = "".join(outline_parts)
            intermediate_writer.write_outline_draft(current_outline)
            preview_writer.write_progress_state(
                generation_usage,
                document_written_tokens=written_token_counter.total_tokens,
                phase="outline",
                phase_label="보고서 뼈대 생성 중",
                section_summary=_short_progress_excerpt(current_outline),
            )
            await preview_writer.write_stage_text("보고서 뼈대 생성 중", current_outline)

        try:
            outline_text, _, usage = await asyncio.wait_for(
                _request_text(
                    api_client,
                    model=model,
                    system_prompt=system_prompt,
                    reasoning_effort=_outline_reasoning_effort(reasoning_effort),
                    prompt=outline_prompt,
                    max_tokens=min(token_limits["outline"], OUTLINE_REQUEST_MAX_TOKENS),
                    on_delta=_on_outline_delta,
                ),
                timeout=OUTLINE_TIMEOUT_SECONDS,
            )
            outline_text = ("".join(outline_parts) or outline_text).strip()
            generation_usage = _add_usage(generation_usage, usage)
        except TimeoutError:
            outline_text = _fallback_outline_text(arguments, source_text)
            intermediate_writer.write_outline_draft(
                "목차 생성 요청이 제한 시간 안에 완료되지 않아 안전용 기본 구조로 전환했습니다.\n\n"
                f"{outline_text}"
            )
        outline_sections = _parse_outline_sections(outline_text, max_sections=arguments.max_sections)
        sections = [
            str(item.get("title") or "").strip()
            for item in outline_sections
            if str(item.get("title") or "").strip()
        ]
        if not sections:
            outline_text = _fallback_outline_text(arguments, source_text)
            outline_sections = _parse_outline_sections(outline_text, max_sections=arguments.max_sections)
            sections = [
                str(item.get("title") or "").strip()
                for item in outline_sections
                if str(item.get("title") or "").strip()
            ]
        if not sections:
            sections = ["요약"]
            outline_sections = [{"title": "요약", "intent": "요청 내용을 한눈에 파악할 수 있게 핵심 논리를 정리합니다."}]
            outline_text = json.dumps({"sections": outline_sections}, ensure_ascii=False)
        intermediate_writer.write_outline(outline_text, outline_sections)
        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
            phase="outline_ready",
            phase_label="보고서 뼈대 생성 완료",
            outline_sections=outline_sections,
            section_total=len(sections),
        )
        await preview_writer.write_stage_text("보고서 뼈대 생성 완료", outline_text, force=True)
        section_target_tokens = _target_tokens_per_section(
            target_tokens=report_token_budget,
            section_count=len(sections),
            section_cap=token_limits["section"],
            minimum_per_section=2_500 if allow_section_overrun else 500,
        )
        requested_section_target_tokens = section_target_tokens if target_tokens else 0
        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
            phase="outline_ready",
            phase_label="보고서 뼈대 생성 완료",
            outline_sections=outline_sections,
            section_total=len(sections),
        )

        section_bodies: list[tuple[str, str]] = []
        section_summaries: list[str] = []
        for index, section_title in enumerate(sections, start=1):
            section_parts: list[str] = []
            section_summary = _outline_section_summary(outline_sections[index - 1] if index - 1 < len(outline_sections) else {})
            preview_writer.write_progress_state(
                generation_usage,
                document_written_tokens=written_token_counter.total_tokens,
                phase="section",
                phase_label="섹션 본문 작성 중",
                outline_sections=outline_sections,
                section_index=index,
                section_total=len(sections),
                section_title=section_title,
                section_summary=section_summary,
            )

            async def _on_section_delta(delta: str, *, _section_title: str = section_title) -> None:
                section_parts.append(delta)
                written_token_counter.add(delta)
                current_body = "".join(section_parts)
                intermediate_writer.write_section(index, _section_title, current_body)
                preview_writer.write_progress_state(
                    generation_usage,
                    document_written_tokens=written_token_counter.total_tokens,
                    phase="section",
                    phase_label="섹션 본문 작성 중",
                    outline_sections=outline_sections,
                    section_index=index,
                    section_total=len(sections),
                    section_title=_section_title,
                    section_summary=section_summary,
                )
                await preview_writer.write([*section_bodies, (_section_title, current_body)])

            prompt = _section_prompt(
                title=arguments.title,
                brief=arguments.brief,
                section_title=section_title,
                source_text=source_text,
                prior_summaries=section_summaries,
                index=index,
                total=len(sections),
                target_tokens=requested_section_target_tokens,
                output_format=output_format,
                design_brief=report_design_brief,
            )
            body, stop_reason, usage = await _request_text(
                api_client,
                model=model,
                system_prompt=system_prompt,
                reasoning_effort=reasoning_effort,
                prompt=prompt,
                max_tokens=_section_request_max_tokens(section_target_tokens, token_limits["section"]),
                max_collected_tokens=_section_collected_token_budget(
                    section_target_tokens,
                    allow_overrun=allow_section_overrun,
                ),
                on_delta=_on_section_delta,
            )
            generation_usage = _add_usage(generation_usage, usage)
            if not section_parts and body:
                written_token_counter.add(body)
            preview_writer.write_progress_state(
                generation_usage,
                document_written_tokens=written_token_counter.total_tokens,
            )
            body = ("".join(section_parts) or body).strip()
            intermediate_writer.write_section(index, section_title, body, force=True)
            await preview_writer.write([*section_bodies, (section_title, body)], force=True)
            continuations = 0
            max_continuations = _max_continuations_for_target(section_target_tokens)
            while _should_continue_section(
                body,
                stop_reason=stop_reason,
                target_tokens=requested_section_target_tokens,
                model=model,
                minimum_ratio=_section_completion_floor_ratio(target_tokens),
            ) and continuations < max_continuations:
                remaining_budget = _remaining_section_token_budget(
                    body,
                    section_target_tokens,
                    model=model,
                    allow_overrun=allow_section_overrun,
                )
                if remaining_budget is not None and remaining_budget <= 0:
                    break
                continuation_parts: list[str] = []

                async def _on_continuation_delta(delta: str, *, _section_title: str = section_title) -> None:
                    continuation_parts.append(delta)
                    written_token_counter.add(delta)
                    current = _append_continuation(body, "".join(continuation_parts))
                    intermediate_writer.write_section(index, _section_title, current)
                    preview_writer.write_progress_state(
                        generation_usage,
                        document_written_tokens=written_token_counter.total_tokens,
                        phase="continuation",
                        phase_label="섹션 이어쓰기 중",
                        outline_sections=outline_sections,
                        section_index=index,
                        section_total=len(sections),
                        section_title=_section_title,
                        section_summary=section_summary,
                        continuation_index=continuations + 1,
                    )
                    await preview_writer.write([*section_bodies, (_section_title, current)])

                continuation, stop_reason, usage = await _request_text(
                    api_client,
                    model=model,
                    system_prompt=system_prompt,
                    reasoning_effort=reasoning_effort,
                    prompt=_continuation_prompt(
                        arguments.title,
                        section_title,
                        body,
                        target_tokens=requested_section_target_tokens,
                        model=model,
                        design_brief=report_design_brief,
                    ),
                    max_tokens=_section_request_max_tokens(section_target_tokens, token_limits["section"]),
                    max_collected_tokens=remaining_budget,
                    on_delta=_on_continuation_delta,
                )
                generation_usage = _add_usage(generation_usage, usage)
                if not continuation_parts and continuation:
                    written_token_counter.add(continuation)
                preview_writer.write_progress_state(
                    generation_usage,
                    document_written_tokens=written_token_counter.total_tokens,
                    phase="continuation",
                    phase_label="섹션 이어쓰기 중",
                    outline_sections=outline_sections,
                    section_index=index,
                    section_total=len(sections),
                    section_title=section_title,
                    section_summary=section_summary,
                    continuation_index=continuations + 1,
                )
                continuation = "".join(continuation_parts) or continuation
                if not continuation.strip():
                    break
                body = _append_continuation(body, continuation)
                intermediate_writer.write_section(index, section_title, body, force=True)
                await preview_writer.write([*section_bodies, (section_title, body)], force=True)
                continuations += 1
            section_bodies.append((section_title, body.strip()))
            section_summaries.append(_short_summary(section_title, body))

        style_audit_text = ""
        revised_section_ids: list[str] = []
        if _should_run_style_consistency_revision(arguments, target_tokens, section_bodies):
            preview_writer.write_progress_state(
                generation_usage,
                document_written_tokens=written_token_counter.total_tokens,
                phase="style_audit",
                phase_label="문체와 구조 일관성 점검 중",
                outline_sections=outline_sections,
                section_total=len(sections),
            )
            style_audit_parts: list[str] = []

            async def _on_style_audit_delta(delta: str) -> None:
                style_audit_parts.append(delta)
                current_audit = "".join(style_audit_parts)
                preview_writer.write_progress_state(
                    generation_usage,
                    document_written_tokens=written_token_counter.total_tokens,
                    phase="style_audit",
                    phase_label="문체와 구조 일관성 점검 중",
                    outline_sections=outline_sections,
                    section_total=len(sections),
                    section_summary=_short_progress_excerpt(current_audit),
                )
                await preview_writer.write([*section_bodies, ("문체와 구조 일관성 점검 중", current_audit)])

            style_audit_text, _, usage = await _request_text(
                api_client,
                model=model,
                system_prompt=system_prompt,
                reasoning_effort=reasoning_effort,
                prompt=_style_consistency_audit_prompt(arguments.title, section_bodies, model=model),
                max_tokens=min(2_000, token_limits["review"]),
                on_delta=_on_style_audit_delta,
            )
            style_audit_text = ("".join(style_audit_parts) or style_audit_text).strip()
            generation_usage = _add_usage(generation_usage, usage)
            intermediate_writer.write_style_audit(style_audit_text)
            revision_ids = _section_ids_for_style_revision(style_audit_text, section_count=len(section_bodies))
            if revision_ids:
                updated_section_bodies = list(section_bodies)
                for section_id in revision_ids[:2]:
                    section_index = int(section_id.rsplit("-", 1)[-1]) - 1
                    section_title, current_body = updated_section_bodies[section_index]
                    preview_writer.write_progress_state(
                        generation_usage,
                        document_written_tokens=written_token_counter.total_tokens,
                        phase="style_revision",
                        phase_label="섹션 문체와 구조 수정 중",
                        outline_sections=outline_sections,
                        section_index=section_index + 1,
                        section_total=len(sections),
                        section_title=section_title,
                        section_summary=_outline_section_summary(
                            outline_sections[section_index] if section_index < len(outline_sections) else {}
                        ),
                    )
                    revision_parts: list[str] = []

                    async def _on_revision_delta(delta: str, *, _section_index: int = section_index, _section_title: str = section_title) -> None:
                        revision_parts.append(delta)
                        current_revision = "".join(revision_parts)
                        preview_writer.write_progress_state(
                            generation_usage,
                            document_written_tokens=written_token_counter.total_tokens,
                            phase="style_revision",
                            phase_label="섹션 문체와 구조 수정 중",
                            outline_sections=outline_sections,
                            section_index=_section_index + 1,
                            section_total=len(sections),
                            section_title=_section_title,
                            section_summary=_short_progress_excerpt(current_revision),
                        )
                        await preview_writer.write(
                            [*section_bodies, (f"{_section_title} 수정안 작성 중", current_revision)]
                        )

                    revised_body, _, usage = await _request_text(
                        api_client,
                        model=model,
                        system_prompt=system_prompt,
                        reasoning_effort=reasoning_effort,
                        prompt=_style_revision_prompt(
                            arguments.title,
                            section_id,
                            section_title,
                            current_body,
                            style_audit_text,
                        ),
                        max_tokens=token_limits["section"],
                        on_delta=_on_revision_delta,
                    )
                    revised_body = ("".join(revision_parts) or revised_body).strip()
                    generation_usage = _add_usage(generation_usage, usage)
                    if revised_body.strip():
                        written_token_counter.add(revised_body)
                        updated_section_bodies[section_index] = (section_title, revised_body.strip())
                        revised_section_ids.append(section_id)
                        intermediate_writer.write_section(
                            section_index + 1,
                            section_title,
                            revised_body.strip(),
                            variant="revised",
                            force=True,
                        )
                if revised_section_ids:
                    section_bodies = updated_section_bodies
                    section_summaries = [_short_summary(title, body) for title, body in section_bodies]
                    await preview_writer.write(section_bodies, force=True)
            preview_writer.write_progress_state(
                generation_usage,
                document_written_tokens=written_token_counter.total_tokens,
                phase="style_audit_done",
                phase_label="문체와 구조 일관성 점검 완료",
                outline_sections=outline_sections,
                section_total=len(sections),
            )

        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
            phase="review",
            phase_label="검토 요약 작성 중",
            outline_sections=outline_sections,
            section_total=len(sections),
        )
        review_parts: list[str] = []

        async def _on_review_delta(delta: str) -> None:
            review_parts.append(delta)
            current_review = "".join(review_parts)
            preview_writer.write_progress_state(
                generation_usage,
                document_written_tokens=written_token_counter.total_tokens,
                phase="review",
                phase_label="검토 요약 작성 중",
                outline_sections=outline_sections,
                section_total=len(sections),
                section_summary=_short_progress_excerpt(current_review),
            )
            await preview_writer.write(section_bodies, review_text=current_review)

        review_text, _, usage = await _request_text(
            api_client,
            model=model,
            system_prompt=system_prompt,
            reasoning_effort=reasoning_effort,
            prompt=_review_prompt(arguments.title, section_summaries),
            max_tokens=token_limits["review"],
            on_delta=_on_review_delta,
        )
        review_text = ("".join(review_parts) or review_text).strip()
        generation_usage = _add_usage(generation_usage, usage)
        if review_text:
            written_token_counter.add(review_text)
        intermediate_writer.write_review(review_text)
        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
            phase="merge",
            phase_label="최종 보고서 병합 중",
            outline_sections=outline_sections,
            section_total=len(sections),
        )

        report_text = _render_report(
            arguments.title,
            section_bodies,
            review_text,
            output_format=output_format,
            target_tokens=target_tokens,
            model=model,
            source_references=_source_reference_candidates(arguments),
        )
        intermediate_writer.write_assembled_report(report_text, output_format=output_format)
        output_path.write_text(
            report_text,
            encoding="utf-8",
        )
        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
            phase="done",
            phase_label="장문 보고서 생성 완료",
            outline_sections=outline_sections,
            section_total=len(sections),
        )
        ledger = _build_report_ledger(
            arguments,
            output_path=output_path,
            output_format=output_format,
            target_tokens=target_tokens,
            source_text=source_text,
            section_bodies=section_bodies,
            review_text=review_text,
            style_audit_text=style_audit_text,
            revised_section_ids=revised_section_ids,
            model=model,
        )
        ledger_path = _write_report_ledger(output_path, ledger)
        display_path = display_tool_path(output_path, context.cwd)
        display_ledger_path = display_tool_path(ledger_path, context.cwd)
        estimated_tokens = estimate_tokens(report_text, model=model)
        written_tokens = written_token_counter.total_tokens
        token_note = (
            f", 문서 약 {estimated_tokens:,} tokens"
            f", 작성 사용량 합계 {written_tokens:,} tokens"
            f", 모델 호출 합계 {generation_usage.total_tokens:,} tokens"
            f" (입력 {generation_usage.input_tokens:,} / 출력 {generation_usage.output_tokens:,})"
        )
        if target_tokens:
            token_note += f" / 목표 {target_tokens:,}"
        output = (
            f"장문 보고서를 생성했습니다: {display_path} "
            f"(섹션 {len(section_bodies)}개{token_note}, 근거 ledger {display_ledger_path}, "
            f"중간 산출물 {display_tool_path(intermediate_writer.root_dir, context.cwd)})"
        )
        return ToolResult(
            output=output,
            metadata={
                "model_output": output,
                "display_output": "장문 보고서 생성 완료",
                "path": str(output_path),
                "estimated_tokens": estimated_tokens,
                "target_tokens": target_tokens,
                "document_written_tokens": written_tokens,
                "usage_input_tokens": generation_usage.input_tokens,
                "usage_output_tokens": generation_usage.output_tokens,
                "usage_total_tokens": generation_usage.total_tokens,
                "section_count": len(section_bodies),
                "ledger_path": str(ledger_path),
                "intermediate_dir": str(intermediate_writer.root_dir),
                "intermediate_manifest_path": str(intermediate_writer.manifest_path),
                "source_notes_present": bool(arguments.source_notes.strip()),
                "source_path_count": len(arguments.source_paths),
                "style_audit_present": bool(style_audit_text.strip()),
                "style_revised_section_ids": revised_section_ids,
                "target_adherence": ledger.get("target_adherence", {}),
                "quality_warnings": ledger.get("quality", {}).get("warnings", []),
            },
        )


class _ReportPreviewWriter:
    def __init__(
        self,
        *,
        cwd: Path,
        output_path: Path,
        title: str,
        output_format: Literal["markdown", "html"],
        target_tokens: int,
        model: str | None,
        intermediate_snapshot: Callable[[], list[dict[str, object]]] | None = None,
        intermediate_dir: str = "",
    ) -> None:
        self.cwd = cwd
        self.output_path = output_path
        self.title = title
        self.output_format = output_format
        self.target_tokens = target_tokens
        self.model = model
        self.intermediate_snapshot = intermediate_snapshot
        self.intermediate_dir = intermediate_dir
        self._last_write_at = 0.0

    def write_progress_state(
        self,
        usage: UsageSnapshot,
        *,
        document_written_tokens: int = 0,
        phase: str = "",
        phase_label: str = "",
        outline_sections: list[dict[str, object]] | None = None,
        section_index: int = 0,
        section_total: int = 0,
        section_title: str = "",
        section_summary: str = "",
        continuation_index: int = 0,
    ) -> None:
        write_long_report_progress_state(
            self.cwd,
            self.output_path,
            usage=usage,
            document_written_tokens=document_written_tokens,
            phase=phase,
            phase_label=phase_label,
            outline_sections=outline_sections,
            section_index=section_index,
            section_total=section_total,
            section_title=section_title,
            section_summary=section_summary,
            continuation_index=continuation_index,
            intermediate_dir=self.intermediate_dir,
            intermediate_files=self.intermediate_snapshot() if self.intermediate_snapshot else None,
        )

    async def write(
        self,
        section_bodies: list[tuple[str, str]],
        *,
        review_text: str = "",
        force: bool = False,
    ) -> None:
        now = time.monotonic()
        if not force and now - self._last_write_at < 0.5:
            return
        self._last_write_at = 0.0 if force else now
        self.output_path.write_text(
            _render_report(
                self.title,
                section_bodies,
                review_text,
                output_format=self.output_format,
                target_tokens=self.target_tokens,
                model=self.model,
            ),
            encoding="utf-8",
        )

    async def write_stage_text(self, stage_title: str, text: str, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_write_at < 0.5:
            return
        self._last_write_at = 0.0 if force else now
        self.output_path.write_text(
            _render_stage_preview(
                self.title,
                stage_title,
                text,
                output_format=self.output_format,
            ),
            encoding="utf-8",
        )


class _LongReportIntermediateArtifacts:
    def __init__(self, *, output_path: Path, title: str) -> None:
        self.output_path = output_path
        self.title = title
        self.root_dir = output_path.with_name(f"{output_path.stem}.intermediate")
        self.sections_dir = self.root_dir / "sections"
        self.manifest_path = self.root_dir / "manifest.json"
        self._last_section_write_at: dict[str, float] = {}
        self._files: dict[str, str] = {}
        self.sections_dir.mkdir(parents=True, exist_ok=True)
        self._write_manifest()

    def write_outline(self, outline_text: str, outline_sections: list[dict[str, object]]) -> None:
        content = [
            f"# {self.title} - 보고서 뼈대",
            "",
            "## 구조화된 섹션",
            "",
            json.dumps(outline_sections, ensure_ascii=False, indent=2),
            "",
            "## 원문 outline",
            "",
            outline_text.strip(),
            "",
        ]
        self._write_file("outline", self.root_dir / "outline.md", "\n".join(content))

    def write_outline_draft(self, outline_text: str) -> None:
        if not outline_text.strip():
            return
        content = [
            f"# {self.title} - 보고서 뼈대 작성 중",
            "",
            outline_text.strip(),
            "",
        ]
        self._write_file("outline", self.root_dir / "outline.md", "\n".join(content))

    def write_design_brief(self, design_brief: str) -> None:
        self._write_file(
            "design-brief",
            self.root_dir / "design_brief.md",
            f"# {self.title} - 디자인·문체 계약\n\n{design_brief.strip()}\n",
        )

    def write_section(
        self,
        index: int,
        title: str,
        body: str,
        *,
        variant: str = "draft",
        force: bool = False,
    ) -> None:
        clean_variant = _slugify_title(variant).lower()
        path = self.sections_dir / f"{index:02d}_{_slugify_title(title)}"
        path = path.with_name(f"{path.name}.{clean_variant}.md")
        key = str(path)
        now = time.monotonic()
        if not force and now - self._last_section_write_at.get(key, 0.0) < 1.0:
            return
        self._last_section_write_at[key] = now
        content = f"# {index}. {title}\n\n{body.strip()}\n"
        self._write_file(f"section-{index:02d}-{clean_variant}", path, content)

    def write_style_audit(self, style_audit_text: str) -> None:
        if not style_audit_text.strip():
            return
        self._write_file(
            "style-audit",
            self.root_dir / "style_audit.md",
            f"# {self.title} - 문체와 구조 감사\n\n{style_audit_text.strip()}\n",
        )

    def write_review(self, review_text: str) -> None:
        self._write_file(
            "review",
            self.root_dir / "review.md",
            f"# {self.title} - 검토 요약\n\n{review_text.strip()}\n",
        )

    def write_assembled_report(self, report_text: str, *, output_format: Literal["markdown", "html"]) -> None:
        suffix = ".html" if output_format == "html" else ".md"
        self._write_file("assembled-report", self.root_dir / f"assembled_report{suffix}", report_text)

    def display_root(self, cwd: Path) -> str:
        try:
            return self.root_dir.resolve().relative_to(cwd.resolve()).as_posix()
        except ValueError:
            return str(self.root_dir.resolve())

    def progress_files(self, cwd: Path) -> list[dict[str, object]]:
        files: list[dict[str, object]] = []
        for label, raw_path in self._files.items():
            path = Path(raw_path)
            try:
                stat = path.stat()
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            try:
                display_path = path.resolve().relative_to(cwd.resolve()).as_posix()
            except ValueError:
                display_path = str(path.resolve())
            files.append(
                {
                    "label": label,
                    "path": display_path,
                    "size_bytes": stat.st_size,
                    "line_count": text.count("\n") + (1 if text else 0),
                    "updated_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                }
            )
        return sorted(files, key=lambda item: str(item.get("updated_at") or ""), reverse=True)

    def _write_file(self, label: str, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self._files[label] = str(path)
        self._write_manifest()

    def _write_manifest(self) -> None:
        manifest = {
            "title": self.title,
            "output_path": str(self.output_path),
            "intermediate_dir": str(self.root_dir),
            "files": self._files,
        }
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


class _CumulativeTokenCounter:
    def __init__(self, *, model: str | None) -> None:
        self.model = model
        self.total_tokens = 0

    def add(self, text: str) -> int:
        if not text:
            return self.total_tokens
        self.total_tokens += estimate_tokens(text, model=self.model)
        return self.total_tokens


def _is_streaming_client(value: Any) -> bool:
    return hasattr(value, "stream_message")


def _add_usage(left: UsageSnapshot, right: UsageSnapshot) -> UsageSnapshot:
    return UsageSnapshot(
        input_tokens=left.input_tokens + right.input_tokens,
        output_tokens=left.output_tokens + right.output_tokens,
    )


def _resolve_output_path(cwd: Path, output_path: str, title: str, output_format: str = "auto") -> Path:
    suffix = ".html" if output_format == "html" else ".md"
    candidate = output_path.strip() or f"outputs/{_slugify_title(title)}_report{suffix}"
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return path.resolve()


def _resolve_output_format(arguments: LongReportToolInput, output_path: Path) -> Literal["markdown", "html"]:
    if arguments.output_format in {"markdown", "html"}:
        return arguments.output_format
    if output_path.suffix.lower() in {".html", ".htm"}:
        return "html"
    return "markdown"


def _resolve_target_tokens(arguments: LongReportToolInput) -> int:
    if arguments.target_tokens > 0:
        return min(arguments.target_tokens, REPORT_TOKEN_HARD_CAP)
    text = f"{arguments.title}\n{arguments.brief}"
    k_match = re.search(r"\b(\d{1,3}(?:\.\d+)?)\s*k\b\s*(?:tokens?|토큰)?", text, flags=re.IGNORECASE)
    if k_match:
        return min(int(float(k_match.group(1)) * 1_000), REPORT_TOKEN_HARD_CAP)
    man_match = re.search(r"(\d{1,3})\s*만\s*(?:tokens?|토큰)?", text, flags=re.IGNORECASE)
    if man_match:
        return min(int(man_match.group(1)) * 10_000, REPORT_TOKEN_HARD_CAP)
    token_match = re.search(
        r"(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:tokens?|토큰)",
        text,
        flags=re.IGNORECASE,
    )
    if token_match:
        return min(int(token_match.group(1).replace(",", "")), REPORT_TOKEN_HARD_CAP)
    if _implies_extra_long_report(arguments.brief):
        return IMPLIED_EXTRA_LONG_REPORT_TARGET_TOKENS
    if _implies_long_report(arguments.brief):
        return IMPLIED_LONG_REPORT_TARGET_TOKENS
    return 0


def _implies_long_report(text: str) -> bool:
    normalized = str(text or "").strip()
    if not normalized:
        return False
    patterns = (
        r"길게\s*(?:작성|써|서술|정리|해)",
        r"긴\s*(?:보고서|리포트)",
        r"\blong(?:er)?\b",
    )
    return any(re.search(pattern, normalized, flags=re.IGNORECASE) for pattern in patterns)


def _implies_extra_long_report(text: str) -> bool:
    normalized = str(text or "").strip()
    if not normalized:
        return False
    patterns = (
        r"초\s*장문",
        r"대\s*보고서",
        r"아주\s*아주\s*길게",
        r"매우\s*(?:디테일|상세|자세)",
        r"극도로\s*(?:디테일|상세|자세)",
        r"(?:엄청|굉장히|진짜)\s*길게",
        r"\b(?:very|extremely|highly)\s+detailed\b",
        r"\bexhaustive\b",
        r"\bdeep\s+dive\b",
        r"\b\d+\s*[-~]\s*\d+\s*[x×]\b",
        r"\b\d+\s*[x×]\b",
    )
    return any(re.search(pattern, normalized, flags=re.IGNORECASE) for pattern in patterns)


def _target_tokens_per_section(
    *,
    target_tokens: int,
    section_count: int,
    section_cap: int,
    minimum_per_section: int = 2_500,
) -> int:
    if target_tokens <= 0 or section_count <= 0:
        return 0
    del section_cap
    per_section = (target_tokens + section_count - 1) // section_count
    return max(minimum_per_section, per_section)


def _section_request_max_tokens(section_target_tokens: int, section_cap: int) -> int:
    if section_target_tokens <= 0:
        return section_cap
    return min(section_cap, max(1_000, int(section_target_tokens * 1.05)))


def _section_collected_token_budget(section_target_tokens: int, *, allow_overrun: bool = True) -> int | None:
    if section_target_tokens <= 0:
        return None
    multiplier = 1.2 if allow_overrun else 1.0
    return max(1_000, int(section_target_tokens * multiplier))


def _remaining_section_token_budget(
    body: str,
    section_target_tokens: int,
    *,
    model: str,
    allow_overrun: bool = True,
) -> int | None:
    section_budget = _section_collected_token_budget(section_target_tokens, allow_overrun=allow_overrun)
    if section_budget is None:
        return None
    current_tokens = estimate_tokens(body, model=model)
    return max(0, section_budget - current_tokens)


def _max_continuations_for_target(section_target_tokens: int) -> int:
    if section_target_tokens <= 0:
        return 2
    if section_target_tokens >= 60_000:
        return 8
    if section_target_tokens >= 30_000:
        return 6
    if section_target_tokens >= 10_000:
        return 4
    if section_target_tokens >= 6_000:
        return 3
    return 2


def _section_completion_floor_ratio(report_target_tokens: int) -> float:
    if report_target_tokens >= 40_000:
        return 0.8
    return 0.9


def _slugify_title(title: str) -> str:
    cleaned = re.sub(r"\s+", "_", title.strip())
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", cleaned)
    return cleaned.strip("._") or "long_report"


def _source_material_for_report(cwd: Path, arguments: LongReportToolInput) -> str:
    chunks: list[str] = []
    source_notes = arguments.source_notes.strip()
    if source_notes:
        chunks.append(f"## Research notes\n{source_notes[:SOURCE_NOTES_MAX_CHARS]}")
    file_sources = _read_source_material(cwd, arguments.source_paths)
    if file_sources:
        chunks.append(file_sources)
    return "\n\n".join(chunks)[:160_000]


def _read_source_material(cwd: Path, source_paths: list[str]) -> str:
    chunks: list[str] = []
    for raw_path in source_paths[:10]:
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = cwd / path
        try:
            text = path.resolve().read_text(encoding="utf-8")
        except OSError:
            continue
        chunks.append(f"## Source: {raw_path}\n{text[:20_000]}")
    return "\n\n".join(chunks)[:160_000]


def _report_ledger_path(output_path: Path) -> Path:
    return output_path.with_name(f"{output_path.name}.ledger.json")


def _write_report_ledger(output_path: Path, ledger: dict[str, object]) -> Path:
    ledger_path = _report_ledger_path(output_path)
    ledger_path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
    return ledger_path


def _requires_external_research(arguments: LongReportToolInput) -> bool:
    text = f"{arguments.title}\n{arguments.brief}".lower()
    patterns = (
        r"최신",
        r"최근",
        r"현황",
        r"시장",
        r"경쟁",
        r"정책",
        r"규제",
        r"조사",
        r"리서치",
        r"출처",
        r"근거",
        r"\bresearch\b",
        r"\bmarket\b",
        r"\bcurrent\b",
        r"\blatest\b",
        r"\bsource",
    )
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in patterns)


def _source_reference_candidates(arguments: LongReportToolInput) -> list[dict[str, str]]:
    references: list[dict[str, str]] = []
    if arguments.source_notes.strip():
        references.append(_source_notes_reference(arguments.source_notes))
    for index, raw_path in enumerate(arguments.source_paths[:10], start=1):
        references.append({"id": f"source_path_{index}", "type": "file", "label": raw_path})
    return references


def _source_notes_reference(source_notes: str) -> dict[str, str]:
    title_match = re.search(r"(?im)^\s*title\s*:\s*(.+?)\s*$", source_notes)
    date_match = re.search(r"(?im)^\s*date\s*:\s*(.+?)\s*$", source_notes)
    url_match = re.search(r"https?://[^\s)>\]]+", source_notes)
    reference = {
        "id": "source_notes",
        "type": "research_notes",
        "label": title_match.group(1).strip() if title_match else "Research notes",
    }
    if date_match:
        reference["date"] = date_match.group(1).strip()
    if url_match:
        reference["url"] = url_match.group(0).strip().rstrip(".,")
    return reference


def _claim_candidates(body: str, *, limit: int = 8) -> list[str]:
    normalized = " ".join(str(body or "").split())
    if not normalized:
        return []
    candidates: list[str] = []
    sentence_parts = re.split(r"(?<=[.!?。！？다요죠함음임됨니다])\s+", normalized)
    signal = re.compile(
        r"(\d|%|％|년|월|분기|조|억|만|달러|원|증가|감소|상승|하락|점유|규모|전망|리스크|risk|market|growth)",
        flags=re.IGNORECASE,
    )
    for sentence in sentence_parts:
        cleaned = sentence.strip()
        if len(cleaned) < 20:
            continue
        if signal.search(cleaned):
            candidates.append(cleaned[:500])
        if len(candidates) >= limit:
            break
    if not candidates and sentence_parts:
        first = sentence_parts[0].strip()
        if first:
            candidates.append(first[:500])
    return candidates


def _should_run_style_consistency_revision(
    arguments: LongReportToolInput,
    target_tokens: int,
    section_bodies: list[tuple[str, str]],
) -> bool:
    if len(section_bodies) < 2:
        return False
    if target_tokens >= 20_000:
        return True
    return bool(arguments.source_notes.strip() or arguments.source_paths)


def _section_ids_for_style_revision(audit_text: str, *, section_count: int) -> list[str]:
    if not audit_text.strip():
        return []
    lowered = audit_text.strip().lower()
    if lowered in {"ok", "pass", "no issues", "no issue", "none"}:
        return []
    ids: list[str] = []
    for match in re.finditer(r"\b(?:rewrite|revise|fix)\s+section[-_\s]*(\d{1,2})\b", audit_text, flags=re.IGNORECASE):
        index = int(match.group(1))
        if 1 <= index <= section_count:
            section_id = f"section-{index}"
            if section_id not in ids:
                ids.append(section_id)
    return ids


def _build_report_ledger(
    arguments: LongReportToolInput,
    *,
    output_path: Path,
    output_format: Literal["markdown", "html"],
    target_tokens: int,
    source_text: str,
    section_bodies: list[tuple[str, str]],
    review_text: str,
    model: str,
    style_audit_text: str = "",
    revised_section_ids: list[str] | None = None,
) -> dict[str, object]:
    references = _source_reference_candidates(arguments)
    warnings: list[str] = []
    requires_external_research = _requires_external_research(arguments)
    if requires_external_research and not source_text.strip():
        warnings.append(
            "This report request appears to need external research, but no source_notes or source_paths were provided to write_long_report."
        )
    if source_text.strip() and not references:
        warnings.append("Source material was present but no structured source references were recorded.")
    source_ids = [reference["id"] for reference in references]
    sections: list[dict[str, object]] = []
    estimated_body_tokens = 0
    for index, (section_title, body) in enumerate(section_bodies, start=1):
        section_estimated_tokens = estimate_tokens(body, model=model)
        estimated_body_tokens += section_estimated_tokens
        claims = [
            {
                "text": claim,
                "status": "candidate",
                "citation_candidates": source_ids,
            }
            for claim in _claim_candidates(body)
        ]
        sections.append(
            {
                "id": f"section-{index}",
                "title": section_title,
                "estimated_tokens": section_estimated_tokens,
                "summary": _short_summary(section_title, body),
                "claims": claims,
            }
        )
    target_ratio = (estimated_body_tokens / target_tokens) if target_tokens else None
    if target_ratio is not None and target_ratio < 0.8:
        warnings.append(
            "Estimated body tokens are below 80% of the requested target; source/detail scarcity or model stop behavior may have limited expansion."
        )
    return {
        "version": 1,
        "report_path": str(output_path),
        "title": arguments.title,
        "output_format": output_format,
        "target_tokens": target_tokens,
        "target_adherence": {
            "target_tokens": target_tokens,
            "estimated_body_tokens": estimated_body_tokens,
            "ratio": round(target_ratio, 3) if target_ratio is not None else None,
            "status": "not_requested"
            if not target_tokens
            else ("low" if target_ratio is not None and target_ratio < 0.8 else "approximate"),
        },
        "research": {
            "requires_external_research": requires_external_research,
            "source_notes_present": bool(arguments.source_notes.strip()),
            "source_path_count": len(arguments.source_paths),
            "source_material_estimated_tokens": estimate_tokens(source_text, model=model) if source_text else 0,
            "sources": references,
        },
        "sections": sections,
        "review": {
            "present": bool(review_text.strip()),
            "estimated_tokens": estimate_tokens(review_text, model=model) if review_text else 0,
        },
        "style_consistency": {
            "audit_present": bool(style_audit_text.strip()),
            "audit_summary": style_audit_text.strip()[:2_000],
            "revised_section_ids": revised_section_ids or [],
        },
        "quality": {
            "status": "style_checked" if style_audit_text.strip() else "unchecked",
            "warnings": warnings,
            "next_checks": [
                "verify_candidate_claims_against_sources",
                "check_section_coverage_and_balance",
                "check_style_terminology_and_unit_consistency",
                "flag_unsupported_claims_before_public_use",
            ],
        },
    }


def _fallback_outline_text(arguments: LongReportToolInput, source_text: str) -> str:
    source_hint = "제공된 SQLite/분석 결과와 사용자가 요청한 보고서 목적을 함께 근거로 삼습니다."
    if source_text.strip():
        source_hint = "제공된 조사 메모, 쿼리 결과, 데이터 요약을 근거로 삼습니다."
    base_sections = [
        {
            "title": "데이터 범위와 분석 기준",
            "intent": "사용한 데이터의 기간, 필드, 단위, 해석 기준을 먼저 고정합니다.",
            "key_points": ["데이터 구조", "기간과 단위", "분석 한계"],
            "analysis_angle": source_hint,
        },
        {
            "title": "전체 추세와 핵심 지표",
            "intent": "전체 평균, 최고·최저, 변동 폭으로 큰 흐름을 설명합니다.",
            "key_points": ["전체 추세", "핵심 수치", "전환점"],
            "analysis_angle": "장기 흐름과 단기 충격을 분리해 봅니다.",
        },
        {
            "title": "세부 그룹별 비교",
            "intent": "산업·기간·범주별 차이를 비교해 구조적 특징을 찾습니다.",
            "key_points": ["상위 그룹", "하위 그룹", "격차"],
            "analysis_angle": "평균 수준과 변동성을 함께 비교합니다.",
        },
        {
            "title": "규모와 비중의 구조",
            "intent": "비율만으로 보이지 않는 절대 규모와 기여도를 함께 해석합니다.",
            "key_points": ["규모 효과", "점유율", "절대 수치"],
            "analysis_angle": "높은 비율과 큰 절대 규모가 다른 신호를 줄 수 있음을 분리합니다.",
        },
        {
            "title": "충격 구간과 변동성",
            "intent": "급등·급락 시점과 민감도가 큰 항목을 중심으로 원인을 해석합니다.",
            "key_points": ["위기 구간", "변동성", "회복 속도"],
            "analysis_angle": "충격 전후의 차이와 지속성을 확인합니다.",
        },
        {
            "title": "시계열 전환점과 국면 변화",
            "intent": "기간별 흐름을 구간으로 나누어 상승·하락·정체 국면을 설명합니다.",
            "key_points": ["전환점", "국면", "추세 지속성"],
            "analysis_angle": "연도별 평균과 월별 움직임을 함께 봅니다.",
        },
        {
            "title": "계절성 및 반복 패턴",
            "intent": "월별·분기별 반복 패턴이 있는지 확인하고 해석상 주의점을 정리합니다.",
            "key_points": ["월별 패턴", "반복성", "계절 요인"],
            "analysis_angle": "구조 변화와 계절 변동을 혼동하지 않도록 분리합니다.",
        },
        {
            "title": "최고·최저 이벤트와 이상치",
            "intent": "극단값과 피크 이벤트가 전체 결론에 미치는 영향을 따져봅니다.",
            "key_points": ["최고점", "최저점", "이상치"],
            "analysis_angle": "일회성 이벤트와 지속적 취약성을 구분합니다.",
        },
        {
            "title": "유형화와 리스크 그룹",
            "intent": "평균 수준, 변동성, 규모를 조합해 유사 그룹을 나눕니다.",
            "key_points": ["고위험 그룹", "방어적 그룹", "혼합형"],
            "analysis_angle": "단일 순위보다 유형별 의사결정 단서를 도출합니다.",
        },
        {
            "title": "해석상 한계와 검증 포인트",
            "intent": "데이터 범위, 부분연도, 단위 불확실성처럼 결론을 제한하는 요소를 명시합니다.",
            "key_points": ["데이터 한계", "단위", "추가 검증"],
            "analysis_angle": "확인된 사실과 추정 해석을 분리합니다.",
        },
        {
            "title": "시사점과 활용 방안",
            "intent": "분석 결과가 의사결정, 리스크 관리, 추가 조사에 주는 의미를 정리합니다.",
            "key_points": ["실무 시사점", "주의점", "후속 분석"],
            "analysis_angle": "데이터에서 확인된 사실과 해석상 가정을 분리합니다.",
        },
    ]
    sections = base_sections[: max(1, min(arguments.max_sections, len(base_sections)))]
    return json.dumps({"sections": sections}, ensure_ascii=False)


def _report_design_brief(arguments: LongReportToolInput, *, output_format: Literal["markdown", "html"]) -> str:
    if output_format != "html":
        return (
            "최종 산출물 형식: Markdown 보고서\n"
            "문체: 공식 비즈니스 보고서체\n"
            "구성: 섹션별 논리 흐름, 정확한 표, 근거와 caveat를 우선합니다.\n"
            "섹션 작성 방식: 각 섹션은 나중에 다시 LLM으로 재작성하지 않고 최종 보고서에 바로 들어갈 본문 조각입니다."
        )
    return (
        "최종 산출물 형식: 독자-facing HTML 웹보고서\n"
        "시각 언어: `visual-artifact` 기준의 회의용 보고서. 큰 장식보다 밀도 있는 정보 계층, 정확한 표, "
        "차트화 가능한 데이터, workflow/timeline 도식을 우선합니다.\n"
        "문체: 공식 비즈니스 보고서체. 같은 지표명, 단위, 기간, 산업명 표기를 끝까지 통일합니다.\n"
        "섹션 작성 방식: 각 섹션은 나중에 다시 LLM으로 재작성하지 않고 최종 HTML에 바로 들어갈 본문 조각입니다. "
        "따라서 처음부터 표, 수치, 비교축, 단계 흐름을 분리해 작성합니다.\n"
        "독자 관점: 제작 과정 메타데이터, 토큰 예산, 모델/도구 정보, 내부 진행 지표는 본문에 쓰지 않습니다.\n"
        f"보고서 제목: {arguments.title}\n"
        f"작성 요구: {arguments.brief}"
    )


def _section_prompt(
    *,
    title: str,
    brief: str,
    section_title: str,
    source_text: str,
    prior_summaries: list[str],
    index: int,
    total: int,
    target_tokens: int,
    output_format: Literal["markdown", "html"] = "markdown",
    design_brief: str = "",
) -> str:
    prior = "\n".join(prior_summaries[-5:])
    length_instruction = ""
    if target_tokens > 0:
        length_instruction = (
            f"이 섹션의 목표 분량은 약 {target_tokens:,} tokens입니다. "
            "요약 초안으로 끝내지 말고, 하위 소제목·근거·사례·반론·영향 분석을 충분히 펼쳐 쓰세요. "
            "최소 목표에 못 미칠 것 같으면 스스로 내용을 더 확장하세요.\n"
        )
    visual_instruction = ""
    if output_format == "html":
        visual_instruction = (
            "`visual-artifact` 기준의 HTML 보고서로 렌더링될 예정입니다. "
            "독자-facing 본문을 작성하고, 제작 과정 메타데이터나 내부 진행 지표는 본문에 넣지 마세요. "
            "핵심 수치, 순위, 기간별 변화, 그룹 비교, 비중, 리스크 등은 차트와 표로 바꾸기 쉽도록 분리해 쓰고, "
            "절차, 인과관계, 분석 workflow, 의사결정 흐름은 단계형 목록이나 타임라인으로 구조화하세요. "
            "가능하면 Markdown 표를 포함하세요. 시각화를 위한 데이터는 원문 문장 속에만 묻어두지 마세요.\n"
        )
    return (
        f"보고서 제목: {title}\n"
        f"전체 요구사항: {brief}\n"
        f"현재 섹션: {index}/{total} {section_title}\n"
        f"이전 섹션 요약:\n{prior or '(없음)'}\n\n"
        f"{STYLE_CONSISTENCY_CONTRACT}\n"
        f"디자인·문체 계약:\n{design_brief or '(없음)'}\n"
        f"{length_instruction}"
        f"{visual_instruction}"
        "현재 섹션 본문만 작성하세요. 제목 마크다운은 쓰지 마세요.\n"
        "HTML 태그를 쓰지 마세요. 본문은 일반 텍스트와 Markdown 목록/표만 사용하세요.\n"
        "표로 정리할 수 있는 수치, 연도, 기업명, 제품군, 리스크, 비교축이 있으면 Markdown 표나 목록으로 구조화하세요.\n"
        "HTML 보고서 렌더러가 차트·타임라인·비교표 후보를 만들 수 있도록 중요한 숫자와 사건은 문장 속에 묻지 말고 분리해 적으세요.\n"
        "단락 중심으로 깊게 작성하고, 목록은 스캔성이 필요할 때만 보조적으로 쓰세요.\n"
        f"참고 자료:\n{source_text or '(없음)'}"
    )


def _continuation_prompt(
    title: str,
    section_title: str,
    current_body: str,
    *,
    target_tokens: int,
    model: str,
    design_brief: str = "",
) -> str:
    current_tokens = estimate_tokens(current_body, model=model)
    if target_tokens > 0:
        reason = (
            f"현재 본문은 약 {current_tokens:,} tokens이고 목표는 약 {target_tokens:,} tokens입니다. "
            "아직 짧으므로 같은 섹션을 더 깊게 확장해야 합니다."
        )
    else:
        reason = "이전 응답이 토큰 한도로 중단됐습니다."
    return (
        f"보고서 '{title}'의 '{section_title}' 섹션을 이어서 작성합니다.\n"
        f"{reason}\n"
        f"{STYLE_CONSISTENCY_CONTRACT}\n"
        f"디자인·문체 계약:\n{design_brief or '(없음)'}\n"
        "아래 마지막 문맥을 이어서 현재 섹션 본문만 계속 작성하세요. "
        "이미 쓴 내용을 요약하거나 반복하지 말고, 누락된 분석·사례·함의·비교를 추가하세요.\n\n"
        f"마지막 문맥:\n{current_body[-4_000:]}"
    )


def _style_consistency_audit_prompt(
    title: str,
    section_bodies: list[tuple[str, str]],
    *,
    model: str,
) -> str:
    section_blocks = []
    for index, (section_title, body) in enumerate(section_bodies, start=1):
        sample = body[:4_000]
        token_count = estimate_tokens(body, model=model)
        section_blocks.append(
            f"## section-{index}: {section_title}\n"
            f"estimated_tokens: {token_count:,}\n"
            f"{sample}"
        )
    return (
        f"'{title}' 보고서의 섹션별 문체·용어·구조 일관성을 감사하세요.\n"
        f"{STYLE_CONSISTENCY_CONTRACT}\n"
        "목표 분량은 참고 가이드일 뿐이며, 이 감사에서는 분량을 맞추기 위해 내용을 줄이라고 지시하지 마세요.\n"
        "섹션별 용어, 단위, 기간, 존댓말/보고서체 혼용, 독립 요약문처럼 다시 시작하는 문제, 표/목록 밀도 차이만 보세요.\n"
        "문제가 없으면 정확히 `OK`만 쓰세요.\n"
        "특정 섹션을 고쳐야 하면 한 줄에 하나씩 `REWRITE section-N: 이유` 형식으로 쓰세요. 최대 2개 섹션만 지목하세요.\n\n"
        + "\n\n".join(section_blocks)
    )


def _style_revision_prompt(
    title: str,
    section_id: str,
    section_title: str,
    current_body: str,
    style_audit_text: str,
) -> str:
    return (
        f"보고서 '{title}'의 {section_id} '{section_title}' 섹션만 문체·용어·구조 일관성 기준에 맞게 다시 작성하세요.\n"
        f"{STYLE_CONSISTENCY_CONTRACT}\n"
        "목표 토큰 수나 기존 섹션 길이는 참고 가이드일 뿐입니다. 분량을 맞추려고 핵심 근거, 수치, 비교, caveat를 삭제하지 마세요.\n"
        "사실관계와 핵심 주장은 유지하고, 표현·용어·단위·문단 흐름만 정리하세요.\n"
        "현재 섹션 본문만 출력하세요. 제목 마크다운, 검토 메모, 변경 설명은 쓰지 마세요.\n\n"
        f"스타일 감사 결과:\n{style_audit_text.strip()}\n\n"
        f"현재 섹션 본문:\n{current_body}"
    )


def _outline_prompt(arguments: LongReportToolInput, source_text: str, *, target_tokens: int) -> str:
    source_block = f"\n\n참고 자료:\n{source_text}" if source_text else ""
    target_line = f"목표 분량: 약 {target_tokens:,} tokens\n" if target_tokens else ""
    return (
        f"'{arguments.title}' 보고서의 논리 흐름을 설계하세요.\n"
        f"요구사항: {arguments.brief}\n"
        f"{target_line}"
        f"최대 {arguments.max_sections}개 섹션으로 구성하세요.\n"
        "이 단계의 산출물은 섹션 작성자를 위한 routing brief입니다. 짧고 실행 가능한 구조만 반환하세요.\n"
        "목표 분량은 이후 섹션 본문 작성 단계의 목표입니다. 목차 단계에서 분량을 채우려 하지 마세요. 본문을 미리 쓰지 마세요.\n"
        "도메인과 자료에 맞는 구조를 판단하되, 완벽한 목차를 위해 과도하게 숙고하지 말고 즉시 JSON을 반환하세요.\n"
        "본문, 서론, 결론 문단, 제작 메타데이터, 토큰 수 설명은 쓰지 마세요.\n"
        "반드시 JSON만 출력하세요. 형식:\n"
        "{\n"
        '  "sections": [\n'
        '    {"title": "섹션 제목", "intent": "이 섹션의 역할", "key_points": ["포함할 내용"], "analysis_angle": "분석 관점"}\n'
        "  ]\n"
        "}\n"
        "각 intent, key_points, analysis_angle은 이후 섹션 작성 품질을 높일 만큼 구체적이되 간결하게 쓰세요."
        f"{source_block}"
    )


def _outline_reasoning_effort(reasoning_effort: str | None) -> str | None:
    if not reasoning_effort:
        return None
    return "minimal"


def _review_prompt(title: str, section_summaries: list[str]) -> str:
    return (
        f"'{title}' 보고서 초안의 검토 요약을 5개 bullet 이내로 작성하세요.\n"
        "중복, 누락, 후속 보완점, 문체·용어·단위 일관성 문제를 중심으로 짧게 쓰세요.\n\n"
        + "\n".join(section_summaries)
    )


async def _request_text(
    api_client: SupportsStreamingMessages,
    *,
    model: str,
    system_prompt: str | None,
    reasoning_effort: str | None,
    prompt: str,
    max_tokens: int,
    max_collected_tokens: int | None = None,
    on_delta: Callable[[str], Awaitable[None]] | None = None,
) -> tuple[str, str | None, UsageSnapshot]:
    collected = ""
    final_text = ""
    stop_reason: str | None = None
    usage = UsageSnapshot()
    local_budget = None if max_collected_tokens is None else max(0, int(max_collected_tokens))
    if local_budget == 0:
        return "", "local_token_budget", usage
    async for event in api_client.stream_message(
        ApiMessageRequest(
            model=model,
            messages=[ConversationMessage.from_user_text(prompt)],
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
        )
    ):
        if isinstance(event, ApiTextDeltaEvent):
            if local_budget is not None:
                candidate = collected + event.text
                trimmed = _trim_text_to_token_budget(candidate, local_budget, model=model)
                delta = trimmed[len(collected) :] if trimmed.startswith(collected) else ""
                if delta and on_delta is not None:
                    await on_delta(delta)
                collected = trimmed
                if trimmed != candidate or estimate_tokens(collected, model=model) >= local_budget:
                    stop_reason = "local_token_budget"
                    break
                continue
            collected += event.text
            if on_delta is not None:
                await on_delta(event.text)
        elif isinstance(event, ApiMessageCompleteEvent):
            final_text = event.message.text
            usage = event.usage
            stop_reason = event.stop_reason
    text = collected or final_text
    if local_budget is not None:
        text = _trim_text_to_token_budget(text, local_budget, model=model)
    return text.strip(), stop_reason, usage


def _trim_text_to_token_budget(text: str, token_budget: int, *, model: str) -> str:
    if token_budget <= 0:
        return ""
    value = str(text or "")
    if not value or estimate_tokens(value, model=model) <= token_budget:
        return value
    low = 0
    high = len(value)
    best = ""
    while low <= high:
        mid = (low + high) // 2
        candidate = value[:mid]
        if estimate_tokens(candidate, model=model) <= token_budget:
            best = candidate
            low = mid + 1
        else:
            high = mid - 1
    return _trim_to_complete_boundary(best).rstrip()


def _trim_to_complete_boundary(text: str) -> str:
    value = str(text or "").rstrip()
    if not value:
        return value
    paragraph_break = max(value.rfind("\n\n"), value.rfind("\r\n\r\n"))
    if paragraph_break >= max(0, int(len(value) * 0.6)):
        return value[:paragraph_break].rstrip()
    for pattern in (
        r"(?s)^(.{1,})([.!?。！？다요죠함음임됨됨니다]\s*)$",
        r"(?s)^(.{1,})([.!?。！？]\s*)",
    ):
        match = re.search(pattern, value)
        if match:
            return match.group(0).rstrip()
    word_break = value.rfind(" ")
    if word_break >= max(0, int(len(value) * 0.8)):
        return value[:word_break].rstrip()
    return value


def _parse_outline(outline_text: str, *, max_sections: int) -> list[str]:
    return [str(item.get("title") or "").strip() for item in _parse_outline_sections(outline_text, max_sections=max_sections)]


def _parse_outline_sections(outline_text: str, *, max_sections: int) -> list[dict[str, object]]:
    parsed = _parse_outline_sections_json(outline_text, max_sections=max_sections)
    if parsed:
        return parsed
    sections: list[dict[str, object]] = []
    for line in outline_text.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        cleaned = cleaned.strip("#").strip()
        if not cleaned:
            continue
        title, summary = _split_outline_line(cleaned)
        if title and all(item.get("title") != title for item in sections):
            section: dict[str, object] = {"title": title}
            if summary:
                section["intent"] = summary
            sections.append(section)
        if len(sections) >= max_sections:
            break
    return sections


def _parse_outline_sections_json(outline_text: str, *, max_sections: int) -> list[dict[str, object]]:
    raw_text = outline_text.strip()
    if raw_text.startswith("```"):
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text, flags=re.IGNORECASE).strip()
        raw_text = re.sub(r"\s*```$", "", raw_text).strip()
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError:
        return []
    candidates = raw.get("sections") if isinstance(raw, dict) else raw
    if not isinstance(candidates, list):
        return []
    sections: list[dict[str, object]] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        title = _clean_outline_text(item.get("title") or item.get("section_title"))
        if not title or any(section.get("title") == title for section in sections):
            continue
        section: dict[str, object] = {"title": title}
        intent = _clean_outline_text(item.get("intent") or item.get("section_intent") or item.get("purpose"))
        if intent:
            section["intent"] = intent
        key_points = _clean_outline_points(item.get("key_points") or item.get("keyPoints") or item.get("contents"))
        if key_points:
            section["key_points"] = key_points
        analysis_angle = _clean_outline_text(item.get("analysis_angle") or item.get("analysis") or item.get("angle"))
        if analysis_angle:
            section["analysis_angle"] = analysis_angle
        sections.append(section)
        if len(sections) >= max_sections:
            break
    return sections


def _split_outline_line(value: str) -> tuple[str, str]:
    for separator in (" - ", " — ", ": "):
        if separator in value:
            title, summary = value.split(separator, 1)
            return _clean_outline_text(title), _clean_outline_text(summary)
    return _clean_outline_text(value), ""


def _clean_outline_text(value: object, *, limit: int = 260) -> str:
    text = " ".join(str(value or "").split())
    text = text.strip(" -*#`")
    if len(text) <= limit:
        return text
    return f"{text[:limit - 3]}..."


def _clean_outline_points(value: object) -> list[str]:
    if isinstance(value, list):
        return [_clean_outline_text(item, limit=140) for item in value if _clean_outline_text(item, limit=140)][:5]
    text = _clean_outline_text(value)
    return [text] if text else []


def _outline_section_summary(section: dict[str, object]) -> str:
    intent = _clean_outline_text(section.get("intent") or section.get("section_intent"))
    key_points = _clean_outline_points(section.get("key_points") or section.get("keyPoints"))
    analysis_angle = _clean_outline_text(section.get("analysis_angle") or section.get("analysis"))
    return " · ".join([intent, ", ".join(key_points), analysis_angle]).strip(" ·")


def _was_truncated(stop_reason: str | None) -> bool:
    return str(stop_reason or "").lower() in {"length", "max_tokens", "max_output_tokens"}


def _should_continue_section(
    body: str,
    *,
    stop_reason: str | None,
    target_tokens: int,
    model: str,
    minimum_ratio: float = 0.9,
) -> bool:
    if _was_truncated(stop_reason):
        return True
    if target_tokens <= 0:
        return False
    current_tokens = estimate_tokens(body, model=model)
    return current_tokens < int(target_tokens * minimum_ratio)


def _append_continuation(body: str, continuation: str) -> str:
    if not body:
        return continuation
    if not continuation:
        return body
    if body[-1].isspace() or continuation[0].isspace():
        return f"{body}{continuation}"
    return f"{body} {continuation}"


def _short_summary(section_title: str, body: str) -> str:
    normalized = " ".join(body.split())
    return f"- {section_title}: {normalized[:600]}"


def _short_progress_excerpt(text: str, *, limit: int = 220) -> str:
    normalized = " ".join(str(text or "").split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[:limit - 3]}..."


def _render_stage_preview(
    title: str,
    stage_title: str,
    text: str,
    *,
    output_format: Literal["markdown", "html"] = "markdown",
) -> str:
    body = str(text or "").strip()
    if output_format == "html":
        return (
            "<!doctype html>\n"
            '<html lang="ko">\n'
            "<head>\n"
            '  <meta charset="utf-8">\n'
            '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"  <title>{escape(title)} - {escape(stage_title)}</title>\n"
            "  <style>\n"
            "    body { margin: 0; color: #1f2328; background: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.72; }\n"
            "    main { max-width: 940px; margin: 0 auto; padding: 42px 28px 64px; }\n"
            "    h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.2; }\n"
            "    .stage { color: #667085; font-size: 14px; margin-bottom: 24px; }\n"
            "    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 18px; border: 1px solid #d9dee7; border-radius: 8px; background: #f7f9fc; font: inherit; }\n"
            "  </style>\n"
            "</head>\n"
            "<body>\n"
            "  <main>\n"
            f"    <h1>{escape(title)}</h1>\n"
            f"    <div class=\"stage\">{escape(stage_title)}</div>\n"
            f"    <pre>{escape(body)}</pre>\n"
            "  </main>\n"
            "</body>\n"
            "</html>\n"
        )
    return f"# {title}\n\n## {stage_title}\n\n{body}\n"


def _render_report(
    title: str,
    section_bodies: list[tuple[str, str]],
    review_text: str,
    *,
    output_format: Literal["markdown", "html"] = "markdown",
    target_tokens: int = 0,
    model: str | None = None,
    source_references: list[dict[str, str]] | None = None,
) -> str:
    sources = source_references or []
    if output_format == "html":
        return _render_html_report(
            title,
            section_bodies,
            review_text,
            target_tokens=target_tokens,
            model=model,
            source_references=sources,
        )
    lines = [f"# {title}", ""]
    lines.append("## 목차")
    for section_title, _body in section_bodies:
        lines.append(f"- {section_title}")
    lines.append("")
    for section_title, body in section_bodies:
        lines.extend([f"## {section_title}", "", body, ""])
        if sources:
            lines.extend([_render_markdown_source_hint(sources), ""])
    if review_text.strip():
        lines.extend(["## 검토 요약", "", review_text.strip(), ""])
    if sources:
        lines.extend(["## 출처·근거 후보", "", *_render_markdown_sources(sources), ""])
    return "\n".join(lines).rstrip() + "\n"


def _render_html_report(
    title: str,
    section_bodies: list[tuple[str, str]],
    review_text: str,
    *,
    target_tokens: int,
    model: str | None,
    source_references: list[dict[str, str]] | None = None,
) -> str:
    sources = source_references or []
    del target_tokens
    nav = "\n".join(
        f'<a href="#section-{index}">{escape(section_title)}</a>'
        for index, (section_title, _body) in enumerate(section_bodies, start=1)
    )
    section_html = "\n".join(
        (
            f'<section id="section-{index}">'
            f"<h2>{escape(section_title)}</h2>"
            f"{_render_html_blocks(body)}"
            f"{_render_html_source_hint(sources)}"
            "</section>"
        )
        for index, (section_title, body) in enumerate(section_bodies, start=1)
    )
    review_html = ""
    if review_text.strip():
        review_html = f"<section><h2>검토 요약</h2>{_render_html_blocks(review_text)}</section>"
    visual_overview = _render_html_visual_overview(
        section_bodies,
        model=model,
    )
    executive_lens = _render_html_executive_lens(section_bodies, review_text)
    sources_html = _render_html_sources(sources)
    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>{escape(title)}</title>
  <style>
    :root {{
      color-scheme: light;
      --ink: #1f2328;
      --muted: #667085;
      --line: #d9dee7;
      --panel: #f7f9fc;
      --accent: #3288bd;
      --accent-2: #66c2a5;
      --accent-3: #d53e4f;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(180deg, #f5f7fb 0, #ffffff 290px),
        #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.72;
    }}
    main {{
      max-width: 1180px;
      margin: 0 auto;
      padding: 48px 28px 72px;
    }}
    header {{
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(260px, 0.75fr);
      gap: 24px;
      align-items: end;
      border-bottom: 2px solid var(--ink);
      padding: 8px 0 24px;
      margin-bottom: 24px;
    }}
    .report-eyebrow {{
      margin: 0 0 10px;
      color: var(--accent);
      font-size: 13px;
      font-weight: 750;
      letter-spacing: 0;
      text-transform: uppercase;
    }}
    h1 {{
      margin: 0 0 12px;
      font-size: clamp(30px, 4vw, 48px);
      line-height: 1.16;
      letter-spacing: 0;
    }}
    .report-deck {{
      margin: 0;
      color: #344054;
      font-size: 15px;
      line-height: 1.58;
    }}
    .visual-overview {{
      margin: 28px 0 32px;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
    }}
    .executive-lens {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(240px, 0.72fr);
      gap: 16px;
      margin: 26px 0 30px;
    }}
    .lens-panel {{
      min-width: 0;
      padding: 18px;
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      border-radius: 8px;
      background: #ffffff;
    }}
    .lens-panel.secondary {{
      border-left-color: var(--accent-2);
      background: #f9fbfb;
    }}
    .lens-panel h2 {{
      margin: 0 0 10px;
      font-size: 18px;
    }}
    .lens-panel p,
    .lens-panel li {{
      color: #344054;
      font-size: 14px;
      line-height: 1.55;
    }}
    .data-signal-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
      margin: 0 0 22px;
    }}
    .data-signal {{
      min-width: 0;
      padding: 12px;
      border: 1px solid #dbe5ef;
      border-radius: 8px;
      background: #ffffff;
    }}
    .data-signal strong {{
      display: block;
      color: var(--accent-3);
      font-size: 22px;
      line-height: 1.15;
    }}
    .data-signal span {{
      display: block;
      margin-top: 5px;
      color: #475467;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }}
    .visual-grid {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 1.15fr);
      gap: 18px;
      align-items: start;
    }}
    .story-rail,
    .section-weight-chart,
    .table-derived-visual {{
      min-width: 0;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
    }}
    .visual-title {{
      margin: 0 0 12px;
      font-size: 17px;
      line-height: 1.35;
    }}
    .story-list {{
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }}
    .workflow-map {{
      position: relative;
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }}
    .workflow-step {{
      position: relative;
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      padding-bottom: 10px;
    }}
    .workflow-step:not(:last-child)::after {{
      content: "";
      position: absolute;
      left: 14px;
      top: 30px;
      bottom: -2px;
      width: 2px;
      background: #dbe5ef;
    }}
    .story-item {{
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }}
    .story-index {{
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      color: #ffffff;
      background: var(--accent);
      font-size: 12px;
      font-weight: 750;
    }}
    .story-title {{
      display: block;
      color: var(--ink);
      font-size: 13px;
      font-weight: 700;
      line-height: 1.38;
      overflow-wrap: anywhere;
    }}
    .workflow-caption {{
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }}
    .bar-list {{
      display: grid;
      gap: 10px;
    }}
    .derived-viz-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }}
    .derived-viz-meta {{
      margin: -4px 0 12px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }}
    .bar-row {{
      display: grid;
      grid-template-columns: minmax(120px, 0.85fr) minmax(120px, 1.6fr) 64px;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }}
    .bar-label {{
      color: var(--ink);
      font-size: 13px;
      font-weight: 650;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }}
    .bar-track {{
      height: 12px;
      border-radius: 4px;
      background: #edf1f7;
      overflow: hidden;
    }}
    .bar-fill {{
      height: 100%;
      min-width: 4px;
      border-radius: 4px;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
    }}
    .bar-value {{
      color: var(--muted);
      font-size: 12px;
      text-align: right;
      white-space: nowrap;
    }}
    nav {{
      display: grid;
      gap: 8px;
      margin: 24px 0 40px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }}
    nav a {{
      color: var(--accent);
      text-decoration: none;
      font-weight: 650;
    }}
    section {{
      margin-top: 42px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
    }}
    h2 {{
      margin: 0 0 16px;
      font-size: 25px;
      line-height: 1.28;
      letter-spacing: 0;
    }}
    p {{
      margin: 0 0 15px;
      overflow-wrap: anywhere;
    }}
    h3 {{
      margin: 24px 0 10px;
      font-size: 19px;
      line-height: 1.36;
    }}
    ul,
    ol {{
      margin: 0 0 16px 22px;
      padding: 0;
    }}
    li {{
      margin: 4px 0;
    }}
    table {{
      width: 100%;
      margin: 18px 0 22px;
      border-collapse: collapse;
      font-size: 14px;
      line-height: 1.45;
    }}
    th,
    td {{
      padding: 9px 10px;
      border: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }}
    th {{
      background: var(--panel);
      font-weight: 750;
    }}
    code {{
      padding: 1px 4px;
      border-radius: 4px;
      background: #eef2f7;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
    }}
    .source-hint {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin: 18px 0 0;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
      color: var(--muted);
      font-size: 13px;
    }}
    .source-hint strong {{
      color: var(--ink);
      margin-right: 2px;
    }}
    .source-hint a {{
      color: var(--accent);
      text-decoration: none;
      overflow-wrap: anywhere;
    }}
    .sources-section {{
      margin-top: 38px;
      padding-top: 22px;
      border-top: 2px solid var(--line);
    }}
    .source-note {{
      color: var(--muted);
      font-size: 14px;
    }}
    .source-details {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
    }}
    .source-details a {{
      color: var(--accent);
    }}
    @media (max-width: 760px) {{
      main {{ padding: 32px 18px 56px; }}
      header,
      .executive-lens {{ grid-template-columns: 1fr; }}
      .visual-grid {{ grid-template-columns: 1fr; }}
      .bar-row {{ grid-template-columns: 1fr; gap: 5px; }}
      .bar-value {{ text-align: left; }}
    }}
    @media print {{
      body {{ background: white; }}
      main {{ max-width: none; padding: 24px; }}
      nav {{ break-inside: avoid; }}
      .visual-overview,
      .story-rail,
      .section-weight-chart {{ break-inside: avoid; }}
      section {{ break-inside: auto; }}
    }}
  </style>
</head>
<body class="visual-artifact-report">
  <main>
    <header>
      <div>
        <p class="report-eyebrow">Analytical HTML Report</p>
        <h1>{escape(title)}</h1>
      </div>
      <p class="report-deck">핵심 수치, 표, 섹션 흐름을 먼저 스캔한 뒤 상세 본문으로 내려가도록 구성한 시각 보고서입니다.</p>
    </header>
    {executive_lens}
    {visual_overview}
    <nav aria-label="목차">
      {nav}
    </nav>
    {section_html}
    {review_html}
    {sources_html}
  </main>
</body>
</html>
"""


def _render_html_blocks(text: str) -> str:
    lines = text.strip().splitlines()
    if not lines:
        return ""

    html_parts: list[str] = []
    paragraph_lines: list[str] = []
    index = 0

    def flush_paragraph() -> None:
        if not paragraph_lines:
            return
        rendered = "<br>".join(_render_inline_markdown(line.strip()) for line in paragraph_lines if line.strip())
        if rendered:
            html_parts.append(f"<p>{rendered}</p>")
        paragraph_lines.clear()

    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            index += 1
            continue

        heading = re.match(r"^(#{3,6})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            level = min(len(heading.group(1)), 6)
            html_parts.append(f"<h{level}>{_render_inline_markdown(heading.group(2).strip())}</h{level}>")
            index += 1
            continue

        if _looks_like_table_start(lines, index):
            flush_paragraph()
            table_lines: list[str] = []
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                table_lines.append(lines[index].strip())
                index += 1
            html_parts.append(_render_markdown_table(table_lines))
            continue

        unordered = re.match(r"^[-*]\s+(.+)$", stripped)
        ordered = re.match(r"^\d+[.)]\s+(.+)$", stripped)
        if unordered or ordered:
            flush_paragraph()
            tag = "ul" if unordered else "ol"
            item_pattern = r"^[-*]\s+(.+)$" if unordered else r"^\d+[.)]\s+(.+)$"
            items: list[str] = []
            while index < len(lines):
                item_match = re.match(item_pattern, lines[index].strip())
                if not item_match:
                    break
                items.append(f"<li>{_render_inline_markdown(item_match.group(1).strip())}</li>")
                index += 1
            html_parts.append(f"<{tag}>\n" + "\n".join(items) + f"\n</{tag}>")
            continue

        paragraph_lines.append(stripped)
        index += 1

    flush_paragraph()
    return "\n".join(html_parts)


def _render_markdown_source_hint(sources: list[dict[str, str]]) -> str:
    labels = ", ".join(f"[{source.get('id', 'source')}] {source.get('label', 'source')}" for source in sources)
    return f"> 근거 후보: {labels}"


def _render_markdown_sources(sources: list[dict[str, str]]) -> list[str]:
    lines: list[str] = []
    for source in sources:
        parts = [f"- `{source.get('id', 'source')}` {source.get('label', 'source')}"]
        if source.get("date"):
            parts.append(f"date: {source['date']}")
        if source.get("url"):
            parts.append(f"URL: {source['url']}")
        lines.append(" / ".join(parts))
    return lines


def _render_html_source_hint(sources: list[dict[str, str]]) -> str:
    if not sources:
        return ""
    links = " ".join(
        f'<a href="#source-{escape(source.get("id", "source"))}">{escape(source.get("label", "source"))}</a>'
        for source in sources
    )
    return f'<aside class="source-hint"><strong>근거 후보</strong>{links}</aside>'


def _render_html_sources(sources: list[dict[str, str]]) -> str:
    if not sources:
        return ""
    items = []
    for source in sources:
        source_id = escape(source.get("id", "source"))
        label = escape(source.get("label", "source"))
        details = []
        if source.get("date"):
            details.append(f'<span class="source-meta">{escape(source["date"])}</span>')
        if source.get("url"):
            url = escape(source["url"])
            details.append(f'<a href="{url}" target="_blank" rel="noopener noreferrer">{url}</a>')
        details_html = "".join(details)
        items.append(
            f'<li id="source-{source_id}">'
            f'<strong>{source_id}</strong> {label}'
            f'<div class="source-details">{details_html}</div>'
            "</li>"
        )
    return (
        '<section class="sources-section" id="sources">'
        "<h2>출처·근거 후보</h2>"
        '<p class="source-note">이 목록은 작성 전 수집된 source card와 로컬 자료를 기준으로 한 근거 후보입니다. '
        "공개 전에는 ledger의 claim 후보와 함께 사실관계를 재검증하세요.</p>"
        f"<ol>{''.join(items)}</ol>"
        "</section>"
    )


def _render_html_visual_overview(
    section_bodies: list[tuple[str, str]],
    *,
    model: str | None,
) -> str:
    if not section_bodies:
        return ""
    section_stats = _section_token_stats(section_bodies, model=model)
    story_items = "\n".join(
        (
            '<li class="workflow-step">'
            f'<span class="story-index">{index}</span>'
            f'<span><span class="story-title">{escape(title)}</span>'
            f'<span class="workflow-caption">섹션 {index}에서 확인할 분석 흐름</span></span>'
            "</li>"
        )
        for index, title, _tokens, _share in section_stats[:8]
    )
    bar_rows = "\n".join(
        (
            '<div class="bar-row">'
            f'<div class="bar-label">{index}. {escape(title)}</div>'
            '<div class="bar-track">'
            f'<div class="bar-fill" style="width: {_bar_width(share)}%;"></div>'
            "</div>"
            f'<div class="bar-value">{share:.1f}%</div>'
            "</div>"
        )
        for index, title, _tokens, share in section_stats
    )
    return f"""
    <section class="visual-overview" aria-label="리포트 시각 요약">
      <div class="visual-grid">
        <div class="story-rail">
          <h2 class="visual-title">보고서 workflow</h2>
          <ol class="workflow-map" aria-label="보고서 섹션 workflow">
            {story_items}
          </ol>
        </div>
        <div class="section-weight-chart" aria-label="섹션별 본문 분량 비중">
          <h2 class="visual-title">섹션 분량 비중</h2>
          <div class="bar-list">
            {bar_rows}
          </div>
        </div>
      </div>
      {_render_html_data_signals(section_bodies)}
      {_render_html_table_visuals(section_bodies)}
    </section>
"""


def _render_html_executive_lens(section_bodies: list[tuple[str, str]], review_text: str) -> str:
    if not section_bodies:
        return ""
    first_sections = "".join(
        f"<li>{escape(title)}</li>"
        for title, _body in section_bodies[:4]
    )
    review_excerpt = _short_progress_excerpt(review_text, limit=280) if review_text.strip() else ""
    review_block = (
        f"<p>{escape(review_excerpt)}</p>"
        if review_excerpt
        else "<p>검토 요약은 최종 병합 단계에서 작성되며, 본문 아래에 별도 섹션으로 배치됩니다.</p>"
    )
    return f"""
    <section class="executive-lens" aria-label="보고서 읽기 가이드">
      <div class="lens-panel">
        <h2>읽기 경로</h2>
        <ol>{first_sections}</ol>
      </div>
      <div class="lens-panel secondary">
        <h2>검토 관점</h2>
        {review_block}
      </div>
    </section>
"""


def _render_html_data_signals(section_bodies: list[tuple[str, str]]) -> str:
    signals = _extract_numeric_signals(section_bodies)
    if not signals:
        return ""
    items = "\n".join(
        (
            '<div class="data-signal">'
            f"<strong>{escape(signal['value'])}</strong>"
            f"<span>{escape(signal['context'])}</span>"
            "</div>"
        )
        for signal in signals
    )
    return f"""
      <div class="data-signal-grid" aria-label="본문에서 추출한 주요 수치 신호">
        {items}
      </div>
"""


def _extract_numeric_signals(section_bodies: list[tuple[str, str]], *, max_items: int = 6) -> list[dict[str, str]]:
    pattern = re.compile(
        r"(?<![\w.])(-?\d{1,3}(?:,\d{3})+|-?\d+(?:\.\d+)?)(\s?(?:%|pp|p|명|개|년|월|배|달러|원|조|억))?",
        flags=re.IGNORECASE,
    )
    signals: list[dict[str, str]] = []
    seen: set[str] = set()
    for section_title, body in section_bodies:
        for match in pattern.finditer(body):
            value = f"{match.group(1)}{match.group(2) or ''}".strip()
            if not _is_useful_numeric_signal(value):
                continue
            if value in seen:
                continue
            seen.add(value)
            context = _numeric_signal_context(body, match.start(), match.end())
            if not context:
                context = section_title
            signals.append({"value": value, "context": context})
            if len(signals) >= max_items:
                return signals
    return signals


def _is_useful_numeric_signal(value: str) -> bool:
    if re.search(r"\b(?:tokens?)\b", value, flags=re.IGNORECASE):
        return False
    if re.search(r"[%명개년월배원억조]|pp|p", value):
        return True
    number = _parse_numeric_value(value)
    return number is not None and abs(number) >= 10


def _numeric_signal_context(text: str, start: int, end: int) -> str:
    left = max(text.rfind(".", 0, start), text.rfind("\n", 0, start), text.rfind("다.", 0, start))
    right_candidates = [pos for pos in (text.find(".", end), text.find("\n", end), text.find("다.", end)) if pos != -1]
    right = min(right_candidates) if right_candidates else min(len(text), end + 90)
    excerpt = text[left + 1 : right + 1].strip(" -\n\t")
    return _short_progress_excerpt(excerpt, limit=120)


def _render_html_table_visuals(section_bodies: list[tuple[str, str]]) -> str:
    charts = _extract_table_visuals(section_bodies)
    if not charts:
        return ""
    cards = "\n".join(_render_html_table_visual_card(chart) for chart in charts)
    return f"""
      <div class="derived-viz-grid" aria-label="표에서 자동 생성한 비교 시각화">
        {cards}
      </div>
"""


def _extract_table_visuals(section_bodies: list[tuple[str, str]], *, max_charts: int = 3) -> list[dict[str, object]]:
    charts: list[dict[str, object]] = []
    for section_title, body in section_bodies:
        for table_lines in _extract_markdown_table_lines(body):
            rows = [_split_table_row(line) for line in table_lines]
            if len(rows) < 3 or len(rows[0]) < 2:
                continue
            headers = rows[0]
            body_rows = rows[2:]
            for column_index, header in enumerate(headers[1:], start=1):
                points = []
                for row in body_rows[:10]:
                    if len(row) <= column_index:
                        continue
                    numeric = _parse_numeric_value(row[column_index])
                    if numeric is None:
                        continue
                    points.append(
                        {
                            "label": row[0][:80],
                            "value": numeric,
                            "raw": row[column_index],
                        }
                    )
                if len(points) >= 2:
                    charts.append(
                        {
                            "title": f"{section_title} - {header}",
                            "source": section_title,
                            "points": points[:8],
                        }
                    )
                    break
            if len(charts) >= max_charts:
                return charts
    return charts


def _extract_markdown_table_lines(text: str) -> list[list[str]]:
    lines = text.strip().splitlines()
    tables: list[list[str]] = []
    index = 0
    while index < len(lines):
        if _looks_like_table_start(lines, index):
            table_lines: list[str] = []
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                table_lines.append(lines[index].strip())
                index += 1
            tables.append(table_lines)
            continue
        index += 1
    return tables


def _render_html_table_visual_card(chart: dict[str, object]) -> str:
    points = [point for point in chart.get("points", []) if isinstance(point, dict)]
    max_value = max((abs(float(point.get("value", 0))) for point in points), default=1.0) or 1.0
    rows = "\n".join(
        (
            '<div class="bar-row">'
            f'<div class="bar-label">{escape(str(point.get("label", "")))}</div>'
            '<div class="bar-track">'
            f'<div class="bar-fill" style="width: {max(4.0, abs(float(point.get("value", 0))) / max_value * 100):.1f}%;"></div>'
            "</div>"
            f'<div class="bar-value">{escape(str(point.get("raw", point.get("value", ""))))}</div>'
            "</div>"
        )
        for point in points
    )
    return (
        '<div class="table-derived-visual">'
        f'<h2 class="visual-title">{escape(str(chart.get("title", "표 기반 비교")))}</h2>'
        f'<p class="derived-viz-meta">원문 표의 수치 열을 자동 비교 시각화했습니다.</p>'
        f'<div class="bar-list">{rows}</div>'
        "</div>"
    )


def _parse_numeric_value(value: object) -> float | None:
    text = str(value or "").replace(",", "")
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _section_token_stats(
    section_bodies: list[tuple[str, str]],
    *,
    model: str | None,
) -> list[tuple[int, str, int, float]]:
    token_counts = [max(1, estimate_tokens(body, model=model)) for _title, body in section_bodies]
    total = sum(token_counts) or 1
    return [
        (index, title, tokens, tokens / total * 100)
        for index, ((title, _body), tokens) in enumerate(zip(section_bodies, token_counts), start=1)
    ]


def _bar_width(share: float) -> str:
    return f"{min(100.0, max(4.0, share)):.1f}"


def _looks_like_table_start(lines: list[str], index: int) -> bool:
    if index + 1 >= len(lines):
        return False
    if "|" not in lines[index] or "|" not in lines[index + 1]:
        return False
    separator_cells = _split_table_row(lines[index + 1])
    return bool(separator_cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in separator_cells)


def _render_markdown_table(table_lines: list[str]) -> str:
    if len(table_lines) < 2:
        return ""
    rows = [_split_table_row(line) for line in table_lines]
    headers = rows[0]
    body_rows = rows[2:]
    header_html = "".join(f"<th>{_render_inline_markdown(cell)}</th>" for cell in headers)
    body_html = "\n".join(
        "<tr>" + "".join(f"<td>{_render_inline_markdown(cell)}</td>" for cell in row) + "</tr>"
        for row in body_rows
    )
    return f"<table>\n<thead><tr>{header_html}</tr></thead>\n<tbody>\n{body_html}\n</tbody>\n</table>"


def _split_table_row(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [cell.strip() for cell in value.split("|")]


def _render_inline_markdown(text: str) -> str:
    rendered = escape(text)
    rendered = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", rendered)
    rendered = re.sub(r"`([^`]+)`", r"<code>\1</code>", rendered)
    return rendered

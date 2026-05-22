"""Long report generation tool."""

from __future__ import annotations

import re
import time
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
        "The tool creates an outline, writes sections with lower per-call token caps, reviews the result, "
        "and returns only the output path and short summary."
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
        source_text = _read_source_material(context.cwd, arguments.source_paths)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        preview_writer = _ReportPreviewWriter(
            cwd=context.cwd,
            output_path=output_path,
            title=arguments.title,
            output_format=output_format,
            target_tokens=target_tokens,
            model=model,
        )
        written_token_counter = _CumulativeTokenCounter(model=model)

        outline_prompt = _outline_prompt(arguments, source_text, target_tokens=target_tokens)
        generation_usage = UsageSnapshot()
        outline_text, _, usage = await _request_text(
            api_client,
            model=model,
            system_prompt=system_prompt,
            reasoning_effort=reasoning_effort,
            prompt=outline_prompt,
            max_tokens=token_limits["outline"],
        )
        generation_usage = _add_usage(generation_usage, usage)
        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
        )
        sections = _parse_outline(outline_text, max_sections=arguments.max_sections)
        if not sections:
            sections = ["요약"]
        section_target_tokens = _target_tokens_per_section(
            target_tokens=report_token_budget,
            section_count=len(sections),
            section_cap=token_limits["section"],
            minimum_per_section=2_500 if allow_section_overrun else 500,
        )
        requested_section_target_tokens = section_target_tokens if target_tokens else 0
        await preview_writer.write([], force=True)

        section_bodies: list[tuple[str, str]] = []
        section_summaries: list[str] = []
        for index, section_title in enumerate(sections, start=1):
            section_parts: list[str] = []

            async def _on_section_delta(delta: str, *, _section_title: str = section_title) -> None:
                section_parts.append(delta)
                written_token_counter.add(delta)
                preview_writer.write_progress_state(
                    generation_usage,
                    document_written_tokens=written_token_counter.total_tokens,
                )
                await preview_writer.write([*section_bodies, (_section_title, "".join(section_parts))])

            prompt = _section_prompt(
                title=arguments.title,
                brief=arguments.brief,
                section_title=section_title,
                source_text=source_text,
                prior_summaries=section_summaries,
                index=index,
                total=len(sections),
                target_tokens=requested_section_target_tokens,
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
            await preview_writer.write([*section_bodies, (section_title, body)], force=True)
            continuations = 0
            max_continuations = _max_continuations_for_target(section_target_tokens)
            while _should_continue_section(
                body,
                stop_reason=stop_reason,
                target_tokens=requested_section_target_tokens,
                model=model,
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
                    preview_writer.write_progress_state(
                        generation_usage,
                        document_written_tokens=written_token_counter.total_tokens,
                    )
                    current = _append_continuation(body, "".join(continuation_parts))
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
                )
                continuation = "".join(continuation_parts) or continuation
                if not continuation.strip():
                    break
                body = _append_continuation(body, continuation)
                await preview_writer.write([*section_bodies, (section_title, body)], force=True)
                continuations += 1
            section_bodies.append((section_title, body.strip()))
            section_summaries.append(_short_summary(section_title, body))

        review_text, _, usage = await _request_text(
            api_client,
            model=model,
            system_prompt=system_prompt,
            reasoning_effort=reasoning_effort,
            prompt=_review_prompt(arguments.title, section_summaries),
            max_tokens=token_limits["review"],
        )
        generation_usage = _add_usage(generation_usage, usage)
        if review_text:
            written_token_counter.add(review_text)
        preview_writer.write_progress_state(
            generation_usage,
            document_written_tokens=written_token_counter.total_tokens,
        )

        report_text = _render_report(
            arguments.title,
            section_bodies,
            review_text,
            output_format=output_format,
            target_tokens=target_tokens,
            model=model,
        )
        output_path.write_text(
            report_text,
            encoding="utf-8",
        )
        display_path = display_tool_path(output_path, context.cwd)
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
        output = f"장문 보고서를 생성했습니다: {display_path} (섹션 {len(section_bodies)}개{token_note})"
        return ToolResult(
            output=output,
            metadata={
                "model_output": output,
                "display_output": output,
                "transcript_output": output,
                "path": str(output_path),
                "estimated_tokens": estimated_tokens,
                "target_tokens": target_tokens,
                "document_written_tokens": written_tokens,
                "usage_input_tokens": generation_usage.input_tokens,
                "usage_output_tokens": generation_usage.output_tokens,
                "usage_total_tokens": generation_usage.total_tokens,
                "section_count": len(section_bodies),
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
    ) -> None:
        self.cwd = cwd
        self.output_path = output_path
        self.title = title
        self.output_format = output_format
        self.target_tokens = target_tokens
        self.model = model
        self._last_write_at = 0.0

    def write_progress_state(self, usage: UsageSnapshot, *, document_written_tokens: int = 0) -> None:
        write_long_report_progress_state(
            self.cwd,
            self.output_path,
            usage=usage,
            document_written_tokens=document_written_tokens,
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
    per_section = max(minimum_per_section, target_tokens // section_count)
    return min(per_section, int(section_cap * 0.85))


def _section_request_max_tokens(section_target_tokens: int, section_cap: int) -> int:
    if section_target_tokens <= 0:
        return section_cap
    return min(section_cap, max(1_000, int(section_target_tokens * 1.05)))


def _section_collected_token_budget(section_target_tokens: int, *, allow_overrun: bool = True) -> int | None:
    if section_target_tokens <= 0:
        return None
    multiplier = 1.1 if allow_overrun else 1.0
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
    if section_target_tokens >= 10_000:
        return 4
    if section_target_tokens >= 6_000:
        return 3
    return 2


def _slugify_title(title: str) -> str:
    cleaned = re.sub(r"\s+", "_", title.strip())
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", cleaned)
    return cleaned.strip("._") or "long_report"


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


def _outline_prompt(arguments: LongReportToolInput, source_text: str, *, target_tokens: int) -> str:
    source_block = f"\n\n참고 자료:\n{source_text}" if source_text else ""
    target_line = f"목표 분량: 약 {target_tokens:,} tokens\n" if target_tokens else ""
    return (
        f"'{arguments.title}' 보고서의 목차를 작성하세요.\n"
        f"요구사항: {arguments.brief}\n"
        f"{target_line}"
        f"섹션 제목만 한 줄에 하나씩, 최대 {arguments.max_sections}개로 쓰세요."
        f"{source_block}"
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
) -> str:
    prior = "\n".join(prior_summaries[-5:])
    length_instruction = ""
    if target_tokens > 0:
        length_instruction = (
            f"이 섹션의 목표 분량은 약 {target_tokens:,} tokens입니다. "
            "요약 초안으로 끝내지 말고, 하위 소제목·근거·사례·반론·영향 분석을 충분히 펼쳐 쓰세요. "
            "최소 목표에 못 미칠 것 같으면 스스로 내용을 더 확장하세요.\n"
        )
    return (
        f"보고서 제목: {title}\n"
        f"전체 요구사항: {brief}\n"
        f"현재 섹션: {index}/{total} {section_title}\n"
        f"이전 섹션 요약:\n{prior or '(없음)'}\n\n"
        f"{length_instruction}"
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
        "아래 마지막 문맥을 이어서 현재 섹션 본문만 계속 작성하세요. "
        "이미 쓴 내용을 요약하거나 반복하지 말고, 누락된 분석·사례·함의·비교를 추가하세요.\n\n"
        f"마지막 문맥:\n{current_body[-4_000:]}"
    )


def _review_prompt(title: str, section_summaries: list[str]) -> str:
    return (
        f"'{title}' 보고서 초안의 검토 요약을 5개 bullet 이내로 작성하세요.\n"
        "중복, 누락, 후속 보완점을 중심으로 짧게 쓰세요.\n\n"
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
    sections: list[str] = []
    for line in outline_text.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", line).strip()
        cleaned = cleaned.strip("#").strip()
        if cleaned and cleaned not in sections:
            sections.append(cleaned)
        if len(sections) >= max_sections:
            break
    return sections


def _was_truncated(stop_reason: str | None) -> bool:
    return str(stop_reason or "").lower() in {"length", "max_tokens", "max_output_tokens"}


def _should_continue_section(
    body: str,
    *,
    stop_reason: str | None,
    target_tokens: int,
    model: str,
) -> bool:
    if _was_truncated(stop_reason):
        return True
    if target_tokens <= 0:
        return False
    current_tokens = estimate_tokens(body, model=model)
    return current_tokens < int(target_tokens * 0.9)


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


def _render_report(
    title: str,
    section_bodies: list[tuple[str, str]],
    review_text: str,
    *,
    output_format: Literal["markdown", "html"] = "markdown",
    target_tokens: int = 0,
    model: str | None = None,
) -> str:
    if output_format == "html":
        return _render_html_report(title, section_bodies, review_text, target_tokens=target_tokens, model=model)
    lines = [f"# {title}", ""]
    lines.append("## 목차")
    for section_title, _body in section_bodies:
        lines.append(f"- {section_title}")
    lines.append("")
    for section_title, body in section_bodies:
        lines.extend([f"## {section_title}", "", body, ""])
    if review_text.strip():
        lines.extend(["## 검토 요약", "", review_text.strip(), ""])
    return "\n".join(lines).rstrip() + "\n"


def _render_html_report(
    title: str,
    section_bodies: list[tuple[str, str]],
    review_text: str,
    *,
    target_tokens: int,
    model: str | None,
) -> str:
    estimated_body_tokens = estimate_tokens("\n\n".join(body for _title, body in section_bodies), model=model)
    target_note = f"목표 {target_tokens:,} tokens" if target_tokens else "목표 분량 미지정"
    nav = "\n".join(
        f'<a href="#section-{index}">{escape(section_title)}</a>'
        for index, (section_title, _body) in enumerate(section_bodies, start=1)
    )
    section_html = "\n".join(
        (
            f'<section id="section-{index}">'
            f"<h2>{escape(section_title)}</h2>"
            f"{_render_html_blocks(body)}"
            "</section>"
        )
        for index, (section_title, body) in enumerate(section_bodies, start=1)
    )
    review_html = ""
    if review_text.strip():
        review_html = f"<section><h2>검토 요약</h2>{_render_html_blocks(review_text)}</section>"
    visual_overview = _render_html_visual_overview(
        section_bodies,
        estimated_body_tokens=estimated_body_tokens,
        target_note=target_note,
        model=model,
    )
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
      background: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.72;
    }}
    main {{
      max-width: 1180px;
      margin: 0 auto;
      padding: 48px 28px 72px;
    }}
    header {{
      border-bottom: 2px solid var(--ink);
      padding-bottom: 22px;
      margin-bottom: 24px;
    }}
    h1 {{
      margin: 0 0 12px;
      font-size: clamp(30px, 4vw, 48px);
      line-height: 1.16;
      letter-spacing: 0;
    }}
    .meta {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
    }}
    .pill {{
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 8px;
      background: var(--panel);
    }}
    .visual-overview {{
      margin: 28px 0 32px;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
    }}
    .metric-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 22px;
    }}
    .metric-card {{
      min-width: 0;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
    }}
    .metric-value {{
      display: block;
      color: var(--ink);
      font-size: 23px;
      font-weight: 750;
      line-height: 1.2;
    }}
    .metric-label {{
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }}
    .visual-grid {{
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 1.15fr);
      gap: 18px;
      align-items: start;
    }}
    .story-rail,
    .section-weight-chart {{
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
    .story-item {{
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }}
    .story-index {{
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
    .bar-list {{
      display: grid;
      gap: 10px;
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
    @media (max-width: 760px) {{
      main {{ padding: 32px 18px 56px; }}
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
<body>
  <main>
    <header>
      <h1>{escape(title)}</h1>
      <div class="meta">
        <span class="pill">섹션 {len(section_bodies):,}개</span>
        <span class="pill">본문 약 {estimated_body_tokens:,} tokens</span>
        <span class="pill">{escape(target_note)}</span>
      </div>
    </header>
    {visual_overview}
    <nav aria-label="목차">
      {nav}
    </nav>
    {section_html}
    {review_html}
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


def _render_html_visual_overview(
    section_bodies: list[tuple[str, str]],
    *,
    estimated_body_tokens: int,
    target_note: str,
    model: str | None,
) -> str:
    if not section_bodies:
        return ""
    section_stats = _section_token_stats(section_bodies, model=model)
    story_items = "\n".join(
        (
            '<li class="story-item">'
            f'<span class="story-index">{index}</span>'
            f'<span class="story-title">{escape(title)}</span>'
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
      <div class="metric-grid">
        <div class="metric-card">
          <span class="metric-value">{len(section_bodies):,}</span>
          <span class="metric-label">총 섹션</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{estimated_body_tokens:,}</span>
          <span class="metric-label">본문 추정 토큰</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{escape(target_note)}</span>
          <span class="metric-label">생성 목표</span>
        </div>
      </div>
      <div class="visual-grid">
        <div class="story-rail">
          <h2 class="visual-title">서사 흐름</h2>
          <ol class="story-list">
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
    </section>
"""


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

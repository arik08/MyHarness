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
from myharness.config.settings import report_token_limits_for_model
from myharness.engine.messages import ConversationMessage
from myharness.services.token_estimation import estimate_tokens
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.path_display import display_tool_path


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
        le=200_000,
        description="Approximate desired report body length. Use for 20k+ or user-specified token targets.",
    )
    source_paths: list[str] = Field(default_factory=list, description="Optional local text files to use as source material")
    max_sections: int = Field(default=8, ge=1, le=30, description="Maximum outline sections to generate")


class LongReportTool(BaseTool):
    """Generate a long report through smaller section-level model calls."""

    name = "write_long_report"
    description = (
        "Generate a long Markdown or HTML report as a file instead of streaming the full report into chat. "
        "Use this when the requested report is above the configured single-response cap, especially for 40,000+ tokens, "
        "초장문, 대보고서, 2-3x expansion, or explicit targets such as 80,000 tokens. "
        "Set target_tokens when the user gives or implies a desired length. "
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
        source_text = _read_source_material(context.cwd, arguments.source_paths)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        preview_writer = _ReportPreviewWriter(
            output_path=output_path,
            title=arguments.title,
            output_format=output_format,
            target_tokens=target_tokens,
            model=model,
        )

        outline_prompt = _outline_prompt(arguments, source_text, target_tokens=target_tokens)
        outline_text, _ = await _request_text(
            api_client,
            model=model,
            system_prompt=system_prompt,
            reasoning_effort=reasoning_effort,
            prompt=outline_prompt,
            max_tokens=token_limits["outline"],
        )
        sections = _parse_outline(outline_text, max_sections=arguments.max_sections)
        if not sections:
            sections = ["요약"]
        section_target_tokens = _target_tokens_per_section(
            target_tokens=target_tokens,
            section_count=len(sections),
            section_cap=token_limits["section"],
        )
        await preview_writer.write([], force=True)

        section_bodies: list[tuple[str, str]] = []
        section_summaries: list[str] = []
        for index, section_title in enumerate(sections, start=1):
            section_parts: list[str] = []

            async def _on_section_delta(delta: str, *, _section_title: str = section_title) -> None:
                section_parts.append(delta)
                await preview_writer.write([*section_bodies, (_section_title, "".join(section_parts))])

            prompt = _section_prompt(
                title=arguments.title,
                brief=arguments.brief,
                section_title=section_title,
                source_text=source_text,
                prior_summaries=section_summaries,
                index=index,
                total=len(sections),
                target_tokens=section_target_tokens,
            )
            body, stop_reason = await _request_text(
                api_client,
                model=model,
                system_prompt=system_prompt,
                reasoning_effort=reasoning_effort,
                prompt=prompt,
                max_tokens=_section_request_max_tokens(section_target_tokens, token_limits["section"]),
                max_collected_tokens=_section_collected_token_budget(section_target_tokens),
                on_delta=_on_section_delta,
            )
            body = ("".join(section_parts) or body).strip()
            await preview_writer.write([*section_bodies, (section_title, body)], force=True)
            continuations = 0
            max_continuations = _max_continuations_for_target(section_target_tokens)
            while _should_continue_section(
                body,
                stop_reason=stop_reason,
                target_tokens=section_target_tokens,
                model=model,
            ) and continuations < max_continuations:
                remaining_budget = _remaining_section_token_budget(body, section_target_tokens, model=model)
                if remaining_budget is not None and remaining_budget <= 0:
                    break
                continuation_parts: list[str] = []

                async def _on_continuation_delta(delta: str, *, _section_title: str = section_title) -> None:
                    continuation_parts.append(delta)
                    current = _append_continuation(body, "".join(continuation_parts))
                    await preview_writer.write([*section_bodies, (_section_title, current)])

                continuation, stop_reason = await _request_text(
                    api_client,
                    model=model,
                    system_prompt=system_prompt,
                    reasoning_effort=reasoning_effort,
                    prompt=_continuation_prompt(
                        arguments.title,
                        section_title,
                        body,
                        target_tokens=section_target_tokens,
                        model=model,
                    ),
                    max_tokens=_section_request_max_tokens(section_target_tokens, token_limits["section"]),
                    max_collected_tokens=remaining_budget,
                    on_delta=_on_continuation_delta,
                )
                continuation = "".join(continuation_parts) or continuation
                if not continuation.strip():
                    break
                body = _append_continuation(body, continuation)
                await preview_writer.write([*section_bodies, (section_title, body)], force=True)
                continuations += 1
            section_bodies.append((section_title, body.strip()))
            section_summaries.append(_short_summary(section_title, body))

        review_text, _ = await _request_text(
            api_client,
            model=model,
            system_prompt=system_prompt,
            reasoning_effort=reasoning_effort,
            prompt=_review_prompt(arguments.title, section_summaries),
            max_tokens=token_limits["review"],
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
        token_note = f", 약 {estimated_tokens:,} tokens"
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
                "section_count": len(section_bodies),
            },
        )


class _ReportPreviewWriter:
    def __init__(
        self,
        *,
        output_path: Path,
        title: str,
        output_format: Literal["markdown", "html"],
        target_tokens: int,
        model: str | None,
    ) -> None:
        self.output_path = output_path
        self.title = title
        self.output_format = output_format
        self.target_tokens = target_tokens
        self.model = model
        self._last_write_at = 0.0

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


def _is_streaming_client(value: Any) -> bool:
    return hasattr(value, "stream_message")


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
        return arguments.target_tokens
    text = f"{arguments.title}\n{arguments.brief}"
    man_match = re.search(r"(\d{1,3})\s*만\s*(?:tokens?|토큰)?", text, flags=re.IGNORECASE)
    if man_match:
        return int(man_match.group(1)) * 10_000
    token_match = re.search(
        r"(\d{1,3}(?:,\d{3})+|\d{4,6})\s*(?:tokens?|토큰)",
        text,
        flags=re.IGNORECASE,
    )
    if token_match:
        return int(token_match.group(1).replace(",", ""))
    return 0


def _target_tokens_per_section(*, target_tokens: int, section_count: int, section_cap: int) -> int:
    if target_tokens <= 0 or section_count <= 0:
        return 0
    per_section = max(2_500, target_tokens // section_count)
    return min(per_section, int(section_cap * 0.85))


def _section_request_max_tokens(section_target_tokens: int, section_cap: int) -> int:
    if section_target_tokens <= 0:
        return section_cap
    return min(section_cap, max(1_000, int(section_target_tokens * 1.05)))


def _section_collected_token_budget(section_target_tokens: int) -> int | None:
    if section_target_tokens <= 0:
        return None
    return max(1_000, int(section_target_tokens * 1.1))


def _remaining_section_token_budget(body: str, section_target_tokens: int, *, model: str) -> int | None:
    section_budget = _section_collected_token_budget(section_target_tokens)
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
    return "\n\n".join(chunks)[:80_000]


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
) -> tuple[str, str | None]:
    collected = ""
    final_text = ""
    stop_reason: str | None = None
    local_budget = None if max_collected_tokens is None else max(0, int(max_collected_tokens))
    if local_budget == 0:
        return "", "local_token_budget"
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
            stop_reason = event.stop_reason
    text = collected or final_text
    if local_budget is not None:
        text = _trim_text_to_token_budget(text, local_budget, model=model)
    return text.strip(), stop_reason


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
    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(title)}</title>
  <style>
    :root {{
      color-scheme: light;
      --ink: #1f2328;
      --muted: #667085;
      --line: #d9dee7;
      --panel: #f7f9fc;
      --accent: #3288bd;
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
      max-width: 1040px;
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
    @media print {{
      body {{ background: white; }}
      main {{ max-width: none; padding: 24px; }}
      nav {{ break-inside: avoid; }}
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
    paragraphs = [paragraph.strip() for paragraph in re.split(r"\n{2,}", text.strip()) if paragraph.strip()]
    if not paragraphs:
        return ""
    return "\n".join(f"<p>{escape(paragraph).replace(chr(10), '<br>')}</p>" for paragraph in paragraphs)

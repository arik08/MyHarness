"""Tools for searching and reading oversized session documents."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from myharness.services.session_documents import resolve_session_document_index_path, resolve_session_document_path
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class SessionDocumentSearchToolInput(BaseModel):
    document_id: str = Field(description="Session document ID, for example doc-1234abcd5678")
    query: str = Field(description="Search terms to locate relevant source ranges")
    limit: int = Field(default=8, ge=1, le=20, description="Maximum matching ranges to return")


class SessionDocumentReadToolInput(BaseModel):
    document_id: str = Field(description="Session document ID, for example doc-1234abcd5678")
    start_line: int = Field(default=1, ge=1, description="One-based starting line")
    limit: int = Field(default=200, ge=1, le=2000, description="Number of lines to return")
    start_column: int = Field(default=1, ge=1, description="One-based character column on the starting line; use the search match column for very long lines")
    max_chars: int = Field(default=8000, ge=256, le=12000, description="Maximum returned source characters; continue with the returned line/column cursor")


def _shared_metadata(context: ToolExecutionContext) -> dict[str, Any]:
    metadata = context.metadata.get("_shared_tool_metadata")
    if isinstance(metadata, dict):
        return metadata
    return context.metadata


def _document_path(context: ToolExecutionContext, document_id: str) -> Path | None:
    return resolve_session_document_path(context.cwd, _shared_metadata(context), document_id)


def _document_index_path(context: ToolExecutionContext, document_id: str) -> Path | None:
    return resolve_session_document_index_path(context.cwd, _shared_metadata(context), document_id)


def _tokens(text: str) -> list[str]:
    return [token for token in re.split(r"\s+", text.lower().strip()) if token]


def _score(text: str, query: str) -> int:
    haystack = text.lower()
    needle = query.lower().strip()
    if not needle:
        return 0
    score = 100 if needle in haystack else 0
    for token in _tokens(needle):
        if token in haystack:
            score += 10
    return score


def _trim_snippet(text: str, limit: int = 220) -> str:
    clean = " ".join(text.split())
    if len(clean) <= limit:
        return clean
    return clean[: limit - 3].rstrip() + "..."


def _snippet_for_chunk(lines: list[str], query: str) -> str:
    if not lines:
        return ""
    offset, column = _best_match(lines, query)
    return _trim_snippet(lines[offset][max(0, column - 60):])


def _best_match(lines: list[str], query: str) -> tuple[int, int]:
    offset = max(range(len(lines)), key=lambda index: _score(lines[index], query))
    # Match offsets in the original string: lower() may expand Unicode
    # characters, making a search column point past the actual source text.
    for needle in [query.strip(), *query.split()]:
        match = re.search(re.escape(needle), lines[offset], re.IGNORECASE) if needle else None
        if match:
            return offset, match.start()
    return offset, 0


def _match_cursor(lines: list[str], query: str, start_line: int) -> str:
    if not lines:
        return ""
    offset, column = _best_match(lines, query)
    return f" match start_line={start_line + offset} start_column={column + 1}"


def _load_indexed_chunks(index_path: Path, document_id: str, line_count: int) -> list[dict[str, Any]]:
    try:
        data = json.loads(index_path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, dict) or str(data.get("document_id") or "") != document_id:
        return []
    raw_chunks = data.get("chunks")
    if not isinstance(raw_chunks, list):
        return []
    chunks: list[dict[str, Any]] = []
    for raw_chunk in raw_chunks:
        if not isinstance(raw_chunk, dict):
            continue
        try:
            start_line = int(raw_chunk.get("start_line"))
            end_line = int(raw_chunk.get("end_line"))
            chunk_index = int(raw_chunk.get("chunk_index"))
        except (TypeError, ValueError):
            continue
        if start_line < 1 or end_line < start_line or start_line > line_count:
            continue
        chunks.append(
            {
                "chunk_index": chunk_index,
                "start_line": start_line,
                "end_line": min(end_line, line_count),
                "heading": str(raw_chunk.get("heading") or "").strip(),
            }
        )
    return chunks


class SessionDocumentSearchTool(BaseTool):
    """Search a session-scoped recoverable source document."""

    name = "session_document_search"
    description = (
        "Search a session-scoped recoverable source document stored for this chat session, "
        "including oversized user inputs and large tool outputs. Use this before making "
        "source-backed judgments about stored context."
    )
    input_model = SessionDocumentSearchToolInput

    def is_read_only(self, arguments: SessionDocumentSearchToolInput) -> bool:
        del arguments
        return True

    async def execute(self, arguments: SessionDocumentSearchToolInput, context: ToolExecutionContext) -> ToolResult:
        path = _document_path(context, arguments.document_id)
        if path is None:
            return ToolResult(output=f"No session document found for id: {arguments.document_id}", is_error=True)
        index_path = _document_index_path(context, arguments.document_id)
        return await asyncio.to_thread(
            _search_document,
            path,
            index_path,
            arguments.document_id,
            arguments.query,
            arguments.limit,
        )


class SessionDocumentReadTool(BaseTool):
    """Read line ranges from a session-scoped recoverable source document."""

    name = "session_document_read"
    description = (
        "Read original line ranges from a session-scoped recoverable source document stored for this chat session, "
        "including oversized user inputs and large tool outputs. Use this after session_document_search "
        "to verify the exact source text."
    )
    input_model = SessionDocumentReadToolInput

    def is_read_only(self, arguments: SessionDocumentReadToolInput) -> bool:
        del arguments
        return True

    async def execute(self, arguments: SessionDocumentReadToolInput, context: ToolExecutionContext) -> ToolResult:
        path = _document_path(context, arguments.document_id)
        if path is None:
            return ToolResult(output=f"No session document found for id: {arguments.document_id}", is_error=True)
        lines = await asyncio.to_thread(_read_document_lines, path)
        start_index = arguments.start_line - 1
        if start_index >= len(lines):
            return ToolResult(output=f"(선택한 범위에 내용이 없습니다: {arguments.document_id})")
        column = arguments.start_column - 1
        if column > len(lines[start_index]):
            return ToolResult(output="Starting column is beyond the selected line.", is_error=True)
        numbered: list[str] = []
        remaining = arguments.max_chars
        end_index = min(len(lines), start_index + arguments.limit)
        cursor_line, cursor_column = end_index + 1, 1
        for index in range(start_index, end_index):
            prefix = f"{index + 1:>6}\t"
            available = max(0, remaining - len(prefix) - 1)
            text = lines[index][column:]
            part = text[:available]
            numbered.append(prefix + part)
            remaining -= len(prefix) + len(part) + 1
            if len(part) < len(text):
                cursor_line, cursor_column = index + 1, column + len(part) + 1
                break
            column = 0
            if remaining < 16 and index + 1 < end_index:
                cursor_line, cursor_column = index + 2, 1
                break
        if cursor_line <= len(lines):
            numbered.append(
                f"[More source available. Continue session_document_read with document_id={arguments.document_id}, "
                f"start_line={cursor_line}, start_column={cursor_column}.]"
            )
        return ToolResult(output="\n".join(numbered))


def _read_document_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def _search_document(
    path: Path,
    index_path: Path | None,
    document_id: str,
    query: str,
    limit: int,
) -> ToolResult:
    lines = _read_document_lines(path)
    indexed_chunks = _load_indexed_chunks(index_path, document_id, len(lines)) if index_path else []
    if indexed_chunks:
        matches: list[tuple[int, int, int, int, str, str]] = []
        for chunk in indexed_chunks:
            start = int(chunk["start_line"])
            end = int(chunk["end_line"])
            heading = str(chunk.get("heading") or "")
            chunk_lines = lines[start - 1 : end]
            chunk_text = "\n".join(chunk_lines)
            score = _score(f"{heading}\n{chunk_text}", query)
            if score <= 0:
                continue
            snippet = _snippet_for_chunk(chunk_lines, query)
            matches.append((score, start, end, int(chunk["chunk_index"]), heading, snippet))
        if not matches:
            return ToolResult(output="(no matches)")
        matches.sort(key=lambda item: (-item[0], item[1], item[3]))
        output_lines = []
        for score, start, end, chunk_index, heading, snippet in matches[:limit]:
            heading_part = f' heading "{heading}"' if heading else ""
            cursor = _match_cursor(lines[start - 1:end], query, start)
            output_lines.append(
                f"- {document_id} chunk {chunk_index} lines {start}-{end}{heading_part}{cursor} score {score}: {snippet}"
            )
        return ToolResult(output="\n".join(output_lines))

    window_size = 80
    overlap = 20
    step = max(1, window_size - overlap)
    matches_fallback: list[tuple[int, int, int, str]] = []
    for start in range(0, len(lines), step):
        end = min(len(lines), start + window_size)
        chunk = "\n".join(lines[start:end])
        score = _score(chunk, query)
        if score <= 0:
            continue
        snippet = _snippet_for_chunk(lines[start:end], query)
        matches_fallback.append((score, start + 1, end, snippet))
    if not matches_fallback:
        return ToolResult(output="(no matches)")
    matches_fallback.sort(key=lambda item: (-item[0], item[1]))
    output_lines = [
        f"- {document_id} lines {start}-{end}{_match_cursor(lines[start - 1:end], query, start)} score {score}: {snippet}"
        for score, start, end, snippet in matches_fallback[:limit]
    ]
    return ToolResult(output="\n".join(output_lines))


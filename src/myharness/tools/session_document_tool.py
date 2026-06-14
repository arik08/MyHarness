"""Tools for searching and reading oversized session documents."""

from __future__ import annotations

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
    needle = query.lower().strip()
    tokens = _tokens(needle)
    for line in lines:
        if needle and needle in line.lower():
            return _trim_snippet(line)
    for line in lines:
        lower = line.lower()
        if any(token in lower for token in tokens):
            return _trim_snippet(line)
    for line in lines:
        if line.strip():
            return _trim_snippet(line)
    return ""


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
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        index_path = _document_index_path(context, arguments.document_id)
        indexed_chunks = _load_indexed_chunks(index_path, arguments.document_id, len(lines)) if index_path else []
        if indexed_chunks:
            matches: list[tuple[int, int, int, int, str, str]] = []
            for chunk in indexed_chunks:
                start = int(chunk["start_line"])
                end = int(chunk["end_line"])
                heading = str(chunk.get("heading") or "")
                chunk_lines = lines[start - 1 : end]
                chunk_text = "\n".join(chunk_lines)
                score = _score(f"{heading}\n{chunk_text}", arguments.query)
                if score <= 0:
                    continue
                snippet = _snippet_for_chunk(chunk_lines, arguments.query)
                matches.append((score, start, end, int(chunk["chunk_index"]), heading, snippet))
            if not matches:
                return ToolResult(output="(no matches)")
            matches.sort(key=lambda item: (-item[0], item[1], item[3]))
            output_lines = []
            for score, start, end, chunk_index, heading, snippet in matches[: arguments.limit]:
                heading_part = f' heading "{heading}"' if heading else ""
                output_lines.append(
                    f"- {arguments.document_id} chunk {chunk_index} lines {start}-{end}{heading_part} score {score}: {snippet}"
                )
            return ToolResult(output="\n".join(output_lines))

        window_size = 80
        overlap = 20
        step = max(1, window_size - overlap)
        matches: list[tuple[int, int, int, str]] = []
        for start in range(0, len(lines), step):
            end = min(len(lines), start + window_size)
            chunk = "\n".join(lines[start:end])
            score = _score(chunk, arguments.query)
            if score <= 0:
                continue
            snippet = _trim_snippet(chunk)
            matches.append((score, start + 1, end, snippet))
        if not matches:
            return ToolResult(output="(no matches)")
        matches.sort(key=lambda item: (-item[0], item[1]))
        output_lines = [
            f"- {arguments.document_id} lines {start}-{end} score {score}: {snippet}"
            for score, start, end, snippet in matches[: arguments.limit]
        ]
        return ToolResult(output="\n".join(output_lines))


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
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        start_index = arguments.start_line - 1
        if start_index >= len(lines):
            return ToolResult(output=f"(선택한 범위에 내용이 없습니다: {arguments.document_id})")
        selected = lines[start_index : start_index + arguments.limit]
        numbered = [
            f"{start_index + index + 1:>6}\t{line}"
            for index, line in enumerate(selected)
        ]
        return ToolResult(output="\n".join(numbered))


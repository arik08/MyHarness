"""Session-scoped storage for oversized pasted user documents."""

from __future__ import annotations

import hashlib
<<<<<<< HEAD
import json
=======
>>>>>>> codex/session-documents
import re
import time
from pathlib import Path
from typing import Any

from myharness.config.paths import get_project_config_dir
from myharness.engine.messages import ConversationMessage
from myharness.services.token_estimation import estimate_tokens
from myharness.utils.fs import atomic_write_text

SESSION_ID_RE = re.compile(r"^[0-9a-f]{12}$")
DOCUMENT_ID_RE = re.compile(r"^doc-[0-9a-f]{12}$")
SESSION_DOCUMENT_TOKEN_FLOOR = 80_000
SESSION_DOCUMENT_PREVIEW_CHARS = 1_200
<<<<<<< HEAD
SESSION_DOCUMENT_INDEX_VERSION = 1
SESSION_DOCUMENT_CHUNK_TARGET_LINES = 160
SESSION_DOCUMENT_CHUNK_OVERLAP_LINES = 20

MARKDOWN_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")
HTML_HEADING_RE = re.compile(r"<h[1-6][^>]*>(.*?)</h[1-6]>", re.IGNORECASE)
SECTION_HEADING_RE = re.compile(
    r"^\s*(?:(?:section|chapter)\s+)?(?:[A-Z]|[IVXLC]+|\d{1,3}(?:\.\d{1,3})*)[.)]\s+(.+)$",
    re.IGNORECASE,
)
=======
>>>>>>> codex/session-documents


def get_session_document_root(cwd: str | Path) -> Path:
    root = get_project_config_dir(cwd) / "sessions" / "session-documents"
    root.mkdir(parents=True, exist_ok=True)
    return root


def get_session_document_dir(cwd: str | Path, session_id: str) -> Path:
    if not SESSION_ID_RE.fullmatch(session_id):
        raise ValueError(f"Invalid session id for session document storage: {session_id}")
    path = get_session_document_root(cwd) / session_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def session_document_dir_for_delete(cwd: str | Path, session_id: str) -> Path | None:
    if not SESSION_ID_RE.fullmatch(session_id):
        return None
    root = get_session_document_root(cwd).resolve()
    candidate = (root / session_id).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _document_id(text: str) -> str:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]
    return f"doc-{digest}"


<<<<<<< HEAD
def _document_index_path(document_path: Path) -> Path:
    return document_path.with_suffix(".index.json")


=======
>>>>>>> codex/session-documents
def _short_hint(text: str) -> str:
    clean = " ".join(text.split())
    if len(clean) <= 180:
        return clean
    return clean[:177].rstrip() + "..."


def _sample(text: str) -> str:
    clean = text.strip()
    if len(clean) <= SESSION_DOCUMENT_PREVIEW_CHARS:
        return clean
    head = clean[:400].rstrip()
    midpoint = max(0, len(clean) // 2 - 200)
    middle = clean[midpoint : midpoint + 400].strip()
    tail = clean[-400:].lstrip()
    return "\n...\n".join(part for part in (head, middle, tail) if part)


def _metadata_documents(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    existing = metadata.get("session_documents")
    return [dict(item) for item in existing if isinstance(item, dict)] if isinstance(existing, list) else []


<<<<<<< HEAD
def _heading_from_line(line: str) -> str:
    clean = line.strip()
    if not clean or len(clean) > 180:
        return ""
    markdown_match = MARKDOWN_HEADING_RE.match(clean)
    if markdown_match:
        return markdown_match.group(1).strip()
    html_match = HTML_HEADING_RE.search(clean)
    if html_match:
        return re.sub(r"<[^>]+>", "", html_match.group(1)).strip()
    section_match = SECTION_HEADING_RE.match(clean)
    if section_match:
        return section_match.group(1).strip()
    return ""


def _chunk_preview(lines: list[str]) -> str:
    clean = " ".join(line.strip() for line in lines if line.strip())
    if len(clean) <= 240:
        return clean
    return clean[:237].rstrip() + "..."


def _split_line_segment(start: int, end: int, heading: str) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    current = start
    while current <= end:
        chunk_end = min(end, current + SESSION_DOCUMENT_CHUNK_TARGET_LINES - 1)
        chunks.append(
            {
                "start_line": current + 1,
                "end_line": chunk_end + 1,
                "heading": heading,
            }
        )
        if chunk_end >= end:
            break
        current = max(current + 1, chunk_end - SESSION_DOCUMENT_CHUNK_OVERLAP_LINES + 1)
    return chunks


def _line_chunks(lines: list[str]) -> list[dict[str, Any]]:
    if not lines:
        return []
    headings = [(index, heading) for index, line in enumerate(lines) if (heading := _heading_from_line(line))]
    if not headings:
        return _split_line_segment(0, len(lines) - 1, "")

    chunks: list[dict[str, Any]] = []
    first_heading_index = headings[0][0]
    if first_heading_index > 0:
        chunks.extend(_split_line_segment(0, first_heading_index - 1, ""))
    for position, (start, heading) in enumerate(headings):
        next_start = headings[position + 1][0] if position + 1 < len(headings) else len(lines)
        chunks.extend(_split_line_segment(start, next_start - 1, heading))
    return chunks


def _write_session_document_index(document_id: str, document_path: Path, text: str) -> dict[str, Any]:
    lines = text.splitlines()
    chunks: list[dict[str, Any]] = []
    for index, chunk in enumerate(_line_chunks(lines), start=1):
        start_line = int(chunk["start_line"])
        end_line = int(chunk["end_line"])
        chunk_lines = lines[start_line - 1 : end_line]
        chunks.append(
            {
                "chunk_index": index,
                "start_line": start_line,
                "end_line": end_line,
                "heading": chunk.get("heading") or "",
                "preview": _chunk_preview(chunk_lines),
            }
        )
    index_data = {
        "version": SESSION_DOCUMENT_INDEX_VERSION,
        "document_id": document_id,
        "line_count": len(lines),
        "chunk_count": len(chunks),
        "chunks": chunks,
    }
    atomic_write_text(
        _document_index_path(document_path),
        json.dumps(index_data, ensure_ascii=False, sort_keys=True) + "\n",
    )
    return index_data


=======
>>>>>>> codex/session-documents
def store_session_document(
    *,
    cwd: str | Path,
    session_id: str,
    text: str,
    model: str | None = None,
    metadata: dict[str, Any] | None = None,
<<<<<<< HEAD
    source_kind: str = "user_input",
    source_label: str | None = None,
    tool_name: str | None = None,
    tool_use_id: str | None = None,
    original_estimated_tokens: int | None = None,
=======
>>>>>>> codex/session-documents
) -> dict[str, Any]:
    if not SESSION_ID_RE.fullmatch(session_id):
        raise ValueError(f"Invalid session id for session document storage: {session_id}")
    document_id = _document_id(text)
    document_dir = get_session_document_dir(cwd, session_id)
    document_path = document_dir / f"{document_id}.txt"
    if not document_path.exists():
        atomic_write_text(document_path, text if text.endswith("\n") else f"{text}\n")
<<<<<<< HEAD
    index_data = _write_session_document_index(document_id, document_path, text)
    line_count = len(text.splitlines())
    estimated_tokens = estimate_tokens(text, model=model)
    normalized_source_kind = source_kind or "user_input"
=======
    line_count = len(text.splitlines())
>>>>>>> codex/session-documents
    entry = {
        "id": document_id,
        "session_id": session_id,
        "path": str(document_path.resolve()),
        "line_count": line_count,
<<<<<<< HEAD
        "chunk_count": index_data["chunk_count"],
        "char_count": len(text),
        "estimated_tokens": estimated_tokens,
        "index_path": str(_document_index_path(document_path).resolve()),
        "source_kind": normalized_source_kind,
        "source_label": source_label or (
            "User input" if normalized_source_kind == "user_input" else normalized_source_kind
        ),
        "tool_name": tool_name or "",
        "tool_use_id": tool_use_id or "",
        "original_estimated_tokens": (
            original_estimated_tokens if original_estimated_tokens is not None else estimated_tokens
        ),
=======
        "char_count": len(text),
        "estimated_tokens": estimate_tokens(text, model=model),
>>>>>>> codex/session-documents
        "created_at": int(time.time() * 1000),
        "short_hint": _short_hint(text),
    }
    if metadata is not None:
        documents = _metadata_documents(metadata)
        documents = [item for item in documents if item.get("id") != document_id]
        documents.append(entry)
        metadata["session_documents"] = documents
    return entry


def build_session_document_message(entry: dict[str, Any], user_request: str, source_text: str) -> ConversationMessage:
    document_id = str(entry.get("id") or "")
    text = (
        "Session document stored from an oversized pasted user input.\n\n"
        f"- document_id: {document_id}\n"
        f"- line_count: {entry.get('line_count')}\n"
<<<<<<< HEAD
        f"- chunk_count: {entry.get('chunk_count')}\n"
=======
>>>>>>> codex/session-documents
        f"- char_count: {entry.get('char_count')}\n"
        f"- estimated_tokens: {entry.get('estimated_tokens')}\n"
        f"- short_hint: {entry.get('short_hint')}\n\n"
        "User request:\n"
        f"{user_request.strip() or '(included in the pasted document)'}\n\n"
        "Document sample only, not a replacement for the source:\n"
        f"{_sample(source_text)}\n\n"
        "Important instructions:\n"
        "- Do not rely on this sample alone for substantive conclusions.\n"
        f"- Before judging facts, search the full source with session_document_search(document_id=\"{document_id}\", query=...).\n"
        f"- Read relevant original line ranges with session_document_read(document_id=\"{document_id}\", start_line=..., limit=...).\n"
        "- Never paste the full source document back into the conversation."
    )
    return ConversationMessage.from_user_text(text)


def find_session_document(metadata: dict[str, Any], document_id: str) -> dict[str, Any] | None:
    if not DOCUMENT_ID_RE.fullmatch(document_id):
        return None
    for entry in _metadata_documents(metadata):
        if str(entry.get("id") or "") == document_id:
            return entry
    return None


def resolve_session_document_path(cwd: str | Path, metadata: dict[str, Any], document_id: str) -> Path | None:
    entry = find_session_document(metadata, document_id)
    if entry is None:
        return None
    raw_path = str(entry.get("path") or "").strip()
    if not raw_path:
        return None
    path = Path(raw_path).expanduser().resolve()
    root = get_session_document_root(cwd).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    if not path.is_file():
        return None
    return path

<<<<<<< HEAD

def resolve_session_document_index_path(cwd: str | Path, metadata: dict[str, Any], document_id: str) -> Path | None:
    entry = find_session_document(metadata, document_id)
    if entry is None:
        return None
    document_path = resolve_session_document_path(cwd, metadata, document_id)
    if document_path is None:
        return None
    raw_path = str(entry.get("index_path") or "").strip()
    path = Path(raw_path).expanduser().resolve() if raw_path else _document_index_path(document_path).resolve()
    root = get_session_document_root(cwd).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    if not path.is_file():
        return None
    return path

=======
>>>>>>> codex/session-documents

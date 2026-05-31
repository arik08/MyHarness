"""Session-scoped storage for oversized pasted user documents."""

from __future__ import annotations

import hashlib
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


def store_session_document(
    *,
    cwd: str | Path,
    session_id: str,
    text: str,
    model: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not SESSION_ID_RE.fullmatch(session_id):
        raise ValueError(f"Invalid session id for session document storage: {session_id}")
    document_id = _document_id(text)
    document_dir = get_session_document_dir(cwd, session_id)
    document_path = document_dir / f"{document_id}.txt"
    if not document_path.exists():
        atomic_write_text(document_path, text if text.endswith("\n") else f"{text}\n")
    line_count = len(text.splitlines())
    entry = {
        "id": document_id,
        "session_id": session_id,
        "path": str(document_path.resolve()),
        "line_count": line_count,
        "char_count": len(text),
        "estimated_tokens": estimate_tokens(text, model=model),
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


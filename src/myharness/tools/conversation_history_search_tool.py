"""Search archived user-authored conversation inputs."""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class ConversationHistorySearchInput(BaseModel):
    """Arguments for conversation history lookup."""

    query: str | None = Field(
        default=None,
        description="Optional search text to find archived user inputs by substring or terms.",
    )
    id: str | None = Field(
        default=None,
        description="Optional archived user input ID to return verbatim.",
    )
    limit: int = Field(
        default=5,
        description="Maximum matching archived user inputs to return when searching by query.",
    )


def _archive_from_context(context: ToolExecutionContext) -> list[dict[str, Any]]:
    metadata = context.metadata.get("_shared_tool_metadata")
    if not isinstance(metadata, dict):
        metadata = context.metadata
    archive = metadata.get("user_input_archive") if isinstance(metadata, dict) else None
    if not isinstance(archive, list):
        return []
    return [
        item
        for item in archive
        if isinstance(item, dict)
        and str(item.get("id") or "").strip()
        and str(item.get("text") or "").strip()
    ]


def _tokens(text: str) -> list[str]:
    return [token for token in re.split(r"\s+", text.lower().strip()) if token]


def _score_entry(entry: dict[str, Any], query: str) -> int:
    haystack = f"{entry.get('short_hint') or ''}\n{entry.get('text') or ''}".lower()
    q = query.lower().strip()
    if not q:
        return 1
    score = 0
    if q in haystack:
        score += 100
    for token in _tokens(q):
        if token in haystack:
            score += 10
    return score


def _format_search_entry(entry: dict[str, Any]) -> str:
    entry_id = str(entry.get("id") or "").strip()
    turn = entry.get("turn_index")
    hint = str(entry.get("short_hint") or entry.get("text") or "").strip()
    return f"- {entry_id} (turn {turn}): {hint}"


class ConversationHistorySearchTool(BaseTool):
    """Retrieve archived user inputs omitted from compact summaries."""

    name = "conversation_history_search"
    description = (
        "Search or retrieve archived user-authored inputs omitted during context compaction. "
        "Use only when a prior user question or pasted context may be needed but is missing from the compact summary."
    )
    input_model = ConversationHistorySearchInput

    def is_read_only(self, arguments: ConversationHistorySearchInput) -> bool:
        del arguments
        return True

    async def execute(self, arguments: ConversationHistorySearchInput, context: ToolExecutionContext) -> ToolResult:
        archive = _archive_from_context(context)
        if not archive:
            return ToolResult(output="No archived user inputs are available.")

        requested_id = (arguments.id or "").strip()
        if requested_id:
            for entry in archive:
                if str(entry.get("id") or "").strip() == requested_id:
                    return ToolResult(
                        output=(
                            f"Archived user input: {requested_id}\n"
                            f"Turn: {entry.get('turn_index')}\n\n"
                            f"{str(entry.get('text') or '').strip()}"
                        )
                    )
            return ToolResult(output=f"No archived user input found for id: {requested_id}", is_error=True)

        query = (arguments.query or "").strip()
        limit = max(1, min(int(arguments.limit or 5), 20))
        scored = [
            (score, index, entry)
            for index, entry in enumerate(archive)
            if (score := _score_entry(entry, query)) > 0
        ]
        if not scored:
            return ToolResult(output="(no matches)")
        scored.sort(key=lambda item: (-item[0], -item[1]))
        matches = [entry for _score, _index, entry in scored[:limit]]
        return ToolResult(output="\n".join(_format_search_entry(entry) for entry in matches))

"""Model-family capabilities shared by the API-key cache request builders."""

from __future__ import annotations

import re


def supports_modern_prompt_cache(model: str) -> bool:
    """Return whether a GPT model uses the GPT-5.6+ cache options contract."""
    normalized = str(model or "").strip().lower().rsplit("/", 1)[-1]
    match = re.match(r"gpt-(\d+)(?:\.(\d+))?(?:-|$)", normalized)
    if match is None:
        return False
    return (int(match[1]), int(match[2] or 0)) >= (5, 6)

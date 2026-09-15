"""Credential-safe copies of execution data for UI transport and history."""

from __future__ import annotations

import re
from typing import Any

_KEY = r"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret|service[_-]?key|secret|cookie)"
_SECRET_KEY = re.compile(rf"(?:^|[_-]){_KEY}$", re.IGNORECASE)
_ASSIGNMENT = re.compile(rf'''((?:["']?{_KEY}["']?)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&}}\n]+)''', re.IGNORECASE)


def execution_display_value(value: Any) -> Any:
    """Redact credential fields without mutating the tool's real input/result."""
    if isinstance(value, dict):
        return {key: "[가림]" if _SECRET_KEY.search(str(key)) else execution_display_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [execution_display_value(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [가림]", value, flags=re.IGNORECASE)
        return _ASSIGNMENT.sub(r"\1[가림]", value)
    return value

"""Subagent feature gate."""

from __future__ import annotations


SUBAGENT_INVOCATION_DISABLED_MESSAGE = (
    "서브에이전트 호출 기능은 현재 비활성화되어 있습니다. "
    "새 작업자를 만들지 말고 현재 세션에서 직접 처리하세요."
)


def is_subagent_invocation_enabled() -> bool:
    """Return whether new subagent invocation is enabled."""
    return False

"""Windows-specific subprocess options."""

from __future__ import annotations

import subprocess

from myharness.platforms import PlatformName, get_platform


def hidden_subprocess_kwargs(*, platform_name: PlatformName | None = None) -> dict[str, int]:
    """Return kwargs that prevent short-lived console windows on Windows."""
    resolved_platform = platform_name or get_platform()
    if resolved_platform != "windows":
        return {}
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return {"creationflags": creationflags} if creationflags else {}

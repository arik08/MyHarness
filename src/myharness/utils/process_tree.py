"""Terminate owned local process trees with a bounded pipe/reap wait."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal

PROCESS_REAP_TIMEOUT = 2.0


def kill_process_tree(process: asyncio.subprocess.Process) -> None:
    """Kill only a registered tree; external/sandbox processes retain PID semantics."""
    job = getattr(process, "_myharness_job", None)
    group = getattr(process, "_myharness_process_group", None)
    if job is not None:
        job.close()
    elif group is not None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(group, signal.SIGKILL)
    else:
        with contextlib.suppress(ProcessLookupError):
            process.kill()


async def terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    # Do not skip exited parents: their descendants can still own stdout/stderr.
    kill_process_tree(process)
    try:
        await asyncio.wait_for(process.wait(), timeout=PROCESS_REAP_TIMEOUT)
    except asyncio.TimeoutError:
        # asyncio Process has no public pipe-close API. This fallback is needed
        # for unowned/escaped descendants which keep inherited pipe handles open.
        transport = getattr(process, "_transport", None)
        if transport is not None:
            transport.close()
    except ProcessLookupError:
        pass

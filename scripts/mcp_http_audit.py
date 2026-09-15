"""Audit-only MCP launcher: record HTTP status/latency without URLs or credentials."""
from functools import wraps
import json
from pathlib import Path
import runpy
import sys
import time

import httpx


def main():
    log = Path(sys.argv[1])
    target = Path(sys.argv[2]).resolve()

    def instrument(fn):
        @wraps(fn)
        def invoke(*args, **kwargs):
            started = time.perf_counter()
            entry = {"method": fn.__name__}
            try:
                response = fn(*args, **kwargs)
                entry["status"] = response.status_code
                entry["cache"] = response.headers.get("x-cache")
                entry["retry_after"] = response.headers.get("retry-after")
                return response
            except Exception as exc:
                entry["exception"] = type(exc).__name__
                raise
            finally:
                entry["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
                with log.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(entry) + "\n")
        return invoke

    httpx.get = instrument(httpx.get)
    httpx.post = instrument(httpx.post)
    sys.argv = [str(target), *sys.argv[3:]]
    sys.path.insert(0, str(target.parent))
    runpy.run_path(str(target), run_name="__main__")


if __name__ == "__main__":
    main()

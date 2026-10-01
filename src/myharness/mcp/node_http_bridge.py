"""Private one-request transport for packaged Node MCPs (JSON over pipes).

Uses the same verified TLS/proxy transport as Python MCPs. Never logs URLs,
headers or credentials. No listening socket or temporary credential file.
"""
from __future__ import annotations

import base64
import json
import sys

from official_data import httpx_verify_argument
import httpx


def main() -> None:
    try:
        request = json.load(sys.stdin)
        url = httpx.URL(request["url"])
        if url.scheme not in {"http", "https"}:
            raise ValueError("Unsupported URL scheme")
        method = request.get("method", "GET").upper()
        if method not in {"GET", "HEAD"}:
            raise ValueError("Packaged public-data MCP transport supports GET/HEAD only")
        with httpx.Client(verify=httpx_verify_argument(), follow_redirects=True, timeout=request["timeout_ms"] / 1000) as client:
            with client.stream(method, url, headers=request.get("headers", {})) as response:
                chunks = []
                length = 0
                for chunk in response.iter_bytes():
                    length += len(chunk)
                    if length > 20 * 1024 * 1024:
                        raise ValueError("MCP response exceeds 20 MiB")
                    chunks.append(chunk)
                # httpx decompressed the body; do not forward stale encodings.
                headers = {k: v for k, v in response.headers.items() if k.lower() not in {"content-encoding", "content-length", "transfer-encoding"}}
                result = {"status": response.status_code, "headers": headers, "body": base64.b64encode(b"".join(chunks)).decode("ascii")}
    except Exception as exc:
        result = {"error": f"MCP network request failed ({type(exc).__name__}). Check proxy, trusted CA bundle, DNS and endpoint availability."}
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()

# National Assembly MCP runtime

This directory contains the repository-bundled runtime for
[`hollobit/assembly-api-mcp`](https://github.com/hollobit/assembly-api-mcp) at
commit `f74c6b452c59d87e2fa7265fd985b90e4057a8ef`.

`index.js` and its generated `*.index.js` chunk were produced with `@vercel/ncc` 0.38.4 after
applying `assembly-api-mcp-network-retry.patch`. The compatibility patch also
normalizes API discovery terms and current/former committee names. NABO exposes report lookup and keyword search only; unused publication and recruitment APIs are removed from the client and tool schema. NABO authorization
failures are scoped to each endpoint and are not retried until reconnect; request logs
omit credential query strings. Runtime dependencies are
included in the bundle, so a normal MyHarness installation does not clone the
upstream repository or run `npm install` for this MCP.

`NATIONAL_ASSEMBLY_MCP_DIR` remains available only for maintainers who
explicitly want to run and rebuild a compatible upstream checkout.

The upstream license is in `UPSTREAM_LICENSE.txt`; bundled dependency notices
are in `licenses.txt`.

The bootstrap preloads `_myharness_mcp_support/node_fetch.cjs`. Read-only HTTP
requests use the launching Python interpreter and httpx, including proxy and
custom CA environment settings; TLS verification remains enabled. The default
request timeout is 30 seconds (`MCP_HTTP_TIMEOUT_MS`: 1000–120000 milliseconds).
Copy the whole MCP directory, including the support directory, between hosts.
Do not copy only `index.js` or substitute another application's helper module.

Support files are generated from `src/myharness/mcp` using
`python scripts/sync_mcp_support.py`; `--check` detects stale package copies.

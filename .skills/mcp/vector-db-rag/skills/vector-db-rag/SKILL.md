---
name: vector-db-rag
description: 로컬 Markdown 조직 업무 문서를 SQLite GraphRAG MCP로 검색합니다. 회사 조직별 업무, 조직 계층, 부서별 역할, 두 문서 간 업무 비교, 특정 조직 산하 업무 조회가 필요할 때 사용합니다.
source: skill-mcp:vector_db
---

# Vector DB RAG

Use the `vector_db` MCP server for organization-work knowledge stored under `.skills/mcp/vector-db-rag/runtime/documents/`.

Before relying on the store, call `store_status` or `list_sources`. Distinguish an empty corpus (no indexed documents) from a retrieval failure against an indexed corpus.

If the database is empty and the user has already placed documents in the configured documents directory, ingest/index only those user-provided documents, then call `store_status` or `list_sources` again before searching. Do not invent, download, or silently add documents. If no documents were provided, ask for them instead of treating the empty result as a search failure. The manual indexing command is:

```powershell
python .skills/mcp/vector-db-rag/runtime/ingest.py index
```

For verification or experiments, set `VECTOR_DB_RAG_DB_PATH` to a temporary isolated database and index fixture or explicitly scoped user documents there. Do not write test data into, replace, or re-index the user's normal database. After an indexed search returns no matches, report that as "indexed corpus, no matching result" and include the applied query/filter conditions.

For hierarchy questions such as "마케팅본부 산하 업무" or "조직 계층", use `explore_org` first.

For detailed 업무, 정책, 절차, 역할, or comparison questions, use `retrieve_context` with `mode="hybrid"`. Pass `document_name` when the user names one of the two source documents, and pass `org_unit` when the user names a department/team.

When answering, preserve source identifiers from the MCP result: `source_label`, `citation`, `source_chip`, `excerpt`, `document_name`, `source_path`, `heading_path`, and `lines`. Prefer the provided `source_chip` for citations so the UI renders a compact designed source chip with the referenced sentence on hover. Do not cite every sentence or every line; prefer one chip per paragraph, bullet, or source change. Line numbers are secondary and usually should not appear in the visible label. If results come from both documents, group the answer by `document_name` instead of merging them silently.

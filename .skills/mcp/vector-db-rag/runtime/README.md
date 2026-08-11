# Vector GraphRAG MCP Usage

This folder stores a local SQLite GraphRAG index for Markdown organization-work documents.

## 1. Add Documents

Put Markdown files in:

```powershell
.skills/mcp/vector-db-rag/runtime/documents/
```

Recommended document header:

```markdown
---
document_name: 조직업무문서 A
---

# 회사 업무
## 마케팅본부
### 브랜드팀
#### 캠페인 운영
- 주요 업무...
```

`document_name` is stored on every chunk. If it is missing, the indexer uses the first H1 title, then the file name.

## 2. Build Or Update The DB

Run from the MyHarness repo root:

```powershell
python .skills/mcp/vector-db-rag/runtime/ingest.py index
```

The generated SQLite DB is:

```powershell
.skills/mcp/vector-db-rag/runtime/data/vector_graph.sqlite
```

The indexer updates changed files, keeps unchanged files, and removes DB records for deleted source files.

## 3. Management Commands

```powershell
python .skills/mcp/vector-db-rag/runtime/ingest.py status
python .skills/mcp/vector-db-rag/runtime/ingest.py sources
python .skills/mcp/vector-db-rag/runtime/ingest.py search "마케팅본부 캠페인 업무"
python .skills/mcp/vector-db-rag/runtime/ingest.py explore-org "마케팅본부"
python .skills/mcp/vector-db-rag/runtime/ingest.py clear
```

Useful filters:

```powershell
python .skills/mcp/vector-db-rag/runtime/ingest.py search "계약 정산" --document-name "조직업무문서 A"
python .skills/mcp/vector-db-rag/runtime/ingest.py search "브랜드팀" --org-unit "마케팅본부" --mode hybrid
python .skills/mcp/vector-db-rag/runtime/ingest.py explore-org "마케팅본부" --document-name "조직업무문서 A" --depth 3
```

## 4. MyHarness MCP Usage

The MCP config is registered in:

```powershell
.skills/mcp/vector-db-rag/mcp.json
```

In MyHarness, select the wrapped MCP skill:

```text
$mcp:vector-db-rag 마케팅본부 산하 업무 정리해줘
```

Use cases:

- Organization hierarchy questions: the agent should call `explore_org`.
- Detailed 업무, 정책, 절차, 역할, comparison questions: the agent should call `retrieve_context` with `mode="hybrid"`.
- Source listing or health checks: the agent should call `list_sources` or `store_status`.

MCP tool results include `source_label`, `citation`, `source_chip`, `excerpt`, `document_name`, `source_path`, `heading_path`, `org_path`, and `lines`. Keep these identifiers in final answers when citing evidence. Prefer `source_chip` so the UI renders a compact source chip and shows the referenced sentence on hover. Do not cite every sentence or every line; prefer one chip per paragraph, bullet, or source change.

## 5. Storage Policy

The source documents and generated DB are local-only and ignored by git:

```powershell
.skills/mcp/vector-db-rag/runtime/documents/*
.skills/mcp/vector-db-rag/runtime/data/*
```

Only the program files and `.gitkeep` placeholders are tracked.

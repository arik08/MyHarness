"""Tests for the local Vector GraphRAG MCP server."""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
from types import ModuleType

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig


ROOT = Path(__file__).resolve().parents[2]
VECTOR_DIR = ROOT / ".mcp" / "vector_db"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_store() -> ModuleType:
    return _load_module("vector_db_store_under_test", VECTOR_DIR / "store.py")


def _load_server() -> ModuleType:
    return _load_module("vector_db_server_under_test", VECTOR_DIR / "server.py")


def _write_fixture_docs(documents_dir: Path) -> None:
    documents_dir.mkdir(parents=True)
    (documents_dir / "doc-a.md").write_text(
        """---
document_name: 업무문서 A
---
# 회사 업무 A
## 마케팅본부
### 브랜드팀
#### 캠페인 운영
- 브랜드 캠페인 기획
- 고객 반응 분석

| 업무 | 담당 |
| --- | --- |
| 캠페인 예산 | 브랜드팀 |
| 광고 소재 | 브랜드팀 |
""",
        encoding="utf-8",
    )
    (documents_dir / "doc-b.md").write_text(
        """---
document_name: 업무문서 B
---
# 회사 업무 B
## 마케팅본부
### 브랜드팀
#### 계약 관리
- 대행사 계약 검토
- 정산 증빙 관리

## 생산본부
### 품질팀
#### 품질 점검
품질 점검 기준과 개선 요청을 관리한다.
""",
        encoding="utf-8",
    )


def test_indexes_two_documents_with_separate_document_metadata(tmp_path: Path) -> None:
    store = _load_store()
    docs_dir = tmp_path / "documents"
    db_path = tmp_path / "data" / "rag.sqlite"
    _write_fixture_docs(docs_dir)

    result = store.index_directory(docs_dir, db_path)

    assert result["document_count"] == 2
    sources = store.list_sources(db_path)["documents"]
    assert {source["document_name"] for source in sources} == {"업무문서 A", "업무문서 B"}
    assert all(source["chunk_count"] > 0 for source in sources)

    with sqlite3.connect(db_path) as db:
        db.row_factory = sqlite3.Row
        parent_edges = db.execute(
            "SELECT * FROM edges WHERE edge_type = 'parent_of'"
        ).fetchall()
        sibling_edges = db.execute(
            "SELECT * FROM edges WHERE edge_type = 'next_sibling'"
        ).fetchall()
        chunks = db.execute(
            "SELECT document_name, heading_path, org_path, text FROM chunks"
        ).fetchall()

    assert parent_edges
    assert sibling_edges
    assert {chunk["document_name"] for chunk in chunks} == {"업무문서 A", "업무문서 B"}
    assert any("마케팅본부" in chunk["org_path"] for chunk in chunks)
    assert all("document_name:" not in chunk["text"] for chunk in chunks)


def test_vector_db_config_is_loaded_as_stdio_server() -> None:
    configs = load_mcp_configs_from_dirs([ROOT / ".mcp"])

    server = configs["vector_db"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == [".mcp/vector_db/server.py"]
    assert server.cwd == "."
    assert server.auto_connect is False


def test_retrieve_context_filters_by_document_name_and_expands_graph(tmp_path: Path) -> None:
    store = _load_store()
    docs_dir = tmp_path / "documents"
    db_path = tmp_path / "data" / "rag.sqlite"
    _write_fixture_docs(docs_dir)
    store.index_directory(docs_dir, db_path)

    result = store.retrieve_context(
        "대행사 계약 정산",
        db_path=db_path,
        document_name="업무문서 B",
        mode="hybrid",
        limit=3,
    )

    assert result["results"]
    assert {item["document_name"] for item in result["results"]} == {"업무문서 B"}
    assert any(item["graph_context"] for item in result["results"])
    assert any("계약 관리" in " > ".join(item["heading_path"]) for item in result["results"])
    first = result["results"][0]
    assert first["source_label"] == "업무문서 B"
    assert first["citation"] == "업무문서 B (doc-b.md lines 8-9)"
    assert "대행사 계약 검토" in first["excerpt"]


def test_explore_org_returns_hierarchy_for_matching_document(tmp_path: Path) -> None:
    store = _load_store()
    docs_dir = tmp_path / "documents"
    db_path = tmp_path / "data" / "rag.sqlite"
    _write_fixture_docs(docs_dir)
    store.index_directory(docs_dir, db_path)

    result = store.explore_org("마케팅본부", db_path=db_path, document_name="업무문서 A", depth=3)

    assert len(result["results"]) == 1
    tree = result["results"][0]
    assert tree["document_name"] == "업무문서 A"
    assert tree["name"] == "마케팅본부"
    assert tree["children"][0]["name"] == "브랜드팀"


def test_mcp_server_uses_configured_db_path(tmp_path: Path, monkeypatch) -> None:
    store = _load_store()
    server = _load_server()
    docs_dir = tmp_path / "documents"
    db_path = tmp_path / "data" / "rag.sqlite"
    _write_fixture_docs(docs_dir)
    store.index_directory(docs_dir, db_path)
    monkeypatch.setenv("VECTOR_DB_RAG_DB_PATH", str(db_path))

    payload = json.loads(server.retrieve_context("브랜드 캠페인", document_name="업무문서 A"))

    assert payload["results"]
    assert payload["results"][0]["document_name"] == "업무문서 A"

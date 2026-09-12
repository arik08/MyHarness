"""Runtime and routing regression checks for the Korean Law MCP package."""

from __future__ import annotations

import json
import importlib.util
from pathlib import Path

import pytest

from myharness.mcp.client import McpClientManager
from myharness.mcp.config import load_mcp_configs_from_dirs


ROOT = Path(__file__).resolve().parents[2]


def test_korean_law_runtime_uses_fixed_upstream_release() -> None:
    package = json.loads(
        (ROOT / ".skills/mcp/korean-law/runtime/package.json").read_text(encoding="utf-8")
    )

    assert package["dependencies"]["korean-law-mcp"] == "4.9.7"


def test_korean_law_bootstrap_patches_exact_name_selection(tmp_path: Path) -> None:
    bootstrap_path = ROOT / ".skills/mcp/korean-law/runtime/bootstrap.py"
    spec = importlib.util.spec_from_file_location("korean_law_bootstrap", bootstrap_path)
    assert spec and spec.loader
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)

    build = tmp_path / "node_modules/korean-law-mcp/build/tools"
    build.mkdir(parents=True)
    search = build / "search.js"
    search.write_text(
        "let xmlText = await apiClient.searchLaw(input.query, input.apiKey, input.display);",
        encoding="utf-8",
    )
    annex = build / "annex.js"
    annex.write_text(
        "    // 쿼리에서 단어 추출\n"
        "    const queryWords = queryName.split(/\\s+/).filter((w) => w.length > 0);",
        encoding="utf-8",
    )
    # Minimal unpatched v4.9.7 anchors for the API/penalty compatibility fixes.
    (build.parent / "lib").mkdir()
    (build / "scenarios").mkdir()
    (build.parent / "lib/api-client.js").write_text('            target: "eflaw",', encoding="utf-8")
    (build / "law-text.js").write_text(
        '    jo: z.string().optional().describe(\n'
        "${input.efYd || 'current'}`;\n"
        '        if (articleUnits.length === 0) {\n'
        '        if (!input.jo && articleUnits.length > 20) {', encoding="utf-8"
    )
    (build / "scenarios/penalty.js").write_text('            search: "벌칙",', encoding="utf-8")

    bootstrap.apply_compatibility_patch(tmp_path)
    bootstrap.apply_compatibility_patch(tmp_path)

    assert "Math.max(input.display, 50)" in search.read_text(encoding="utf-8")
    patched_annex = annex.read_text(encoding="utf-8")
    assert "const exact = annexList.filter" in patched_annex
    assert "=== queryKey" in patched_annex
    assert "부분 LIKE 오탐" in patched_annex


def test_law_text_uses_valid_endpoint_and_returns_filtered_article_bodies() -> None:
    """Exercise the installed JS with a fake HTTP response, including cache reuse."""
    import subprocess

    runtime = ROOT / ".skills/mcp/korean-law/runtime"
    spec = importlib.util.spec_from_file_location("law_bootstrap_contract", runtime / "bootstrap.py")
    assert spec and spec.loader
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    bootstrap.apply_compatibility_patch(runtime)
    script = r'''
import assert from 'node:assert/strict';
import {LawApiClient} from './lib/api-client.js';
import {getLawText} from './tools/law-text.js';
const urls = [];
globalThis.fetch = async url => {
    urls.push(new URL(url));
    const units = Array.from({length: 25}, (_, i) => ({
        조문여부: '조문', 조문번호: String(i + 1),
        조문제목: i === 24 ? '과징금' : '일반 사항',
        조문내용: i === 24 ? '원문 과징금 근거' : '일반 본문',
    }));
    return new Response(JSON.stringify({법령: {기본정보: {법령명_한글: '시험법'}, 조문: {조문단위: units}}}));
};
const api = new LawApiClient({apiKey: 'fixture'});
const toc = await getLawText(api, {mst: '123'});
assert.match(toc.content[0].text, /목차/);
assert.equal(urls[0].searchParams.get('target'), 'law');
const filtered = await getLawText(api, {mst: '123', search: '벌칙 과태료 과징금'});
assert.equal(filtered.isError, undefined);
assert.match(filtered.content[0].text, /원문 과징금 근거/);
assert.doesNotMatch(filtered.content[0].text, /일반 본문|목차/);
await api.getLawText({mst: '123', efYd: '20250101'});
assert.equal(urls.at(-1).searchParams.get('target'), 'eflaw');
assert.equal(urls.at(-1).searchParams.get('efYd'), '20250101');
await api.getLawText({lawId: '456'});
assert.equal(urls.at(-1).searchParams.get('target'), 'eflaw');
console.log('PASS');
'''
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=runtime / "node_modules/korean-law-mcp/build",
        capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "PASS" in result.stdout


@pytest.mark.asyncio
async def test_korean_law_routes_exact_law_penalty_and_decisions() -> None:
    config = load_mcp_configs_from_dirs([ROOT / ".skills/mcp"])["korean-law"]
    manager = McpClientManager({"korean-law": config})

    await manager.ensure_server_config("korean-law", config, force_connect=True)
    try:
        status = manager.list_statuses()[0]
        assert status.state == "connected", status.detail
        tools = {tool.name: tool for tool in status.tools}
        assert "legal_research" in tools
        assert tools["legal_research"].input_schema["properties"]["scenario"]["enum"]
        assert "penalty" in tools["legal_research"].input_schema["properties"]["scenario"]["enum"]

        law_system = await manager.call_tool(
            "korean-law",
            "legal_research",
            {"query": "개인정보 보호법", "task": "law_system"},
        )
        assert "법체계 확인: 개인정보 보호법" in law_system
        assert "119구조" not in law_system

        penalty = await manager.call_tool(
            "korean-law",
            "legal_research",
            {
                "query": "개인정보 보호법 과징금 부과 기준",
                "task": "action_basis",
                "scenario": "penalty",
            },
        )
        assert "처분 근거 확인: 개인정보 보호법" in penalty
        assert "벌칙·과태료" in penalty

        precedents = await manager.call_tool(
            "korean-law",
            "search_decisions",
            {"domain": "precedent", "query": "개인정보", "display": 3},
        )
        assert "판례 검색 결과 (총 " in precedents
        assert precedents.count("사건번호:") == 3
    finally:
        await manager.close()

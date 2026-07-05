"""Tests for built-in tools."""

from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path

import pytest

from myharness.tools.bash_tool import BashTool, BashToolInput
from myharness.tools.base import ToolExecutionContext
from myharness.tools.brief_tool import BriefTool, BriefToolInput
from myharness.tools.cron_create_tool import CronCreateTool, CronCreateToolInput
from myharness.tools.conversation_history_search_tool import ConversationHistorySearchTool, ConversationHistorySearchInput
from myharness.tools.cron_delete_tool import CronDeleteTool, CronDeleteToolInput
from myharness.tools.cron_list_tool import CronListTool, CronListToolInput
from myharness.tools.enter_plan_mode_tool import EnterPlanModeTool, EnterPlanModeToolInput
from myharness.tools.config_tool import ConfigTool, ConfigToolInput
from myharness.tools.exit_plan_mode_tool import ExitPlanModeTool, ExitPlanModeToolInput
from myharness.tools.enter_worktree_tool import EnterWorktreeTool, EnterWorktreeToolInput
from myharness.tools.exit_worktree_tool import ExitWorktreeTool, ExitWorktreeToolInput
from myharness.tools.file_edit_tool import FileEditTool, FileEditToolInput
from myharness.tools.file_read_tool import FileReadTool, FileReadToolInput
from myharness.tools.file_write_tool import FileWriteTool, FileWriteToolInput
from myharness.tools.html_source_footnotes import SOURCE_FOOTNOTE_CSS_MARKER
from myharness.tools.source_evidence import SOURCE_EVIDENCE_METADATA_KEY
from myharness.tools.glob_tool import GlobTool, GlobToolInput
from myharness.tools.grep_tool import GrepTool, GrepToolInput
from myharness.tools.lsp_tool import LspTool, LspToolInput
from myharness.tools.notebook_edit_tool import NotebookEditTool, NotebookEditToolInput
from myharness.tools.remote_trigger_tool import RemoteTriggerTool, RemoteTriggerToolInput
from myharness.tools.session_document_tool import (
    SessionDocumentReadTool,
    SessionDocumentReadToolInput,
    SessionDocumentSearchTool,
    SessionDocumentSearchToolInput,
)
from myharness.tools.skill_tool import SkillTool, SkillToolInput
from myharness.skills.state import get_skill_usage_count, get_skill_usage_counts
from myharness.tools.todo_write_tool import TodoWriteTool, TodoWriteToolInput
from myharness.tools.tool_search_tool import ToolSearchTool, ToolSearchToolInput
from myharness.tools import create_default_tool_registry
from myharness.tools.ask_user_question_tool import AskUserQuestionTool
from myharness.config.settings import load_settings
from myharness.services.session_documents import store_session_document


def _python_stdout_command(text: str) -> str:
    code = f"import sys; sys.stdout.write({text!r})"
    if sys.platform == "win32":
        return f"& {sys.executable!r} -c {code!r}"
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


@pytest.mark.asyncio
async def test_file_write_read_and_edit(tmp_path: Path):
    context = ToolExecutionContext(cwd=tmp_path)

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="notes.txt", content="one\ntwo\nthree\n"),
        context,
    )
    assert write_result.is_error is False
    assert write_result.output == "Wrote notes.txt"
    assert (tmp_path / "notes.txt").exists()

    read_result = await FileReadTool().execute(
        FileReadToolInput(path="notes.txt", offset=1, limit=2),
        context,
    )
    assert "2\ttwo" in read_result.output
    assert "3\tthree" in read_result.output

    edit_result = await FileEditTool().execute(
        FileEditToolInput(path="notes.txt", old_str="two", new_str="TWO"),
        context,
    )
    assert edit_result.is_error is False
    assert "TWO" in (tmp_path / "notes.txt").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_file_write_result_hides_local_path_before_playground(tmp_path: Path):
    workspace = tmp_path / "repo" / "Playground" / "shared" / "Default"
    context = ToolExecutionContext(cwd=workspace)

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="outputs/report.md", content="# Report\n"),
        context,
    )

    assert write_result.is_error is False
    assert write_result.output == "Wrote Playground/shared/Default/outputs/report.md"
    assert str(tmp_path) not in write_result.output


@pytest.mark.asyncio
async def test_file_write_replaces_spaces_in_generated_filename(tmp_path: Path):
    context = ToolExecutionContext(cwd=tmp_path)

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="outputs/매출 보고서.html", content="<h1>Report</h1>"),
        context,
    )

    assert write_result.is_error is False
    assert write_result.output == "Wrote outputs/매출_보고서.html"
    assert (tmp_path / "outputs" / "매출_보고서.html").read_text(encoding="utf-8") == "<h1>Report</h1>"
    assert not (tmp_path / "outputs" / "매출 보고서.html").exists()


@pytest.mark.asyncio
async def test_file_write_warns_model_when_target_artifact_is_too_short(tmp_path: Path):
    context = ToolExecutionContext(
        cwd=tmp_path,
        metadata={
            "compose_target_output_tokens": 1_000,
            "compose_target_output_floor_tokens": 800,
            "model": "gpt-5.5",
        },
    )

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="outputs/report.html", content="<html><body><h1>Short</h1></body></html>"),
        context,
    )

    assert write_result.is_error is False
    assert write_result.output == "Wrote outputs/report.html"
    assert write_result.metadata["display_output"] == "Wrote outputs/report.html"
    assert "Target length check" in write_result.metadata["model_output"]
    assert "minimum acceptable floor of about 800 tokens" in write_result.metadata["model_output"]
    assert "calling `write_file` again on the same path" in write_result.metadata["model_output"]


@pytest.mark.asyncio
async def test_active_artifact_versioning_blocks_original_write_and_edit(tmp_path: Path):
    active = tmp_path / "outputs" / "report.html"
    active.parent.mkdir(parents=True)
    active.write_text("<h1>Original</h1>", encoding="utf-8")
    (tmp_path / "outputs" / "report v1.html").write_text("<h1>Legacy v1</h1>", encoding="utf-8")
    context = ToolExecutionContext(
        cwd=tmp_path,
        metadata={
            "compose_artifact_versioning": True,
            "compose_active_artifact_path": "outputs/report.html",
        },
    )

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="outputs/report.html", content="<h1>Changed</h1>"),
        context,
    )
    edit_result = await FileEditTool().execute(
        FileEditToolInput(path="outputs/report.html", old_str="Original", new_str="Changed"),
        context,
    )

    assert write_result.is_error is True
    assert edit_result.is_error is True
    assert "outputs/report_v2.html" in write_result.output
    assert "outputs/report_v2.html" in edit_result.output
    assert active.read_text(encoding="utf-8") == "<h1>Original</h1>"


@pytest.mark.asyncio
async def test_file_write_expands_html_source_footnote_css_marker(tmp_path: Path):
    context = ToolExecutionContext(
        cwd=tmp_path,
        metadata={
            SOURCE_EVIDENCE_METADATA_KEY: {
                "https://example.com/report": (
                    "Example Report. POSCO announced 17 trillion won in revenue and 700 billion won in operating profit. "
                    "Another unrelated sentence appears later."
                ),
            },
        },
    )
    content = (
        "<!doctype html><html><head>"
        f"{SOURCE_FOOTNOTE_CSS_MARKER}"
        "</head><body><p>POSCO announced 17 trillion won in revenue"
        '<sup class="source-ref">(<a href="#source-1">1</a>)</sup>'
        '</p><ol class="sources"><li><a id="source-1" href="https://example.com/report">Example Report</a></li></ol></body></html>'
    )

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="outputs/report.html", content=content),
        context,
    )

    saved = (tmp_path / "outputs" / "report.html").read_text(encoding="utf-8")
    assert write_result.is_error is False
    assert SOURCE_FOOTNOTE_CSS_MARKER not in saved
    assert 'id="myharness-source-footnotes"' in saved
    assert 'id="myharness-source-footnotes-script"' in saved
    assert '<sup class="source-ref"><a href="https://example.com/report"' in saved
    assert '(<a href="#source-1">1</a>)' not in saved
    assert ".myharness-source-tooltip" in saved
    assert "font:650 13px/1.45" in saved
    assert "vertical-align:middle" in saved
    assert "transform:translateY(-1px)" in saved
    assert "border-radius:50%" in saved
    assert ".sources,.source-list{font-size:14px;line-height:1.7" in saved
    assert ".sources a,.source-list a{color:#0b65c2;text-decoration:none!important" in saved
    assert "data-tooltip=\"example.com" in saved
    assert "&quot;POSCO announced 17 trillion won in revenue and 700 billion won in operating profit" in saved
    assert "operating profit.&quot;" in saved


@pytest.mark.asyncio
async def test_file_write_source_footnote_tooltip_ignores_pdf_metadata_noise(tmp_path: Path):
    context = ToolExecutionContext(
        cwd=tmp_path,
        metadata={
            SOURCE_EVIDENCE_METADATA_KEY: {
                "https://tatasteel.com": (
                    "%PDF-1.7 " + "\\ufffd" * 4 + " 1 0 obj <</Type/Catalog/Pages 2 0 R/Lang(en)"
                    "/StructTreeRoot 78 0 R/MarkInfo<</Marked true>>/Metadata 530 0 R"
                    "/ViewerPreferences 531 0 R>> endobj"
                ),
            },
        },
    )
    content = (
        "<!doctype html><html><head>"
        f"{SOURCE_FOOTNOTE_CSS_MARKER}"
        "</head><body><p>Tata Steel은 유럽 구조조정과 인도 성장 전략을 병행합니다"
        '<sup class="source-ref">(<a href="#source-1">1</a>)</sup>'
        '</p><ol class="sources"><li><a id="source-1" href="https://tatasteel.com">Tata Steel official reference</a></li></ol></body></html>'
    )

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="outputs/tata.html", content=content),
        context,
    )

    saved = (tmp_path / "outputs" / "tata.html").read_text(encoding="utf-8")
    assert write_result.is_error is False
    assert 'data-tooltip="tatasteel.com' in saved
    assert "Tata Steel official reference" in saved
    assert "%PDF" not in saved
    assert "/Type/Catalog" not in saved


@pytest.mark.asyncio
async def test_file_write_blocks_invalid_mermaid_before_writing(tmp_path: Path, monkeypatch):
    from myharness.tools import mermaid_preflight

    def fake_preflight(diagrams):
        return [
            mermaid_preflight.MermaidPreflightError(
                diagrams[0],
                "Parse error on line 2",
            )
        ]

    monkeypatch.setattr(mermaid_preflight, "_run_mermaid_preflight", fake_preflight)
    context = ToolExecutionContext(cwd=tmp_path)
    content = "```mermaid\ngraph TD\nA--B\n```\n"

    write_result = await FileWriteTool().execute(
        FileWriteToolInput(path="outputs/flow.md", content=content),
        context,
    )

    assert write_result.is_error is True
    assert "Mermaid preflight failed" in write_result.output
    assert "was not written" in write_result.output
    assert not (tmp_path / "outputs" / "flow.md").exists()


@pytest.mark.asyncio
async def test_file_edit_blocks_invalid_mermaid_before_updating(tmp_path: Path, monkeypatch):
    from myharness.tools import mermaid_preflight

    def fake_preflight(diagrams):
        return [
            mermaid_preflight.MermaidPreflightError(
                diagrams[0],
                "Parse error on line 3",
            )
        ]

    monkeypatch.setattr(mermaid_preflight, "_run_mermaid_preflight", fake_preflight)
    target = tmp_path / "flow.html"
    original = '<div class="mermaid">graph TD\nA-->B</div>\n'
    target.write_text(original, encoding="utf-8")

    edit_result = await FileEditTool().execute(
        FileEditToolInput(path="flow.html", old_str="A-->B", new_str="A--B"),
        ToolExecutionContext(cwd=tmp_path),
    )

    assert edit_result.is_error is True
    assert "Mermaid preflight failed" in edit_result.output
    assert "was not updated" in edit_result.output
    assert target.read_text(encoding="utf-8") == original


def test_file_write_tool_description_guides_human_artifact_filenames():
    description = FileWriteTool.description

    assert "direct coherent report artifacts" in description
    assert "24k, 32k, or 40k targets" in description
    assert "long-report section-merge flow is disabled" in description
    assert "surface research, analysis, outline, data, chart, or synthesis progress before this tool call" in description
    assert "human-facing HTML, Markdown, PDF, DOCX, XLSX, and PPTX artifacts" in description
    assert "Korean filenames" in description
    assert "underscores between words" in description
    assert "PY, JS, JSON, or CSV" in description
    assert SOURCE_FOOTNOTE_CSS_MARKER in description
    assert "expands it into the fixed source footnote CSS" in description


@pytest.mark.asyncio
async def test_file_tool_results_hide_absolute_paths_outside_workspace(tmp_path: Path):
    workspace = tmp_path / "repo" / "Playground" / "shared" / "Default"
    outside = tmp_path / "external" / "notes.txt"
    outside.parent.mkdir(parents=True)
    outside.write_text("alpha\n", encoding="utf-8")
    context = ToolExecutionContext(cwd=workspace)

    read_missing = await FileReadTool().execute(
        FileReadToolInput(path=str(tmp_path / "external" / "missing.txt")),
        context,
    )
    assert read_missing.is_error is True
    assert read_missing.output == "파일을 찾을 수 없습니다: missing.txt"
    assert str(tmp_path) not in read_missing.output

    edit_result = await FileEditTool().execute(
        FileEditToolInput(path=str(outside), old_str="alpha", new_str="beta"),
        context,
    )
    assert edit_result.is_error is False
    assert edit_result.output == "notes.txt을(를) 업데이트했습니다. 치환 1건"
    assert str(tmp_path) not in edit_result.output


@pytest.mark.asyncio
async def test_file_edit_applies_multiple_replacements_in_one_call(tmp_path: Path):
    context = ToolExecutionContext(cwd=tmp_path)
    target = tmp_path / "notes.txt"
    target.write_text("one\ntwo\nthree\ntwo\n", encoding="utf-8")

    edit_result = await FileEditTool().execute(
        FileEditToolInput(
            path="notes.txt",
            edits=[
                {"old_str": "one", "new_str": "ONE"},
                {"old_str": "two", "new_str": "TWO", "replace_all": True},
                {"old_str": "three", "new_str": "THREE"},
            ],
        ),
        context,
    )

    assert edit_result.is_error is False
    assert target.read_text(encoding="utf-8") == "ONE\nTWO\nTHREE\nTWO\n"


@pytest.mark.asyncio
async def test_file_edit_multi_replacement_does_not_partially_write_on_missing_text(tmp_path: Path):
    context = ToolExecutionContext(cwd=tmp_path)
    target = tmp_path / "notes.txt"
    original = "one\ntwo\nthree\n"
    target.write_text(original, encoding="utf-8")

    edit_result = await FileEditTool().execute(
        FileEditToolInput(
            path="notes.txt",
            edits=[
                {"old_str": "one", "new_str": "ONE"},
                {"old_str": "missing", "new_str": "MISSING"},
            ],
        ),
        context,
    )

    assert edit_result.is_error is True
    assert "2번째 편집" in edit_result.output
    assert target.read_text(encoding="utf-8") == original


@pytest.mark.asyncio
async def test_glob_and_grep(tmp_path: Path):
    context = ToolExecutionContext(cwd=tmp_path)
    (tmp_path / "a.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("def beta():\n    return 2\n", encoding="utf-8")

    glob_result = await GlobTool().execute(GlobToolInput(pattern="*.py"), context)
    assert glob_result.output.splitlines() == ["a.py", "b.py"]

    grep_result = await GrepTool().execute(
        GrepToolInput(pattern=r"def\s+beta", file_glob="*.py"),
        context,
    )
    assert "b.py:1:def beta():" in grep_result.output

    file_root_result = await GrepTool().execute(
        GrepToolInput(pattern=r"def\s+alpha", root="a.py"),
        context,
    )
    assert "a.py:1:def alpha():" in file_root_result.output


@pytest.mark.asyncio
async def test_bash_tool_runs_command(tmp_path: Path):
    result = await BashTool().execute(
        BashToolInput(command=_python_stdout_command("hello")),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert result.is_error is False
    assert result.output == "hello"


@pytest.mark.asyncio
async def test_tool_search_and_brief_tools(tmp_path: Path):
    registry = create_default_tool_registry()
    context = ToolExecutionContext(cwd=tmp_path, metadata={"tool_registry": registry})

    search_result = await ToolSearchTool().execute(
        ToolSearchToolInput(query="file"),
        context,
    )
    assert "read_file" in search_result.output

    brief_result = await BriefTool().execute(
        BriefToolInput(text="abcdefghijklmnopqrstuvwxyz", max_chars=20),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert brief_result.output == "abcdefghijklmnopqrst..."


@pytest.mark.asyncio
async def test_conversation_history_search_returns_archived_user_inputs(tmp_path: Path):
    shared_metadata = {
        "user_input_archive": [
            {
                "id": "user-0001-alpha",
                "turn_index": 1,
                "timestamp": 123,
                "text": "경쟁사 보고서에는 POSCO와 현대제철 비교를 반드시 포함해줘.",
                "short_hint": "경쟁사 보고서에는 POSCO와 현대제철 비교를 반드시 포함해줘.",
            },
            {
                "id": "user-0003-beta",
                "turn_index": 3,
                "timestamp": 456,
                "text": "UI는 툴팁 없이 compact하게 보여줘.",
                "short_hint": "UI는 툴팁 없이 compact하게 보여줘.",
            },
        ]
    }
    context = ToolExecutionContext(cwd=tmp_path, metadata={"_shared_tool_metadata": shared_metadata})

    search_result = await ConversationHistorySearchTool().execute(
        ConversationHistorySearchInput(query="현대제철"),
        context,
    )
    spaced_result = await ConversationHistorySearchTool().execute(
        ConversationHistorySearchInput(query="경쟁사보고서"),
        context,
    )
    case_result = await ConversationHistorySearchTool().execute(
        ConversationHistorySearchInput(query="posco"),
        context,
    )
    exact_result = await ConversationHistorySearchTool().execute(
        ConversationHistorySearchInput(id="user-0003-beta"),
        context,
    )

    assert "user-0001-alpha" in search_result.output
    assert "현대제철" in search_result.output
    assert "user-0001-alpha" in spaced_result.output
    assert "user-0001-alpha" in case_result.output
    assert "UI는 툴팁 없이 compact하게 보여줘." in exact_result.output
    assert ConversationHistorySearchTool().is_read_only(ConversationHistorySearchInput(query="x")) is True


@pytest.mark.asyncio
async def test_session_document_search_and_read_tools_return_matching_ranges(tmp_path: Path):
    document_path = tmp_path / ".myharness" / "sessions" / "session-documents" / "abc123def456" / "doc-abcdef123456.txt"
    document_path.parent.mkdir(parents=True)
    lines = [
        "총무팀은 복무, 보안, 의전 업무를 담당합니다.",
        "인사팀은 채용과 평가 제도를 운영합니다.",
        "조직개편안은 총무팀 보안 기능을 안전관리실로 이관합니다.",
        "재무팀은 예산 편성과 결산을 담당합니다.",
    ]
    document_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    shared_metadata = {
        "session_documents": [
            {
                "id": "doc-abcdef123456",
                "session_id": "abc123def456",
                "path": str(document_path),
                "line_count": len(lines),
                "char_count": len(document_path.read_text(encoding="utf-8")),
                "estimated_tokens": 100,
                "created_at": 123,
                "short_hint": "조직업무분장 자료",
            }
        ]
    }
    context = ToolExecutionContext(cwd=tmp_path, metadata={"_shared_tool_metadata": shared_metadata})

    search_result = await SessionDocumentSearchTool().execute(
        SessionDocumentSearchToolInput(document_id="doc-abcdef123456", query="보안 기능 이관"),
        context,
    )
    read_result = await SessionDocumentReadTool().execute(
        SessionDocumentReadToolInput(document_id="doc-abcdef123456", start_line=2, limit=2),
        context,
    )

    assert search_result.is_error is False
    assert "doc-abcdef123456" in search_result.output
    assert "lines 1-4" in search_result.output
    assert "보안 기능" in search_result.output
    assert read_result.is_error is False
    assert "     2\t인사팀은 채용과 평가 제도를 운영합니다." in read_result.output
    assert "     3\t조직개편안은 총무팀 보안 기능을 안전관리실로 이관합니다." in read_result.output
    assert SessionDocumentSearchTool().is_read_only(SessionDocumentSearchToolInput(document_id="doc-abcdef123456", query="x")) is True
    assert "recoverable source document" in SessionDocumentSearchTool.description
    assert "recoverable source document" in SessionDocumentReadTool.description


@pytest.mark.asyncio
async def test_session_document_search_uses_chunk_index_for_stored_documents(tmp_path: Path):
    overview = "\n".join(
        f"overview filler line {index:03d}: unrelated governance background"
        for index in range(180)
    )
    payment = "\n".join(
        [
            "## Payment Gateway Outage",
            "Incident marker PG-5523 shows the retry storm began after the cache warmer failed.",
            "The decisive evidence is the payment-gateway retry counter and the webhook timeout.",
        ]
    )
    appendix = "\n".join(
        f"appendix filler line {index:03d}: unrelated glossary"
        for index in range(180)
    )
    metadata: dict[str, object] = {"session_id": "abc123def456"}
    entry = store_session_document(
        cwd=tmp_path,
        session_id="abc123def456",
        text=f"# Overview\n{overview}\n{payment}\n## Appendix\n{appendix}",
        metadata=metadata,
        source_kind="tool_output",
        source_label="web_fetch: https://example.test/payment",
        tool_name="web_fetch",
        tool_use_id="toolu_fetch",
        original_estimated_tokens=12000,
    )
    context = ToolExecutionContext(cwd=tmp_path, metadata={"_shared_tool_metadata": metadata})

    search_result = await SessionDocumentSearchTool().execute(
        SessionDocumentSearchToolInput(document_id=str(entry["id"]), query="PG-5523 retry storm"),
        context,
    )

    assert search_result.is_error is False
    assert entry["chunk_count"] > 1
    assert Path(str(entry["index_path"])).is_file()
    assert f"{entry['id']} chunk " in search_result.output
    assert 'heading "Payment Gateway Outage"' in search_result.output
    assert "PG-5523" in search_result.output
    assert "overview filler line 000" not in search_result.output


@pytest.mark.asyncio
async def test_skill_todo_and_config_tools(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    skills_dir = tmp_path / "config" / "skills"
    skills_dir.mkdir(parents=True)
    pytest_dir = skills_dir / "pytest"
    pytest_dir.mkdir()
    (pytest_dir / "SKILL.md").write_text("# Pytest\nHelpful pytest notes.\n", encoding="utf-8")

    skill_result = await SkillTool().execute(
        SkillToolInput(name="Pytest"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert skill_result.output.startswith("스킬: Pytest\n설명: Helpful pytest notes.")
    assert "Skill file:" not in skill_result.output
    assert "Skill directory:" not in skill_result.output
    assert "Helpful pytest notes." in skill_result.output

    source_result = await SkillTool().execute(
        SkillToolInput(name="Pytest", mode="source"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert source_result.is_error is False
    assert "Displayed the full source for skill 'Pytest'" in source_result.output
    assert "Helpful pytest notes." not in source_result.output
    assert source_result.metadata["model_output"] == source_result.output
    assert "Helpful pytest notes." in source_result.metadata["transcript_output"]

    todo_result = await TodoWriteTool().execute(
        TodoWriteToolInput(item="wire commands"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert todo_result.is_error is False
    assert "wire commands" in (tmp_path / "TODO.md").read_text(encoding="utf-8")

    config_result = await ConfigTool().execute(
        ConfigToolInput(action="set", key="theme", value="solarized"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert config_result.output == "설정을 업데이트했습니다: theme"


@pytest.mark.asyncio
async def test_skill_tool_persists_global_usage_counts(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    skills_dir = tmp_path / "config" / "skills"
    skills_dir.mkdir(parents=True)
    pytest_dir = skills_dir / "pytest"
    pytest_dir.mkdir()
    (pytest_dir / "SKILL.md").write_text("# Pytest\nHelpful pytest notes.\n", encoding="utf-8")

    context = ToolExecutionContext(cwd=tmp_path)
    first = await SkillTool().execute(SkillToolInput(name="Pytest"), context)
    second = await SkillTool().execute(SkillToolInput(name="pytest"), context)
    source = await SkillTool().execute(SkillToolInput(name="Pytest", mode="source"), context)

    assert first.is_error is False
    assert second.is_error is False
    assert source.is_error is False
    assert get_skill_usage_count("Pytest") == 2
    assert get_skill_usage_counts() == {"pytest": 2}


@pytest.mark.asyncio
async def test_plan_mode_tools_restore_previous_full_auto_mode(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))

    enter_result = await EnterPlanModeTool().execute(
        EnterPlanModeToolInput(),
        ToolExecutionContext(cwd=tmp_path, metadata={"permission_mode": "full_auto"}),
    )

    assert enter_result.metadata["permission_mode"] == "plan"
    assert enter_result.metadata["plan_previous_permission_mode"] == "full_auto"
    assert load_settings().permission.mode == "plan"
    assert load_settings().permission.plan_previous_mode == "full_auto"

    exit_result = await ExitPlanModeTool().execute(
        ExitPlanModeToolInput(),
        ToolExecutionContext(cwd=tmp_path, metadata=enter_result.metadata),
    )

    assert exit_result.metadata["permission_mode"] == "full_auto"
    assert load_settings().permission.mode == "full_auto"
    assert load_settings().permission.plan_previous_mode is None


@pytest.mark.asyncio
async def test_todo_write_upsert(tmp_path: Path):
    tool = TodoWriteTool()
    ctx = ToolExecutionContext(cwd=tmp_path)

    await tool.execute(TodoWriteToolInput(item="task A"), ctx)
    await tool.execute(TodoWriteToolInput(item="task B"), ctx)

    # Marking done should update in-place, not append a duplicate
    result = await tool.execute(TodoWriteToolInput(item="task A", checked=True), ctx)
    assert result.is_error is False

    content = (tmp_path / "TODO.md").read_text(encoding="utf-8")
    assert content.count("task A") == 1
    assert "- [x] task A" in content
    assert "- [ ] task A" not in content
    assert "- [ ] task B" in content

    # Calling again with same state is a no-op
    noop = await tool.execute(TodoWriteToolInput(item="task A", checked=True), ctx)
    assert "No change" in noop.output
    assert (tmp_path / "TODO.md").read_text(encoding="utf-8").count("task A") == 1


@pytest.mark.asyncio
async def test_todo_write_batch_can_be_session_only(tmp_path: Path):
    result = await TodoWriteTool().execute(
        TodoWriteToolInput(
            persist=False,
            todos=[
                {"text": "inspect files", "checked": True},
                {"text": "patch code", "checked": False},
            ],
        ),
        ToolExecutionContext(cwd=tmp_path),
    )

    assert result.output == "- [x] inspect files\n- [ ] patch code"
    assert not (tmp_path / "TODO.md").exists()


@pytest.mark.asyncio
async def test_todo_write_batch_defaults_to_session_only(tmp_path: Path):
    args = TodoWriteToolInput(
        todos=[
            {"text": "inspect files", "checked": True},
            {"text": "patch code", "checked": False},
        ],
    )
    result = await TodoWriteTool().execute(args, ToolExecutionContext(cwd=tmp_path))

    assert args.persist is False
    assert TodoWriteTool().is_read_only(args) is True
    assert result.output == "- [x] inspect files\n- [ ] patch code"
    assert not (tmp_path / "TODO.md").exists()


@pytest.mark.asyncio
async def test_todo_write_empty_input_is_noop(tmp_path: Path):
    tool = TodoWriteTool()
    context = ToolExecutionContext(cwd=tmp_path)

    empty = await tool.execute(TodoWriteToolInput(), context)
    blank_item = await tool.execute(TodoWriteToolInput(item="   "), context)
    blank_batch = await tool.execute(
        TodoWriteToolInput(todos=[{"text": "   ", "checked": False}]),
        context,
    )

    assert empty.is_error is False
    assert blank_item.is_error is False
    assert blank_batch.is_error is False
    assert empty.output == ""
    assert blank_item.output == ""
    assert blank_batch.output == ""
    assert not (tmp_path / "TODO.md").exists()


def test_todo_write_read_only_classification_matches_persistence():
    tool = TodoWriteTool()

    assert tool.is_read_only(TodoWriteToolInput()) is True
    assert tool.is_read_only(TodoWriteToolInput(item="   ")) is True
    assert tool.is_read_only(TodoWriteToolInput(item="persist me")) is False
    assert tool.is_read_only(TodoWriteToolInput(item="preview only", persist=False)) is True
    assert tool.is_read_only(TodoWriteToolInput(todos=[{"text": "progress", "checked": False}])) is True
    assert tool.is_read_only(TodoWriteToolInput(todos=[{"text": "persist", "checked": False}], persist=True)) is False


def test_todo_write_schema_guides_incremental_progress_updates():
    schema = TodoWriteTool.input_model.model_json_schema()
    assert "immediately after each step completes" in TodoWriteTool.description
    assert "full current checklist" in schema["properties"]["todos"]["description"]
    assert "actually completed since the prior update" in schema["properties"]["todos"]["description"]


def test_ask_user_question_schema_discourages_unnecessary_follow_ups():
    schema = AskUserQuestionTool.input_model.model_json_schema()

    assert "Use this only when the missing information" in AskUserQuestionTool.description
    assert "state the assumption and proceed" in AskUserQuestionTool.description
    assert "batch the choices into one prompt" in AskUserQuestionTool.description
    assert "avoid approval-only questions" in AskUserQuestionTool.description
    assert "After the user answers, continue the original task" in AskUserQuestionTool.description
    assert "without restating the plan" in AskUserQuestionTool.description
    assert "Do not ask another clarification immediately after the user answers" in AskUserQuestionTool.description
    assert "label each item as (1/N)" in AskUserQuestionTool.description
    assert "Batch all necessary clarification" in schema["properties"]["question"]["description"]
    assert "(1/N)" in schema["properties"]["question"]["description"]


@pytest.mark.asyncio
async def test_notebook_edit_tool(tmp_path: Path):
    result = await NotebookEditTool().execute(
        NotebookEditToolInput(path="demo.ipynb", cell_index=0, new_source="print('nb ok')\n"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert result.is_error is False
    assert "demo.ipynb" in result.output
    assert "nb ok" in (tmp_path / "demo.ipynb").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_lsp_tool(tmp_path: Path):
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "utils.py").write_text(
        'def greet(name):\n    """Return a greeting."""\n    return f"hi {name}"\n',
        encoding="utf-8",
    )
    (tmp_path / "pkg" / "app.py").write_text(
        "from pkg.utils import greet\n\nprint(greet('world'))\n",
        encoding="utf-8",
    )
    context = ToolExecutionContext(cwd=tmp_path)

    document_symbols = await LspTool().execute(
        LspToolInput(operation="document_symbol", file_path="pkg/utils.py"),
        context,
    )
    assert "function greet" in document_symbols.output

    definition = await LspTool().execute(
        LspToolInput(operation="go_to_definition", file_path="pkg/app.py", symbol="greet"),
        context,
    )
    assert "pkg/utils.py:1:1" in definition.output.replace("\\", "/")

    references = await LspTool().execute(
        LspToolInput(operation="find_references", file_path="pkg/app.py", symbol="greet"),
        context,
    )
    assert "pkg/app.py:1:from pkg.utils import greet" in references.output.replace("\\", "/")

    hover = await LspTool().execute(
        LspToolInput(operation="hover", file_path="pkg/app.py", symbol="greet"),
        context,
    )
    assert "Return a greeting." in hover.output


@pytest.mark.asyncio
async def test_worktree_tools(tmp_path: Path):
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "config", "user.email", "myharness@example.com"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "MyHarness Tests"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )
    (tmp_path / "demo.txt").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    )

    enter_result = await EnterWorktreeTool().execute(
        EnterWorktreeToolInput(branch="feature/demo"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert enter_result.is_error is False
    worktree_path = Path(enter_result.output.split("Path: ", 1)[1].strip())
    assert worktree_path.exists()

    exit_result = await ExitWorktreeTool().execute(
        ExitWorktreeToolInput(path=str(worktree_path)),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert exit_result.is_error is False
    assert not worktree_path.exists()


@pytest.mark.asyncio
async def test_cron_and_remote_trigger_tools(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    context = ToolExecutionContext(cwd=tmp_path)

    create_result = await CronCreateTool().execute(
        CronCreateToolInput(
            name="nightly",
            schedule="0 0 * * *",
            command=_python_stdout_command("CRON_OK"),
        ),
        context,
    )
    assert create_result.is_error is False

    list_result = await CronListTool().execute(CronListToolInput(), context)
    assert "nightly" in list_result.output

    trigger_result = await RemoteTriggerTool().execute(
        RemoteTriggerToolInput(name="nightly"),
        context,
    )
    assert trigger_result.is_error is False
    assert "CRON_OK" in trigger_result.output

    delete_result = await CronDeleteTool().execute(
        CronDeleteToolInput(name="nightly"),
        context,
    )
    assert delete_result.is_error is False

"""Tests for project instruction loading."""

from __future__ import annotations

from pathlib import Path

from myharness.config.paths import (
    get_project_active_repo_context_path,
    get_project_issue_file,
    get_project_pr_comments_file,
)
from myharness.coordinator.agent_definitions import AgentDefinition
from myharness.engine.messages import ConversationMessage, TextBlock
from myharness.personalization import rules as personalization_rules
from myharness.personalization.session_hook import update_rules_from_session
from myharness.prompts import (
    build_runtime_system_prompt,
    discover_claude_md_files,
    discover_project_instruction_files,
    load_claude_md_prompt,
    load_project_instructions_prompt,
)
from myharness.config.settings import Settings
from myharness.subagents import SUBAGENT_INVOCATION_DISABLED_MESSAGE


def test_discover_claude_md_files(tmp_path: Path):
    repo = tmp_path / "repo"
    nested = repo / "pkg" / "mod"
    nested.mkdir(parents=True)
    (repo / "CLAUDE.md").write_text("root instructions", encoding="utf-8")
    rules_dir = repo / ".claude" / "rules"
    rules_dir.mkdir(parents=True)
    (rules_dir / "python.md").write_text("rule instructions", encoding="utf-8")

    files = discover_claude_md_files(nested)

    assert repo / "CLAUDE.md" in files
    assert rules_dir / "python.md" in files


def test_discover_project_instruction_files_includes_agents_md(tmp_path: Path):
    repo = tmp_path / "repo"
    nested = repo / "pkg" / "mod"
    nested.mkdir(parents=True)
    (repo / "AGENTS.md").write_text("myharness instructions", encoding="utf-8")
    (repo / "MYHARNESS.md").write_text("project instructions", encoding="utf-8")
    (repo / "CLAUDE.md").write_text("legacy instructions", encoding="utf-8")

    files = discover_project_instruction_files(nested)

    assert repo / "AGENTS.md" in files
    assert repo / "MYHARNESS.md" in files
    assert repo / "CLAUDE.md" in files


def test_load_claude_md_prompt(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "CLAUDE.md").write_text("be careful", encoding="utf-8")

    prompt = load_claude_md_prompt(repo)

    assert prompt is not None
    assert "Project Instructions" in prompt
    assert "be careful" in prompt


def test_load_project_instructions_prompt_prefers_general_project_files(tmp_path: Path):
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "AGENTS.md").write_text("plan before larger edits", encoding="utf-8")

    prompt = load_project_instructions_prompt(repo)

    assert prompt is not None
    assert "Project Instructions" in prompt
    assert "AGENTS.md" in prompt
    assert "plan before larger edits" in prompt


def test_build_runtime_system_prompt_combines_sections(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "AGENTS.md").write_text("repo rules", encoding="utf-8")

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="hello")

    assert "Environment" in prompt
    assert "Project Instructions" in prompt
    assert "repo rules" in prompt
    assert "Memory" in prompt


def test_build_runtime_system_prompt_guides_item_level_source_links(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="포스코 기사 동향 조사해줘")

    assert "cite source-backed claims with compact source chips" in prompt
    assert "`[출처: 데일리안](https://...)`" in prompt
    assert "Do not cite every sentence or every line" in prompt
    assert "Prefer one chip per paragraph, bullet, or source change" in prompt
    assert "Use the provided source_chip when a tool result includes one" in prompt
    assert "Do not add web evidence snippets to Markdown link titles" in prompt
    assert "the UI derives hover excerpts from existing web_search/web_fetch tool outputs to save tokens" in prompt
    assert "Do not replace item-level links with" in prompt
    assert "do not group several unrelated article sources into one trailing note" in prompt
    assert "For standalone HTML artifacts, mark source-backed facts with compact clickable numbered source badges" in prompt
    assert "<sup class=\"source-ref\"><a href=\"https://...\"" in prompt
    assert "<!-- myharness:source-footnotes-css -->" in prompt
    assert "write_file` fills `data-tooltip` from prior `web_search`/`web_fetch` evidence" in prompt
    assert "source address first and a short verbatim excerpt" in prompt
    assert "excerpt line wrapped in double quotes" in prompt


def test_build_runtime_system_prompt_guides_artifact_filenames(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="make a tetris html")

    assert "Prefer concise Korean filenames with underscores between words for Korean-facing HTML, Markdown, PDF, DOCX, XLSX, and PPTX artifacts" in prompt
    assert "English snake/kebab-style filenames for code, scripts, configs, and data" in prompt
    assert "Avoid `index.html` for newly created artifacts whenever possible" in prompt
    assert "Use `index.html` only when the user explicitly asks" in prompt
    assert "Do not reuse a generic file such as `index.html`" in prompt
    assert "For unrelated standalone HTML previews or demos" in prompt
    assert "place it under `outputs/`" in prompt
    assert "keep files that reference each other in the same subfolder" in prompt


def test_build_runtime_system_prompt_includes_project_context_and_fast_mode(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    repo = tmp_path / "repo"
    repo.mkdir()
    get_project_issue_file(repo).write_text("# Bug\nNeed to fix flaky test.\n", encoding="utf-8")
    get_project_pr_comments_file(repo).write_text(
        "# PR Comments\n- app.py:12: Please simplify this branch.\n",
        encoding="utf-8",
    )

    prompt = build_runtime_system_prompt(Settings(fast_mode=True), cwd=repo, latest_user_prompt="fix it")

    assert "Fast mode is enabled" in prompt
    assert "Issue Context" in prompt
    assert "Need to fix flaky test" in prompt
    assert "Pull Request Comments" in prompt
    assert "Please simplify this branch" in prompt


def test_build_runtime_system_prompt_includes_active_repo_context(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    repo = tmp_path / "repo"
    repo.mkdir()
    get_project_active_repo_context_path(repo).write_text(
        "# Active Repo Context\n\n- Current focus: fix issue #98\n",
        encoding="utf-8",
    )

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="keep going")

    assert "Active Repo Context" in prompt
    assert "fix issue #98" in prompt


def test_build_runtime_system_prompt_continuation_keeps_stable_prefix_and_skips_volatile_context(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    get_project_active_repo_context_path(repo).write_text(
        "# Active Repo Context\n\n- Volatile focus: fix issue #98\n",
        encoding="utf-8",
    )

    first = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="fix issue #98")
    second = build_runtime_system_prompt(
        Settings(),
        cwd=repo,
        latest_user_prompt="continue",
        prompt_profile="continuation",
    )
    marker = "# Session Continuation"

    assert first.startswith(second.split(marker, 1)[0].rstrip())
    assert "Active Repo Context" in first
    assert "Volatile focus" in first
    assert "Session Continuation" in second
    assert "Active Repo Context" not in second
    assert "Volatile focus" not in second


def test_build_runtime_system_prompt_uses_coordinator_prompt_when_enabled(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CLAUDE_CODE_COORDINATOR_MODE", "1")
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="investigate")

    assert "Subagents Disabled" in prompt
    assert SUBAGENT_INVOCATION_DISABLED_MESSAGE in prompt
    assert "Coordinator User Context" not in prompt
    assert "Workers spawned via the agent tool have access to these tools" not in prompt


def test_build_runtime_system_prompt_skips_coordinator_context_when_disabled(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="investigate")

    assert "Coordinator User Context" not in prompt
    assert "You are a **coordinator**." not in prompt
    assert "Subagents Disabled" in prompt
    assert SUBAGENT_INVOCATION_DISABLED_MESSAGE in prompt
    assert "Do not call `agent`, `send_message`, or create `local_agent` tasks" in prompt
    assert "Delegation And Subagents" not in prompt
    assert 'subagent_type="worker"' not in prompt
    assert "Environment" in prompt


def test_build_runtime_system_prompt_lists_subagent_presets_without_bodies(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    monkeypatch.setattr(
        "myharness.prompts.context.get_all_agent_definitions",
        lambda: [
            AgentDefinition(name="worker", description="generic worker", subagent_type="worker"),
            AgentDefinition(
                name="sample-office-presets:cost-analyst",
                description="Use for cost and margin analysis.",
                subagent_type="cost-analyst",
                source="plugin",
                system_prompt="You are a cost analysis worker. This body must stay lazy.",
            ),
        ],
    )
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="원가 분석해줘")

    assert "Subagents Disabled" in prompt
    assert "Available Subagent Presets" not in prompt
    assert "`cost-analyst`" not in prompt
    assert 'subagent_type="<route>"' not in prompt
    assert "You are a cost analysis worker" not in prompt
    assert "generic worker" not in prompt


def test_build_runtime_system_prompt_passes_settings_and_cwd_to_subagent_presets(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    seen: dict[str, object] = {}

    def _fake_agents(*, settings, cwd):
        seen["settings"] = settings
        seen["cwd"] = cwd
        return [
            AgentDefinition(
                name="sample-office-presets:cost-analyst",
                description="Use for cost and margin analysis.",
                subagent_type="cost-analyst",
                source="plugin",
            )
        ]

    monkeypatch.setattr("myharness.prompts.context.get_all_agent_definitions", _fake_agents)

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="원가 분석해줘")

    assert "`cost-analyst`" not in prompt
    assert seen == {}


def test_build_runtime_system_prompt_guides_explicit_extra_long_report_generation(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="40,000 토큰 HTML 보고서 작성")

    assert "Report Generation" in prompt
    assert "about 24k, 32k, or 40k output tokens" in prompt
    assert "roughly 80-105% of the requested tokens" in prompt
    assert "do not stop at an ordinary 10k-13k report" in prompt
    assert "Use the selected model's direct output budget" in prompt
    assert "The `write_long_report` section-merge flow is temporarily disabled" in prompt
    assert "Do not call it for extra-long report requests" in prompt
    assert "Keep concise source notes in context" in prompt
    assert "final direct artifact can cite important external claims reliably" in prompt
    assert "server/resource/document/table/query identifiers" in prompt
    assert "Do not generate more than 20,000 tokens" not in prompt


def test_build_runtime_system_prompt_keeps_report_limits_from_overriding_html_artifacts(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(
        Settings(),
        cwd=repo,
        latest_user_prompt="아래 사이트 내용을 이해하기 쉬운 보고서로 자세히 작성해줘",
    )

    assert "Ordinary report requests may still require standalone files" in prompt
    assert "장문보고서, 긴 보고서, 대보고서" in prompt
    assert "create a standalone HTML report under `outputs/`" in prompt
    assert "load and follow the `visual-artifact` skill" in prompt
    assert "charts for trends/comparisons/proportions" in prompt
    assert "workflow/timeline diagrams when process or causal flow matters" in prompt
    assert "Do not expose production metadata" in prompt
    assert "not a plain article wrapped in HTML" in prompt
    assert "aim for roughly 10,000 substantive body tokens by default" in prompt
    assert "use `todo_write` and concrete `<myharness-progress>` markers" in prompt
    assert "Do not stay silent through the analysis phase" in prompt
    assert "should be answered directly" not in prompt


def test_task_worker_prompt_skips_delegation_and_parent_task_queries(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CLAUDE_CODE_COORDINATOR_MODE", "1")
    repo = tmp_path / "repo"
    repo.mkdir()

    prompt = build_runtime_system_prompt(
        Settings(),
        cwd=repo,
        latest_user_prompt="You are a background teammate. Your task id is a123. 조사해줘.",
        task_worker=True,
    )

    assert "Background Worker Mode" in prompt
    assert "Delegation And Subagents" not in prompt
    assert "You are a **coordinator**." not in prompt
    assert "Do not use task_get, task_list, or task_output" in prompt
    assert "Use task_update only" in prompt
    assert "compact JSON progress" in prompt
    assert "generic still-working heartbeats" in prompt
    assert "chart, table, timeline, or comparison candidates" in prompt
    assert "include enough source identifiers for the parent to cite important claims" in prompt
    assert "MCP server/resource names, document ids, table names, or query labels" in prompt
    assert "Do not return raw unstyled HTML" in prompt


def test_build_runtime_system_prompt_does_not_reinject_exported_secret_values(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLAUDE_CODE_COORDINATOR_MODE", raising=False)
    repo = tmp_path / "repo"
    repo.mkdir()
    rules_dir = tmp_path / "local_rules"
    monkeypatch.setattr(personalization_rules, "_RULES_DIR", rules_dir)
    monkeypatch.setattr(personalization_rules, "_RULES_FILE", rules_dir / "rules.md")
    monkeypatch.setattr(personalization_rules, "_FACTS_FILE", rules_dir / "facts.json")

    secret = "sk-test-secret"
    update_rules_from_session(
        [
            ConversationMessage(
                role="user",
                content=[TextBlock(text=f"export OPENAI_API_KEY={secret}")],
            )
        ]
    )

    prompt = build_runtime_system_prompt(Settings(), cwd=repo, latest_user_prompt="hello")

    assert "OPENAI_API_KEY" in prompt
    assert secret not in prompt

"""Tests for myharness.prompts.system_prompt."""

from __future__ import annotations

from pathlib import Path

from myharness.prompts.environment import EnvironmentInfo
from myharness.prompts.system_prompt import build_system_prompt


def _make_env(**overrides) -> EnvironmentInfo:
    defaults = dict(
        os_name="Linux",
        os_version="5.15.0",
        platform_machine="x86_64",
        shell="bash",
        cwd="/home/user/project",
        home_dir="/home/user",
        date="2026-04-01",
        python_version="3.10.17",
        python_executable="/home/user/.myharness-venv/bin/python",
        virtual_env="/home/user/.myharness-venv",
        is_git_repo=True,
        git_branch="main",
        hostname="testhost",
    )
    defaults.update(overrides)
    return EnvironmentInfo(**defaults)


def test_build_system_prompt_contains_environment():
    env = _make_env()
    prompt = build_system_prompt(env=env)
    assert "Linux 5.15.0" in prompt
    assert "x86_64" in prompt
    assert "bash" in prompt
    assert "/home/user/project" in prompt
    assert "2026-04-01" in prompt
    assert "3.10.17" in prompt
    assert "/home/user/.myharness-venv/bin/python" in prompt
    assert "Virtual environment: /home/user/.myharness-venv" in prompt
    assert "branch: main" in prompt


def test_build_system_prompt_no_git():
    env = _make_env(is_git_repo=False, git_branch=None)
    prompt = build_system_prompt(env=env)
    assert "Git:" not in prompt


def test_build_system_prompt_git_no_branch():
    env = _make_env(is_git_repo=True, git_branch=None)
    prompt = build_system_prompt(env=env)
    assert "Git: yes" in prompt
    assert "branch:" not in prompt


def test_build_system_prompt_custom_prompt():
    env = _make_env()
    prompt = build_system_prompt(custom_prompt="You are a helpful bot.", env=env)
    assert prompt.startswith("You are a helpful bot.")
    assert "Linux 5.15.0" in prompt
    # Base prompt should not appear
    assert "MyHarness" not in prompt


def test_build_system_prompt_default_includes_base():
    env = _make_env()
    prompt = build_system_prompt(env=env)
    assert "You are MyHarness" in prompt
    assert "You are OpenHarness" not in prompt
    assert "MyHarness" in prompt


def test_build_system_prompt_encourages_parallel_research_tools():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "Parallelism is for speed, not for increasing the amount of work" in prompt
    assert "start with a small, high-signal batch" in prompt
    assert "2-3 `web_search` calls" in prompt
    assert "1-2 `web_fetch` calls" in prompt
    assert "around 5 parallel web calls total" in prompt
    assert "Avoid 6 or more parallel web calls" in prompt
    assert "call those `web_fetch` or `web_search` tools in parallel" in prompt
    assert "Escalate blocked web research by source importance" in prompt
    assert "directly asks for a specific URL, page, or source" in prompt
    assert "when you judge that a blocked or sparse source needs to be fetched" in prompt
    assert "central to the answer" in prompt
    assert "YouTube video explanation, summary, transcript, captions, or content analysis" in prompt
    assert "Do not route these caption/content tasks through `openweb` first" in prompt
    assert 'invoke `skill(name="openweb")` directly' in prompt
    assert 'invoke `skill(name="insane-search")`' in prompt
    assert "before generic `web_search`/`web_fetch`" in prompt
    assert "`web_fetch`/`web_search`/`openweb` attempt" in prompt
    assert "401, 402, 403, 429" in prompt
    assert "direct-request/source-importance test" in prompt
    assert "casual lead, duplicate source, low-value search result" in prompt
    assert "Do not use `insane-search` for simple web searches" in prompt


def test_build_system_prompt_requires_external_source_attribution():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "important user-facing information comes from an external source" in prompt
    assert "cite that source in the answer or artifact" in prompt
    assert "web search/fetch results, MCP tools or resources, vector databases" in prompt
    assert "database query results" in prompt
    assert "MCP/vector DB server, resource, document id, table, or query identifier" in prompt
    assert "cite each source-backed fact item on the same line as the claim" in prompt
    assert "`[출처: 데일리안](https://...)`" in prompt
    assert "Do not add evidence snippets to Markdown link titles" in prompt
    assert "the UI derives hover excerpts from existing web_search/web_fetch tool outputs to save tokens" in prompt
    assert "Do not replace item-level links with a separate final `참고:` or `출처:` line" in prompt
    assert "do not group several unrelated article sources into one trailing note" in prompt
    assert "compact numbered source badges next to the sourced fact" in prompt
    assert "<sup class=\"source-ref\"><a href=\"https://example.com\"" in prompt
    assert "<!-- myharness:source-footnotes-css -->" in prompt
    assert "the `write_file` tool expands that marker into the fixed CSS" in prompt
    assert "fills `data-tooltip` from prior `web_search`/`web_fetch` evidence" in prompt
    assert "Do not spend output tokens writing excerpt text into `data-tooltip`" in prompt
    assert "small rounded square badge containing only the source number" in prompt
    assert "source address on the first line and a short verbatim excerpt" in prompt
    assert "verbatim excerpt line is wrapped in double quotes" in prompt
    assert "instead of inventing one" in prompt
    assert "Skip citations for trivial operational details" in prompt


def test_build_system_prompt_plans_substantial_tasks_first():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "For substantial tasks, share progress as a short markdown checklist" in prompt
    assert "standalone report generation that requires research, analysis" in prompt
    assert "`todo_write` with a full `todos` list and `persist=false`" in prompt
    assert "immediately after each checklist item is actually completed" in prompt
    assert "Do not wait until the end to mark multiple items done at once" in prompt
    assert "surface progress during evidence review, outline planning, data/statistical analysis" in prompt
    assert "the file-writing tool preview is not a substitute for analysis-stage progress" in prompt
    assert '<myharness-progress>{"message":"specific user-facing progress note"}</myharness-progress>' in prompt
    assert "fit in about two compact UI lines" in prompt
    assert "Do not use generic filler" in prompt
    assert "Do not emit a progress marker or ordinary assistant text immediately before a file-writing or file-editing tool call" in prompt
    assert "stream the tool arguments into the workflow output preview" in prompt
    assert "3+ files" in prompt
    assert "broad refactors" in prompt
    assert "Do not add a checklist or progress marker for tiny, obvious, or purely informational tasks" in prompt


def test_build_system_prompt_discourages_repeated_clarification_rounds():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "Clarifying-question budget" in prompt
    assert "state your assumption and proceed" in prompt
    assert "use the `ask_user_question` tool" in prompt
    assert "explicit question event instead of inferring from assistant text" in prompt
    assert "structured `choices` JSON array" in prompt
    assert "Batch the necessary choices into one question" in prompt
    assert "at most two clarification rounds" in prompt
    assert 'Do not ask "should I proceed?"' in prompt
    assert "After the user answers a clarification question" in prompt
    assert 'A short numeric reply like "2" counts as choosing' in prompt
    assert "Do not restate the full plan, table of contents, or alternative approaches" in prompt
    assert "unless the answer creates a new concrete blocker or risky action" in prompt
    assert "Do not ask another clarification immediately after the user answers" in prompt
    assert "batch them into one question" in prompt
    assert "(1/N)" in prompt


def test_build_system_prompt_guides_chat_html_rendering_without_visual_report_rules():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "MyHarness can render fenced `html` code blocks directly in the chat" in prompt
    assert "MyHarness can render fenced `mermaid` code blocks in chat and Markdown artifact previews" in prompt
    assert "use Mermaid for flowcharts, sequence diagrams, state diagrams, and other compact process diagrams" in prompt
    assert "quick charts, small data views" in prompt
    assert "Do not force inline HTML for every answer" in prompt
    assert "self-contained, compact, readable in a constrained iframe" in prompt

    assert "default to a standalone HTML web report under `outputs/`" in prompt
    assert "long report, 장문보고서, 긴 보고서, 대보고서" in prompt
    assert "For standalone HTML reports or web reports, use Mermaid when workflow, architecture, sequence, or dependency diagrams" not in prompt
    assert "polished web-native report composition" not in prompt
    assert "prefer ECharts via CDN" not in prompt
    assert "Only when the user explicitly asks for an A4 landscape" not in prompt
    assert "actively consider restrained semantic icons" not in prompt
    assert "business-style HTML reports, dashboards, and charts" not in prompt

def test_build_system_prompt_defaults_report_requests_to_html_artifacts():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "report, long report, 장문보고서, 긴 보고서, 대보고서" in prompt
    assert "pasted site, article, document, transcript, or source text" in prompt
    assert "보고서로 작성해줘" in prompt
    assert "create a standalone HTML report under `outputs/`" in prompt
    assert "load and follow the `visual-artifact` skill" in prompt
    assert "charts for trends/comparisons/proportions" in prompt
    assert "workflow/timeline diagrams when process or causal flow matters" in prompt
    assert "Mark source-backed facts with compact clickable numbered source badges" in prompt
    assert "Do not expose production metadata" in prompt
    assert "instead of a plain article wrapped in HTML" in prompt
    assert "aim for roughly 10,000 substantive body tokens by default" in prompt
    assert "about 24k, 32k, or 40k output tokens" in prompt
    assert "treat that as a target artifact content length rather than a loose upper cap" in prompt
    assert "do not stop at an ordinary 10k-13k report" in prompt
    assert "Use the selected model's direct output budget" in prompt
    assert "The `write_long_report` section-merge flow is temporarily disabled" in prompt
    assert "Do not put the full report body only in the chat" in prompt
    assert "PPT, PowerPoint, Markdown, PDF, DOCX, XLSX, plain text, slides" in prompt
    assert "honor that requested format instead" in prompt


def test_build_system_prompt_guides_interactive_3d_html_artifacts():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "3D model, character, object, or interactive 3D preview" in prompt
    assert "single self-contained `outputs/*.html` artifact" in prompt
    assert "Three.js via CDN is acceptable" in prompt
    assert "procedural geometry, materials, lighting, and camera controls" in prompt
    assert "Default controls: left-click drag rotates/orbits the scene, wheel zooms in or out, right-click drag pans the scene, and double-click resets the view" in prompt
    assert "Do not add middle-click or keyboard controls by default" in prompt
    assert "Avoid plain white or plain black backgrounds" in prompt
    assert "low-contrast gradient or lit backdrop" in prompt


def test_build_system_prompt_guides_high_fidelity_3d_html_artifacts():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "If the user asks for a polished, detailed, high-poly, or production-quality 3D HTML artifact" in prompt
    assert "avoid a vector-icon-like result made from only a few boxes, cylinders, and spheres" in prompt
    assert "rounded/beveled shells, chamfered edges, layered panels, joints, cables, screws, vents, lenses, LEDs" in prompt
    assert "Use higher segment counts and smooth normals for curved parts" in prompt
    assert "PBR-style materials, multiple lights, soft shadows, and subtle animation" in prompt
    assert "If the requested fidelity is closer to a real model than procedural primitives can support" in prompt
    assert ".glb/.gltf asset workflow" in prompt
    assert "Do not present a simple low-poly proxy as high fidelity" in prompt


def test_visual_artifact_rejects_yellowed_report_palettes():
    env = _make_env()
    prompt = build_system_prompt(env=env)
    skill_text = (Path(__file__).resolve().parents[2] / ".skills" / "visual-artifact" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "Avoid yellowed report palettes" not in prompt
    assert "Avoid yellowed report palettes" in skill_text
    assert "aged paper, parchment, sepia" in skill_text
    assert "cream/beige/yellowed document" in skill_text
    assert "appropriate non-yellowed palette" in skill_text
    assert "all-white/all-gray surfaces" in skill_text


def test_visual_artifact_includes_default_report_chart_palette():
    env = _make_env()
    prompt = build_system_prompt(env=env)
    skill_text = (Path(__file__).resolve().parents[2] / ".skills" / "visual-artifact" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "Default report chart palette" not in prompt
    assert "#3288bd`, `#66c2a5`, `#e6f598`, `#d53e4f" in skill_text
    assert "#9e0142`, `#f46d43`, `#fdae61`, `#fee08b`, `#abdda4`, `#5e4fa2" in skill_text
    assert "Use a few colors intentionally" in skill_text


def test_visual_artifact_contains_report_design_rules_and_routes_a4_to_a4_skill():
    env = _make_env()
    prompt = build_system_prompt(env=env)
    skill_text = (Path(__file__).resolve().parents[2] / ".skills" / "visual-artifact" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "do not ask the user to choose a layout, style, or report archetype" not in prompt
    assert "Do not ask the user to choose a layout, style, or report archetype" in skill_text
    assert "polished scrolling web report" in skill_text
    assert "web-native report composition" in skill_text
    assert "ECharts" in skill_text
    assert "Lucide or similar icon sets" in skill_text
    assert "For standalone HTML reports or web reports, use Mermaid" in skill_text
    assert "organization-change diagrams" in skill_text
    assert "same app Mermaid renderer used for chat" in skill_text
    assert "use both this skill and `html-a4-landscape-report`" in skill_text
    assert "let `html-a4-landscape-report` own the page-based layout workflow" in skill_text


def test_visual_artifact_cites_important_external_sources():
    env = _make_env()
    prompt = build_system_prompt(env=env)
    skill_text = (Path(__file__).resolve().parents[2] / ".skills" / "visual-artifact" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "external knowledge such as web research" not in prompt
    assert "external knowledge such as web research" in skill_text
    assert "MCP/vector database results" in skill_text
    assert "source documents, or database queries" in skill_text
    assert "URL/title, document page/path, MCP server/resource, document id, table name, or query label" in skill_text
    assert "Do not invent citations" in skill_text
    assert "HTML Source Footnotes" in skill_text
    assert "`<!-- myharness:source-footnotes-css -->` once in the HTML `<head>`" in skill_text
    assert "write_file` tool expands this marker into the fixed tooltip CSS" in skill_text
    assert "small rounded square badge containing only the number" in skill_text
    assert "Leave `data-tooltip` absent or empty" in skill_text
    assert "`write_file` fills it from stored tool evidence" in skill_text
    assert "short verbatim excerpt directly taken from the source/tool result" in skill_text
    assert "excerpt line is wrapped in double quotes" in skill_text


def test_visual_artifact_flags_empty_report_panels_as_layout_defects():
    env = _make_env()
    prompt = build_system_prompt(env=env)
    skill_text = (Path(__file__).resolve().parents[2] / ".skills" / "visual-artifact" / "SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "large unused white space inside report panels" not in prompt
    assert "Treat large unused white space inside report panels as a layout defect" in skill_text
    assert "Do not leave a mostly empty card just because its sibling column is taller" in skill_text
    assert "Fill report panel space with meaningful content before changing dimensions" in skill_text
    assert "Do not solve sparse panels by merely shrinking everything into a tiny chart" in skill_text
    assert "explain what the reader should conclude from the visual" in skill_text
    assert "first add useful analysis or supporting evidence" in skill_text
    assert "more than about one-third of this panel blank" in skill_text
    assert "For paired chart-plus-interpretation sections, align the right panel with the left panel deliberately" in skill_text
    assert "bottom edges should read as one clean row" in skill_text
    assert "do not leave a ragged right-side border floating halfway down the row" in skill_text
    assert "`align-items: stretch` only when both sides are content-filled" in skill_text


def test_build_system_prompt_prefers_existing_files_and_batched_edits():
    env = _make_env()
    prompt = build_system_prompt(env=env)

    assert "Use repository context and senior engineering judgment" in prompt
    assert 'Do not treat words like "write an html"' in prompt
    assert "Treat requests such as" in prompt
    assert "Search for and read the likely existing file" in prompt
    assert "small tweak, bug fix, style change, text change, or behavior change" in prompt
    assert "standalone preview, demo, script, or sample" in prompt
    assert "standalone preview, demo, script, report, or sample" not in prompt
    assert "Avoid `index.html` for newly created artifacts whenever possible" in prompt
    assert "too generic for users and future AI sessions" in prompt
    assert "Do not reuse a generic file such as `index.html`" in prompt
    assert "For unrelated standalone HTML previews or demos" in prompt
    assert "required app/framework/hosting entrypoint would otherwise break" in prompt
    assert "place it under `outputs/`" in prompt
    assert "prefer a concise readable Korean filename" in prompt
    assert "using underscores between words instead of hyphens" in prompt
    assert "outputs/인터넷_문화_변천사_보고서.html" in prompt
    assert "English snake/kebab-style names are fine" in prompt
    assert "keep files that reference each other in the same subfolder" in prompt
    assert "If both editing and creating are plausible" in prompt
    assert "create, install, persist, or update a MyHarness skill" in prompt
    assert "(program location)\\MyHarness\\.skills" in prompt
    assert "Use a workspace `.skills`, user-level skill directory, or another location only" in prompt
    assert "batch them into one `edit_file` call with the `edits` array" in prompt
    assert "issue the necessary `edit_file` calls in the same assistant response" in prompt

"""Higher-level system prompt assembly."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Literal

from myharness.config.paths import (
    get_project_active_repo_context_path,
    get_project_issue_file,
    get_project_pr_comments_file,
)
from myharness.config.settings import Settings
from myharness.coordinator.agent_definitions import get_all_agent_definitions
from myharness.coordinator.coordinator_mode import get_coordinator_system_prompt, is_coordinator_mode
from myharness.memory import find_relevant_memories, load_memory_prompt
from myharness.personalization.rules import load_local_rules
from myharness.prompts.project_instructions import load_project_instructions_prompt
from myharness.prompts.system_prompt import build_system_prompt
from myharness.skills.loader import load_skill_registry


def _build_skills_section(
    cwd: str | Path,
    *,
    extra_skill_dirs: Iterable[str | Path] | None = None,
    extra_plugin_roots: Iterable[str | Path] | None = None,
    settings: Settings | None = None,
) -> str | None:
    """Build a system prompt section listing available skills."""
    registry = load_skill_registry(
        cwd,
        extra_skill_dirs=extra_skill_dirs,
        extra_plugin_roots=extra_plugin_roots,
        settings=settings,
    )
    skills = registry.list_skills()
    if not skills:
        return None
    lines = [
        "# Available Skills",
        "",
        "The following skills are available via the `skill` tool. "
        "When a user's request matches a skill, invoke it with `skill(name=\"<skill_name>\")` "
        "to load detailed instructions before proceeding.",
        "",
    ]
    for skill in skills:
        lines.append(f"- **{skill.name}**: {skill.description}")
    return "\n".join(lines)


def _build_delegation_section() -> str:
    """Build a concise section describing delegation and worker usage."""
    return "\n".join(
        [
            "# Delegation And Subagents",
            "",
            "MyHarness can delegate background work with the `agent` tool.",
            "Use it when the user explicitly asks for a subagent, background worker, or parallel investigation, "
            "or when the task clearly benefits from splitting off a focused worker.",
            "When the user asks to divide work by roles, says AI team/swarm, or names roles like 조사, 정리, 검토, "
            "first sketch a lightweight workflow/DAG before spawning workers.",
            "When showing that workflow, use a fenced `mermaid` block with `flowchart LR` or `flowchart TD` "
            "so MyHarness can render it as a chart. "
            "Use labels that fit the actual task, not a fixed 조사/정리/검토 template; for example "
            "`flowchart LR; A[요건 파악: 범위 확인] --> B[데이터 수집: 원천 수집] --> C[정규화: 스키마 맞춤] --> D[검증: 결과 확인]`. "
            "Do not use raw ASCII art or the old `workflow` fence for the workflow.",
            "Spawn only the current independent wave. Do not spawn serial downstream roles prematurely; "
            "roles with unmet prerequisites wait until their inputs exist.",
            "Keep each wave controlled: usually use at most 10 workers per wave, give each a non-overlapping scope, "
            "and size the expected depth to the assignment. For quick slices, ask for concise bullets; for substantial analysis, "
            "ask for enough evidence, calculations, caveats, and intermediate tables to support a reliable synthesis. "
            "Prefer more workers only when they reduce wall-clock time.",
            "For research or analysis workers using web, MCP, vector databases, knowledge bases, source documents, or database queries, "
            "ask for source identifiers alongside important findings so you can cite them in the final answer or artifact. "
            "Useful identifiers include URLs/titles, file paths/pages, MCP server/resource names, document ids, table names, and query labels.",
            "Ask workers to emit compact JSON progress via `task_update` as part of their natural output flow, without "
            "waiting for the parent to ask. Progress should appear when a worker learns something material, starts a new phase, "
            "changes direction, finds a blocker, or has a handoff-ready fact. Do not ask workers to report after every tool call "
            "or send generic 'still working' heartbeats. Short progress lines are acceptable only when `task_update` is unavailable.",
            "Act as the main orchestrator while workers run: periodically inspect worker progress with `task_output`, "
            "relay useful findings or missing prerequisites to other workers with `send_message`, and adjust the plan as evidence arrives. "
            "Do not wait passively for every worker when partial results are enough to unblock the next step.",
            "After launching a parallel wave, watch completion times. If most workers finish within a few minutes but one worker "
            "runs much longer, briefly inspect that worker, stop it with `task_stop` if it is not clearly making fresh progress, "
            "then either spawn a narrower replacement, spawn a stronger replacement with `model=\"inherit\"`, "
            "or complete the remaining slice yourself in the main agent. "
            "Do not let one lagging worker block the whole task.",
            "Give worker descriptions visible role labels, such as `조사 담당: 전력 용량 출처 확인`, "
            "so the AI 팀 panel can show what each worker owns.",
            "",
            "Default pattern:",
            '- For coding implementation, spawn with `agent(description=..., prompt=..., subagent_type=\"worker\")`.',
            "- For office/research/analysis workers, set `team=\"office\"`. If an available preset below fits, set "
            "`subagent_type` to that preset route; otherwise omit `subagent_type` and create a focused ad-hoc worker prompt.",
            "- Inspect running or recorded workers with `/agents`.",
            "- Inspect one worker in detail with `/agents show TASK_ID`.",
            "- Inspect available presets with `/agents presets`.",
            "- Send follow-up instructions with `send_message(task_id=..., message=...)`.",
            "- Read worker output with `task_output(task_id=...)`.",
            "- Stop a stalled worker with `task_stop(task_id=...)` before retrying with a narrower prompt, "
            "a stronger inherited model, or main-agent execution.",
            "",
            "Prefer a normal direct answer for simple tasks. Use subagents only when they materially help. "
            "Do not make worker tasks artificially tiny when the user asks for substantial analysis; split by coherent workstream "
            "and let each worker complete that slice thoroughly.",
        ]
    )


PromptProfile = Literal["full", "continuation"]


def _build_subagent_presets_section(
    cwd: str | Path,
    *,
    settings: Settings | None = None,
) -> str | None:
    """Build a compact catalog of subagent presets without agent prompt bodies."""
    try:
        agents = get_all_agent_definitions(settings=settings, cwd=cwd)
    except TypeError:
        try:
            agents = get_all_agent_definitions()
        except Exception:
            return None
    except Exception:
        return None
    rows = [
        agent
        for agent in agents
        if agent.source != "builtin"
        and agent.name not in {"general-purpose", "worker", "verification", "Explore", "Plan"}
    ]
    if not rows:
        return None
    lines = [
        "# Available Subagent Presets",
        "",
        "Use these routes with `agent(..., team=\"office\", subagent_type=\"<route>\", prompt=\"...\")` "
        "when the preset matches the delegated task. If none fit, omit `subagent_type` and write a self-contained ad-hoc worker prompt.",
        "Each entry gives the route and a short when-to-use cue; the selected worker receives the full preset instructions separately.",
        "",
    ]
    for agent in sorted(rows, key=lambda item: (item.source, item.subagent_type or item.name)):
        route = agent.subagent_type or agent.name
        description = " ".join(agent.description.split())
        lines.append(f"- `{route}` — when to use: {description}")
    return "\n".join(lines)


def _build_task_worker_section() -> str:
    """Build guidance for stdin-driven background workers."""
    return "\n".join(
        [
            "# Background Worker Mode",
            "",
            "You are running as a background worker spawned by a parent MyHarness session.",
            "Treat the current user message as your complete assignment; you cannot see the parent chat.",
            "Do not use task_get, task_list, or task_output to inspect your own task or recover context. "
            "Those parent task records live in another process and are intentionally unavailable here.",
            "Use task_update only for brief progress updates when the prompt gives you a task id.",
            "Emit compact JSON progress via task_update as part of your natural output flow; do not wait for the parent "
            "to ask. Use it when you learn something material, start a new phase, change direction, find a blocker, "
            "or have a handoff-ready fact. Do not emit progress after every tool call or for generic still-working heartbeats. "
            "Keep these progress updates tiny and factual.",
            "If you are blocked, need a peer's result, or find information another worker should use, say so clearly in your progress "
            "or final output with a short `handoff` or `blocked_on` note for the parent orchestrator.",
            "For office, research, or analysis work that may feed a report, return chart, table, timeline, or comparison candidates "
            "with the specific numbers, labels, and source notes the parent should visualize.",
            "When your findings depend on web, MCP, vector database, knowledge-base, source-document, or database-query results, "
            "include enough source identifiers for the parent to cite important claims: URLs/titles, file pages or paths, "
            "MCP server/resource names, document ids, table names, or query labels as available. Do not invent missing sources.",
            "Do not return raw unstyled HTML unless the assignment explicitly asks for HTML code; prefer structured Markdown findings.",
            "Return findings at the depth requested by the assignment. For small tasks, be concise; for substantial analysis, include "
            "the evidence, calculations, assumptions, caveats, and structured tables needed by the parent to synthesize reliably.",
        ]
    )


def _build_long_report_section() -> str:
    """Build report length and artifact routing guidance."""
    return "\n".join(
        [
            "# Report Generation",
            "",
            "Ordinary report requests may still require standalone files. If the user asks for a report, long report, "
            "장문보고서, 긴 보고서, 대보고서, or a report based on pasted text, a site, article, document, transcript, "
            "research, investigation, comparison, analysis, or source summary and does not name another format, create "
            "a standalone HTML report under `outputs/` rather than putting the full report body only in the chat. For "
            "ordinary report requests with no explicit length, aim for roughly 10,000 substantive body tokens by default, "
            "unless the user asks for a shorter artifact, the source material is too thin to support that length, or "
            "another active limit makes that impossible. If the user or compose options explicitly request about 24k, 32k, "
            "or 40k output tokens, treat that as a target artifact content length rather than a loose upper cap: aim for "
            "roughly 80-105% of the requested tokens, and do not stop at an ordinary 10k-13k report when the target is "
            "24k or higher unless the source material is genuinely too thin or the user asks to be concise. Use the "
            "selected model's direct output budget and keep the result as one coherent artifact.",
            "For HTML report artifacts, load and follow the `visual-artifact` skill. Make the result feel like a polished "
            "reader-facing report page with strong visual hierarchy, exact tables, charts for trends/comparisons/proportions, "
            "and workflow/timeline diagrams when process or causal flow matters, not a plain article wrapped in HTML. Do not "
            "expose production metadata, generation budgets, tool/model details, or internal progress counters in the report "
            "body unless the user explicitly asks for an audit/debug view.",
            "Treat ordinary report generation as a substantial visible workflow when it involves research, analysis, source review, "
            "data queries, or a multi-section artifact. Before the final `write_file` call, use `todo_write` and concrete "
            "`<myharness-progress>` markers to show what you are analyzing, comparing, calculating, outlining, or synthesizing. "
            "Do not stay silent through the analysis phase and rely only on the later file-write argument stream for visibility.",
            "The `write_long_report` section-merge flow is temporarily disabled. Do not call it for extra-long report requests; "
            "instead, rely on the selected model's direct output limit and use `write_file` for one coherent artifact when a file is needed. "
            "If the report also asks for research, investigation, current facts, market data, policy/regulation checks, sources, "
            "or source-backed claims, gather the evidence first with `web_search`/`web_fetch` or an office research worker. "
            "Keep concise source notes in context so the final direct artifact can cite important external claims reliably. "
            "For web sources keep URLs/titles; for MCP, vector database, knowledge-base, document, or database-query results keep "
            "the server/resource/document/table/query identifiers that let the reader understand where the information came from.",
        ]
    )


def _build_continuation_appendix() -> str:
    """Build a small volatile appendix for follow-up turns."""
    return "\n".join(
        [
            "# Session Continuation",
            "",
            "The stable system, project, skill, tool, delegation, and report instructions above remain active.",
            "Use the existing conversation history for recent context. Fetch or inspect additional dynamic context only when needed for the current request.",
        ]
    )


def build_runtime_system_prompt(
    settings: Settings,
    *,
    cwd: str | Path,
    latest_user_prompt: str | None = None,
    extra_skill_dirs: Iterable[str | Path] | None = None,
    extra_plugin_roots: Iterable[str | Path] | None = None,
    task_worker: bool = False,
    prompt_profile: PromptProfile = "full",
) -> str:
    """Build the runtime system prompt with project instructions and memory."""
    coordinator_mode = is_coordinator_mode() and not task_worker
    if coordinator_mode:
        sections = [get_coordinator_system_prompt()]
    else:
        sections = [build_system_prompt(custom_prompt=settings.system_prompt, cwd=str(cwd))]

    if not coordinator_mode and settings.system_prompt is None:
        sections[0] = build_system_prompt(cwd=str(cwd))

    if settings.fast_mode:
        sections.append(
            "# Session Mode\nFast mode is enabled. Prefer concise replies, minimal tool use, and quicker progress over exhaustive exploration."
        )

    sections.append(
        "# Reasoning Settings\n"
        f"- Effort: {settings.effort}\n"
        f"- Passes: {settings.passes}\n"
        "Adjust depth and iteration count to match these settings while still completing the task."
    )

    skills_section = _build_skills_section(
        cwd,
        extra_skill_dirs=extra_skill_dirs,
        extra_plugin_roots=extra_plugin_roots,
        settings=settings,
    )
    if skills_section and not coordinator_mode and not task_worker:
        sections.append(skills_section)

    if task_worker:
        sections.append(_build_task_worker_section())
    elif not coordinator_mode:
        sections.append(_build_delegation_section())
        subagent_presets_section = _build_subagent_presets_section(cwd, settings=settings)
        if subagent_presets_section:
            sections.append(subagent_presets_section)
        sections.append(_build_long_report_section())

    project_instructions = load_project_instructions_prompt(cwd)
    if project_instructions:
        sections.append(project_instructions)

    local_rules = load_local_rules()
    if local_rules:
        sections.append(f"# Local Environment Rules\n\n{local_rules}")

    if prompt_profile == "continuation":
        sections.append(_build_continuation_appendix())
        return "\n\n".join(section for section in sections if section.strip())

    for title, path in (
        ("Issue Context", get_project_issue_file(cwd)),
        ("Pull Request Comments", get_project_pr_comments_file(cwd)),
        ("Active Repo Context", get_project_active_repo_context_path(cwd)),
    ):
        if path.exists():
            content = path.read_text(encoding="utf-8", errors="replace").strip()
            if content:
                sections.append(f"# {title}\n\n```md\n{content[:12000]}\n```")

    if settings.memory.enabled:
        memory_section = load_memory_prompt(
            cwd,
            max_entrypoint_lines=settings.memory.max_entrypoint_lines,
        )
        if memory_section:
            sections.append(memory_section)

        if latest_user_prompt:
            relevant = find_relevant_memories(
                latest_user_prompt,
                cwd,
                max_results=settings.memory.max_files,
            )
            if relevant:
                lines = ["# Relevant Memories"]
                for header in relevant:
                    content = header.path.read_text(encoding="utf-8", errors="replace").strip()
                    lines.extend(
                        [
                            "",
                            f"## {header.path.name}",
                            "```md",
                            content[:8000],
                            "```",
                        ]
                    )
                sections.append("\n".join(lines))

    return "\n\n".join(section for section in sections if section.strip())

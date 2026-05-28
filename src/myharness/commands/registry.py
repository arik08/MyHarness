"""Slash command registry."""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Awaitable, Callable, Literal, get_args, Iterable

import pyperclip

from myharness.autopilot import RepoAutopilotStore
from myharness.auth.manager import AuthManager
from myharness.config.paths import (
    get_config_dir,
    get_data_dir,
    get_feedback_log_path,
    get_project_config_dir,
    get_project_issue_file,
    get_project_pr_comments_file,
)
from myharness.bridge import get_bridge_manager
from myharness.bridge.types import WorkSecret
from myharness.bridge.work_secret import build_sdk_url, decode_work_secret, encode_work_secret
from myharness.api.provider import auth_status, detect_provider
from myharness.config.settings import (
    Settings,
    display_model_setting,
    format_token_count,
    load_settings,
    model_output_profile,
    save_settings,
)
from myharness.coordinator.agent_definitions import get_all_agent_definitions
from myharness.engine.messages import ConversationMessage, sanitize_conversation_messages
from myharness.engine.query_engine import QueryEngine
from myharness.learning import get_default_learning_skills_dir
from myharness.memory import (
    add_memory_entry,
    get_memory_entrypoint,
    get_project_memory_dir,
    list_memory_files,
    remove_memory_entry,
)
from myharness.mcp.config import load_mcp_server_configs
from myharness.output_styles import load_output_styles
from myharness.permissions import PermissionChecker, PermissionMode
from myharness.plugins import load_plugins
from myharness.prompts import build_runtime_system_prompt
from myharness.plugins.installer import install_plugin_from_path, uninstall_plugin
from myharness.project_preferences import (
    apply_project_preferences_to_settings,
    set_project_mcp_enabled,
    set_project_plugin_enabled,
)
from myharness.services import (
    build_post_compact_messages,
    compact_conversation,
    compact_messages,
    estimate_conversation_tokens,
    summarize_messages,
)
from myharness.services.session_backend import DEFAULT_SESSION_BACKEND, SessionBackend
from myharness.skills import load_skill_registry
from myharness.skills.display import display_skill_description
from myharness.skills.loader import is_learned_skill
from myharness.skills.routing import is_mcp_routed_skill
from myharness.skills.state import set_skill_enabled, toggle_skill_enabled
from myharness.tasks import get_task_manager
from myharness.plugins.types import PluginCommandDefinition

if TYPE_CHECKING:
    from myharness.state import AppStateStore
    from myharness.tools.base import ToolRegistry


_BUILT_IN_SKILL_SOURCES = {"bundled"}


def _custom_skills(skills):
    return [skill for skill in skills if skill.source not in _BUILT_IN_SKILL_SOURCES]


def _regular_custom_skills(skills):
    return [skill for skill in _custom_skills(skills) if not is_mcp_routed_skill(skill)]


def _mcp_routed_skills(skills):
    return [skill for skill in _custom_skills(skills) if is_mcp_routed_skill(skill)]


def _visible_custom_skills(skills, settings: Settings):
    custom = _custom_skills(skills)
    if settings.learning.effective_mode == "hide":
        custom = [skill for skill in custom if not is_learned_skill(skill)]
    return custom


def _format_skills_management_text(skills) -> str:
    if not skills:
        return "사용 가능한 스킬:\n(사용자 스킬이 없습니다)"
    lines = ["사용 가능한 스킬:"]
    for skill in skills:
        status = "활성" if skill.enabled else "비활성"
        source = f" [{skill.source}]"
        lines.append(f"- {skill.name}{source} [{status}]: {display_skill_description(skill)}")
    return "\n".join(lines)


def _format_mcp_management_text(settings, plugins, cwd: str | Path, mcp_skills=()) -> str:
    servers = load_mcp_server_configs(settings, plugins, cwd=cwd, include_disabled=True)
    mcp_skill_list = sorted(mcp_skills, key=lambda skill: skill.name)
    if not servers and not mcp_skill_list:
        return "MCP 서버:\n(설정된 MCP 서버가 없습니다)"
    disabled = set(settings.disabled_mcp_servers or set())
    lines = ["MCP 서버:"]
    for name, config in sorted(servers.items()):
        status = "비활성" if name in disabled else "활성"
        transport = getattr(config, "type", "알 수 없음")
        description = str(getattr(config, "description", "") or "").strip()
        suffix = f": {description}" if description else ""
        lines.append(f"- {name} [{status}] ({transport}){suffix}")
    for skill in mcp_skill_list:
        status = "활성" if skill.enabled else "비활성"
        description = display_skill_description(skill)
        suffix = f": {description}" if description else ""
        lines.append(f"- {skill.name} [{status}] (skill-mcp){suffix}")
    return "\n".join(lines)


def _format_plugins_management_text(plugins) -> str:
    if not plugins:
        return "플러그인:\n(발견된 플러그인이 없습니다)"
    lines = ["플러그인:"]
    for plugin in sorted(plugins, key=lambda item: item.manifest.name):
        status = "활성" if plugin.enabled else "비활성"
        description = f": {plugin.manifest.description}" if plugin.manifest.description else ""
        lines.append(f"- {plugin.manifest.name} [{status}]{description}")
    return "\n".join(lines)


def _format_capability_management_text(settings, plugins, skills, cwd: str | Path) -> str:
    regular_skills = _regular_custom_skills(skills)
    mcp_skills = _mcp_routed_skills(skills)
    return "\n\n".join(
        [
            _format_skills_management_text(regular_skills),
            _format_mcp_management_text(settings, plugins, cwd, mcp_skills),
            _format_plugins_management_text(plugins),
            "전환 사용법: /skills toggle NAME, /mcp toggle NAME, /plugin toggle NAME",
        ]
    )


def _effective_command_settings(context: "CommandContext") -> Settings:
    """Return settings with project-local UI preferences applied."""
    return apply_project_preferences_to_settings(load_settings(), context.cwd)


@dataclass
class CommandResult:
    """Result returned by a slash command."""

    message: str | None = None
    should_exit: bool = False
    clear_screen: bool = False
    replay_messages: list | None = None  # ConversationMessage list to replay in TUI
    continue_pending: bool = False
    continue_turns: int | None = None
    refresh_runtime: bool = False
    submit_prompt: str | None = None
    submit_model: str | None = None


@dataclass
class CommandContext:
    """Context available to command handlers."""

    engine: QueryEngine
    hooks_summary: str = ""
    mcp_summary: str = ""
    plugin_summary: str = ""
    cwd: str = "."
    tool_registry: ToolRegistry | None = None
    app_state: AppStateStore | None = None
    session_backend: SessionBackend = DEFAULT_SESSION_BACKEND
    session_id: str | None = None
    extra_skill_dirs: Iterable[str | Path] | None = None
    extra_plugin_roots: Iterable[str | Path] | None = None


CommandHandler = Callable[[str, CommandContext], Awaitable[CommandResult]]


def _parse_pgpt_login_args(args: str) -> dict[str, str]:
    raw = args.strip()
    tokens = raw.split()
    return {
        "api_key": tokens[0] if len(tokens) >= 1 else "",
        "employee_no": tokens[1] if len(tokens) >= 2 else "",
        "company_code": tokens[2] if len(tokens) >= 3 else "30",
    }


_AUTH_ENV_BY_SOURCE = {
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "dashscope_api_key": "DASHSCOPE_API_KEY",
    "moonshot_api_key": "MOONSHOT_API_KEY",
    "gemini_api_key": "GEMINI_API_KEY",
    "minimax_api_key": "MINIMAX_API_KEY",
    "pgpt_api_key": "PGPT_API_KEY",
}


def _set_process_env(values: dict[str, str]) -> None:
    for key, value in values.items():
        if value:
            os.environ[key] = value


@dataclass
class SlashCommand:
    """Definition of a slash command."""

    name: str
    description: str
    handler: CommandHandler
    remote_invocable: bool = True
    remote_admin_opt_in: bool = False
    aliases: tuple[str, ...] = ()


class CommandRegistry:
    """Map slash commands to handlers."""

    def __init__(self) -> None:
        # Primary commands keyed by canonical name, plus aliases pointing at
        # the same SlashCommand instance. We keep a separate set of canonical
        # names so help/listing output doesn't duplicate aliased entries.
        self._commands: dict[str, SlashCommand] = {}
        self._canonical_names: list[str] = []

    def register(self, command: SlashCommand) -> None:
        """Register a command, plus any aliases pointing at the same handler."""
        if command.name not in self._commands:
            self._canonical_names.append(command.name)
        self._commands[command.name] = command
        for alias in command.aliases:
            self._commands[alias] = command

    def lookup(self, raw_input: str) -> tuple[SlashCommand, str] | None:
        """Parse a slash command and return its handler plus raw args."""
        if not raw_input.startswith("/"):
            return None
        name, _, args = raw_input[1:].partition(" ")
        command = self._commands.get(name)
        if command is None:
            return None
        return command, args.strip()

    def help_text(self) -> str:
        """Return a formatted summary of all registered commands."""
        lines = [
            "입력 단축키:",
            "- !: 로컬 CLI 명령어를 바로 실행합니다.",
            "- @: 현재 프로젝트의 파일을 선택해 프롬프트에 첨부하거나 참조합니다.",
            "- $: 사용할 스킬, MCP, 플러그인을 선택해 프롬프트에 넣습니다.",
            "- /: 슬래시 명령어를 선택하거나 실행합니다.",
            "- Enter: 답변 중에는 스티어링 지시를 보내고, 대기 중에는 메시지를 전송합니다.",
            "- Ctrl+Enter: 답변 중에는 다음 질문으로 대기열에 추가하고, 대기 중에는 메시지를 전송합니다.",
            "- Shift+Enter: 입력란에서 줄바꿈합니다.",
            "- Ctrl+Shift+O: 새 채팅을 엽니다.",
            "- Shift+Tab: 계획모드를 켜거나 끕니다.",
            "",
            "알아두면 좋은 기능:",
            "- 채팅 입력란에 이미지를 붙여넣으면 첨부 이미지로 전송되고, 첨부 칩에서 바로 미리볼 수 있습니다.",
            "- 20줄을 초과한 긴 글은 입력창 위에 접힌 항목으로 표시되고, 전송 시 원문 전체가 그대로 포함됩니다.",
            "- 에이전트가 만든 HTML, Markdown, CSV, 이미지, PDF 산출물은 답변 카드나 오른쪽 패널에서 바로 미리볼 수 있습니다.",
            "- Shift+Tab으로 계획모드를 켜고 꺼도 작성 중인 초안, 이미지 첨부, 긴 붙여넣기 내용은 유지됩니다.",
            "- 체크리스트가 생기면 입력창 옆 아이콘으로 접고 펼치며 진행 상황을 확인할 수 있습니다.",
            "",
            "사용 가능한 명령어:",
        ]
        commands = [self._commands[name] for name in self._canonical_names]
        for command in sorted(commands, key=lambda item: item.name):
            lines.append(f"/{command.name:<12} {command.description}")
        return "\n".join(lines)

    def list_commands(self) -> list[SlashCommand]:
        """Return canonical commands in registration order (aliases omitted)."""
        return [self._commands[name] for name in self._canonical_names]


def _run_git_command(cwd: str, *args: str) -> tuple[bool, str]:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return False, "git is not installed."
    output = (completed.stdout or completed.stderr).strip()
    if completed.returncode != 0:
        return False, output or f"git {' '.join(args)} failed"
    return True, output


def _copy_to_clipboard(text: str) -> tuple[bool, str]:
    try:
        pyperclip.copy(text)
        return True, "clipboard"
    except Exception:
        for command in (["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard"]):
            try:
                subprocess.run(command, input=text, text=True, check=True, capture_output=True)
                return True, "clipboard"
            except Exception:
                continue
    fallback = get_data_dir() / "last_copy.txt"
    fallback.write_text(text, encoding="utf-8")
    return False, str(fallback)


def _last_message_text(messages: list[ConversationMessage]) -> str:
    for message in reversed(messages):
        if message.text.strip():
            return message.text.strip()
    return ""


def _shorten_text(text: str, *, limit: int = 160) -> str:
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3] + "..."


def _format_output_limit_text(model: str, max_tokens: int) -> str:
    profile = model_output_profile(model)
    return (
        f"출력 상한: {format_token_count(max_tokens)} / "
        f"모델 최대: {format_token_count(profile.model_max_output_tokens)}\n"
        f"컨텍스트: {format_token_count(profile.context_window_tokens)}"
    )


def _rewind_turns(messages: list[ConversationMessage], turns: int) -> list[ConversationMessage]:
    updated = list(messages)
    for _ in range(max(0, turns)):
        if not updated:
            break
        while updated:
            popped = updated.pop()
            if popped.role == "user" and popped.text.strip():
                break
    return updated


def _coerce_setting_value(settings: Settings, key: str, raw: str):
    field = Settings.model_fields.get(key)
    if field is None:
        raise KeyError(key)
    annotation = field.annotation
    if annotation is bool:
        lowered = raw.lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"Invalid boolean value for {key}: {raw}")
    if annotation is int:
        return int(raw)
    if annotation is str:
        return raw
    if annotation is Literal or getattr(annotation, "__origin__", None) is Literal:
        allowed = get_args(annotation)
        if raw not in allowed:
            raise ValueError(f"Invalid value for {key}: {raw}")
        return raw
    return raw


def _render_plugin_command_prompt(command: PluginCommandDefinition, args: str, session_id: str | None = None) -> str:
    prompt = command.content
    raw_args = args.strip()
    if command.is_skill and command.base_dir:
        prompt = f"Base directory for this skill: {command.base_dir}\n\n{prompt}"
    prompt = prompt.replace("${ARGUMENTS}", raw_args).replace("$ARGUMENTS", raw_args)
    if session_id:
        prompt = prompt.replace("${CLAUDE_SESSION_ID}", session_id)
    if raw_args and "${ARGUMENTS}" not in command.content and "$ARGUMENTS" not in command.content:
        prompt = f"{prompt}\n\nArguments: {raw_args}"
    return prompt


def _create_autopilot_commands() -> list[SlashCommand]:
    async def _autopilot_handler(args: str, context: CommandContext) -> CommandResult:
        store = RepoAutopilotStore(context.cwd)
        tokens = args.split()
        action = tokens[0].lower() if tokens else "status"

        def _render_card(card) -> str:
            lines = [
                f"{card.id} [{card.status}] score={card.score} {card.title}",
                f"source={card.source_kind} ref={card.source_ref or '-'}",
            ]
            if card.labels:
                lines.append(f"labels={', '.join(card.labels)}")
            if card.score_reasons:
                lines.append(f"reasons={', '.join(card.score_reasons[:4])}")
            if card.body:
                lines.append(_shorten_text(card.body, limit=220))
            return "\n".join(lines)

        if action == "status":
            counts = store.stats()
            active = store.pick_next_card()
            lines = ["오토파일럿 큐 상태:"]
            for status_name in (
                "queued",
                "accepted",
                "preparing",
                "running",
                "verifying",
                "pr_open",
                "waiting_ci",
                "repairing",
                "completed",
                "merged",
                "failed",
                "rejected",
                "superseded",
            ):
                lines.append(f"- {status_name}: {counts.get(status_name, 0)}")
            lines.append(f"- 레지스트리: {store.registry_path}")
            lines.append(f"- 저널: {store.journal_path}")
            lines.append(f"- 컨텍스트: {store.context_path}")
            if active is not None:
                lines.append(f"- 다음: {active.id} {active.title} (score={active.score})")
            return CommandResult(message="\n".join(lines))

        if action == "list":
            status = tokens[1].lower() if len(tokens) >= 2 else None
            if status is not None and status not in {
                "queued",
                "accepted",
                "preparing",
                "running",
                "verifying",
                "pr_open",
                "waiting_ci",
                "repairing",
                "completed",
                "merged",
                "failed",
                "rejected",
                "superseded",
            }:
                return CommandResult(message=f"알 수 없는 오토파일럿 상태: {status}")
            cards = store.list_cards(status=status)
            if not cards:
                return CommandResult(message="오토파일럿 카드가 없습니다.")
            return CommandResult(message="\n\n".join(_render_card(card) for card in cards[:12]))

        if action == "show" and len(tokens) >= 2:
            card = store.get_card(tokens[1])
            if card is None:
                return CommandResult(message=f"오토파일럿 카드를 찾을 수 없습니다: {tokens[1]}")
            return CommandResult(message=_render_card(card))

        if action == "next":
            card = store.pick_next_card()
            if card is None:
                return CommandResult(message="대기 중인 오토파일럿 카드가 없습니다.")
            return CommandResult(message=_render_card(card))

        if action == "context":
            content = store.load_active_context()
            return CommandResult(message=content or "활성 저장소 컨텍스트가 비어 있습니다.")

        if action == "journal":
            limit = 8
            if len(tokens) >= 2:
                try:
                    limit = max(1, min(30, int(tokens[1])))
                except ValueError:
                    return CommandResult(message="사용법: /autopilot journal [LIMIT]")
            entries = store.load_journal(limit=limit)
            if not entries:
                return CommandResult(message="저장소 저널이 비어 있습니다.")
            lines = []
            for entry in entries:
                timestamp = datetime.fromtimestamp(entry.timestamp, tz=timezone.utc).strftime(
                    "%Y-%m-%d %H:%M UTC"
                )
                task_suffix = f" [{entry.task_id}]" if entry.task_id else ""
                lines.append(f"{timestamp} {entry.kind}{task_suffix}: {entry.summary}")
            return CommandResult(message="\n".join(lines))

        if action == "add":
            raw = args[len("add") :].strip()
            if not raw:
                return CommandResult(
                    message=(
                        "사용법: /autopilot add "
                        "[idea|issue|pr|claude] TITLE :: DETAILS"
                    )
                )
            source_kind = "manual_idea"
            source_map = {
                "idea": "manual_idea",
                "manual": "manual_idea",
                "issue": "github_issue",
                "pr": "github_pr",
                "claude": "claude_code_candidate",
            }
            if " " in raw:
                first, remainder = raw.split(" ", 1)
                mapped = source_map.get(first.lower())
                if mapped is not None:
                    source_kind = mapped
                    raw = remainder.strip()
            title, _, body = raw.partition("::")
            if not title.strip():
                return CommandResult(
                    message=(
                        "사용법: /autopilot add "
                        "[idea|issue|pr|claude] TITLE :: DETAILS"
                    )
                )
            card, created = store.enqueue_card(
                source_kind=source_kind,
                title=title.strip(),
                body=body.strip(),
            )
            status_word = "대기열에 추가" if created else "새로고침"
            return CommandResult(
                message=f"오토파일럿 카드를 {status_word}했습니다: {card.id} (score={card.score}) {card.title}"
            )

        if action in {"accept", "start", "complete", "reject", "fail"} and len(tokens) >= 2:
            status_map = {
                "accept": "accepted",
                "start": "running",
                "complete": "completed",
                "fail": "failed",
                "reject": "rejected",
            }
            note = ""
            if len(tokens) >= 3:
                note = args.split(maxsplit=2)[2]
            try:
                card = store.update_status(tokens[1], status=status_map[action], note=note or None)
            except ValueError as exc:
                return CommandResult(message=str(exc))
            return CommandResult(message=f"{card.id} -> {card.status}: {card.title}")

        if action == "run-next":
            try:
                result = await store.run_next()
            except ValueError as exc:
                return CommandResult(message=str(exc))
            return CommandResult(
                message=(
                    f"{result.card_id} -> {result.status}\n"
                    f"실행 보고서: {result.run_report_path}\n"
                    f"검증 보고서: {result.verification_report_path}"
                )
            )

        if action == "tick":
            try:
                result = await store.tick()
            except ValueError as exc:
                return CommandResult(message=str(exc))
            if result is None:
                return CommandResult(message="오토파일럿 틱이 실행 없이 완료됐습니다.")
            return CommandResult(
                message=(
                    f"오토파일럿 틱 실행: {result.card_id} -> {result.status}\n"
                    f"실행 보고서: {result.run_report_path}\n"
                    f"검증 보고서: {result.verification_report_path}"
                )
            )

        if action == "install-cron":
            names = store.install_default_cron()
            return CommandResult(message="오토파일럿 cron 작업을 설치했습니다: " + ", ".join(names))

        if action == "export-dashboard":
            output = tokens[1] if len(tokens) >= 2 else None
            path = store.export_dashboard(output)
            return CommandResult(message=f"오토파일럿 대시보드를 내보냈습니다: {path}")

        if action == "scan":
            if len(tokens) < 2:
                return CommandResult(
                    message="사용법: /autopilot scan [issues|prs|claude-code|all] [LIMIT]"
                )
            target = tokens[1].lower()
            limit = 10
            if len(tokens) >= 3:
                try:
                    limit = max(1, min(50, int(tokens[2])))
                except ValueError:
                    return CommandResult(
                        message="사용법: /autopilot scan [issues|prs|claude-code|all] [LIMIT]"
                    )
            try:
                if target == "issues":
                    cards = store.scan_github_issues(limit=limit)
                    return CommandResult(message=f"Scanned {len(cards)} GitHub issues into autopilot.")
                if target == "prs":
                    cards = store.scan_github_prs(limit=limit)
                    return CommandResult(message=f"Scanned {len(cards)} GitHub PRs into autopilot.")
                if target == "claude-code":
                    cards = store.scan_claude_code_candidates(limit=limit)
                    return CommandResult(
                        message=f"Scanned {len(cards)} claude-code candidates into autopilot."
                    )
                if target == "all":
                    counts = store.scan_all_sources(issue_limit=limit, pr_limit=limit)
                    return CommandResult(message=f"Scanned all sources: {json.dumps(counts)}")
            except ValueError as exc:
                return CommandResult(message=str(exc))
            return CommandResult(
                message="사용법: /autopilot scan [issues|prs|claude-code|all] [LIMIT]"
            )

        return CommandResult(
            message=(
                "사용법: /autopilot "
                "[status|list [STATUS]|show ID|next|context|journal [LIMIT]|"
                "add [idea|issue|pr|claude] TITLE :: DETAILS|"
                "accept ID|start ID|complete ID [NOTE]|fail ID [NOTE]|reject ID [NOTE]|"
                "run-next|tick|install-cron|export-dashboard [OUTPUT]|"
                "scan [issues|prs|claude-code|all] [LIMIT]]"
            )
        )

    return [SlashCommand("autopilot", "저장소 자동 작업 입력과 컨텍스트를 관리합니다", _autopilot_handler)]


def _create_repo_commands() -> list[SlashCommand]:
    async def _ship_handler(args: str, context: CommandContext) -> CommandResult:
        raw = args.strip()
        if not raw:
            return CommandResult(message="사용법: /ship TITLE :: DETAILS")
        title, _, body = raw.partition("::")
        if not title.strip():
            return CommandResult(message="사용법: /ship TITLE :: DETAILS")
        store = RepoAutopilotStore(context.cwd)
        card, _ = store.enqueue_card(
            source_kind="manual_idea",
            title=title.strip(),
            body=body.strip(),
        )
        try:
            result = await store.run_card(card.id)
        except ValueError as exc:
            return CommandResult(message=str(exc))
        return CommandResult(
            message=(
                f"{result.card_id} -> {result.status}\n"
                f"실행 보고서: {result.run_report_path}\n"
                f"검증 보고서: {result.verification_report_path}"
            )
        )

    return [SlashCommand("ship", "저장소 작업을 큐에 넣고 실행합니다", _ship_handler)]


def create_default_command_registry(
    plugin_commands: Iterable[PluginCommandDefinition] | None = None,
) -> CommandRegistry:
    """Create the built-in command registry."""
    registry = CommandRegistry()

    def _effort_label(value: object) -> str:
        normalized = str(value or "").strip()
        return "자동" if normalized.lower() in {"", "none", "auto"} else normalized

    async def _help_handler(_: str, context: CommandContext) -> CommandResult:
        settings = _effective_command_settings(context)
        plugins = load_plugins(
            settings,
            context.cwd,
            extra_roots=context.extra_plugin_roots,
            include_program_plugins=True,
        )
        skill_registry = load_skill_registry(
            context.cwd,
            extra_skill_dirs=context.extra_skill_dirs,
            extra_plugin_roots=context.extra_plugin_roots,
            settings=settings,
            include_disabled=True,
        )
        skills = _visible_custom_skills(skill_registry.list_skills(), settings)
        return CommandResult(
            message=f"{registry.help_text()}\n\n{_format_capability_management_text(settings, plugins, skills, context.cwd)}"
        )

    async def _exit_handler(_: str, context: CommandContext) -> CommandResult:
        del context
        return CommandResult(should_exit=True)

    async def _clear_handler(_: str, context: CommandContext) -> CommandResult:
        context.engine.clear()
        return CommandResult(message="대화를 지웠습니다.", clear_screen=True)

    async def _status_handler(_: str, context: CommandContext) -> CommandResult:
        usage = context.engine.total_usage
        state = context.app_state.get() if context.app_state is not None else None
        manager = AuthManager()
        return CommandResult(
            message=(
                f"메시지: {len(context.engine.messages)}\n"
                f"사용량: 입력={usage.input_tokens} 출력={usage.output_tokens}\n"
                f"{_format_output_limit_text(context.engine.model, context.engine.max_tokens)}\n"
                f"프로필: {manager.get_active_profile()}\n"
                f"추론 강도: {_effort_label(state.effort if state is not None else load_settings().effort)}\n"
                f"패스: {state.passes if state is not None else load_settings().passes}"
            )
        )

    async def _version_handler(_: str, context: CommandContext) -> CommandResult:
        del context
        try:
            version = importlib.metadata.version("myharness")
        except importlib.metadata.PackageNotFoundError:
            version = "0.1.7"
        return CommandResult(message=f"MyHarness {version}")

    async def _context_handler(_: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        prompt = build_runtime_system_prompt(settings, cwd=context.cwd)
        return CommandResult(message=prompt)

    async def _summary_handler(args: str, context: CommandContext) -> CommandResult:
        max_messages = 8
        if args:
            try:
                max_messages = max(1, int(args))
            except ValueError:
                return CommandResult(message="사용법: /summary [MAX_MESSAGES]")
        summary = summarize_messages(context.engine.messages, max_messages=max_messages)
        return CommandResult(message=summary or "No conversation content to summarize.")

    async def _compact_handler(args: str, context: CommandContext) -> CommandResult:
        preserve_recent = 6
        if args:
            try:
                preserve_recent = max(1, int(args))
            except ValueError:
                return CommandResult(message="사용법: /compact [PRESERVE_RECENT]")
        before = len(context.engine.messages)
        try:
            compacted_result = await compact_conversation(
                context.engine.messages,
                api_client=context.engine.api_client,
                model=context.engine.model,
                system_prompt=context.engine.system_prompt,
                preserve_recent=preserve_recent,
                trigger="manual",
            )
            compacted = build_post_compact_messages(compacted_result)
        except Exception:
            compacted = compact_messages(context.engine.messages, preserve_recent=preserve_recent)
        context.engine.load_messages(compacted)
        return CommandResult(
            message=f"대화를 압축했습니다: 메시지 {before}개 -> {len(compacted)}개."
        )

    async def _usage_handler(_: str, context: CommandContext) -> CommandResult:
        usage = context.engine.total_usage
        estimated = estimate_conversation_tokens(context.engine.messages)
        return CommandResult(
            message=(
                f"실제 사용량: 입력={usage.input_tokens} 출력={usage.output_tokens}\n"
                f"{_format_output_limit_text(context.engine.model, context.engine.max_tokens)}\n"
                f"예상 대화 토큰: {estimated}\n"
                f"메시지: {len(context.engine.messages)}"
            )
        )

    async def _cost_handler(_: str, context: CommandContext) -> CommandResult:
        usage = context.engine.total_usage
        model = context.app_state.get().model if context.app_state is not None else load_settings().model
        estimated_cost = "확인 불가"
        if model.startswith("claude-3-5-sonnet"):
            estimated = (usage.input_tokens * 3.0 + usage.output_tokens * 15.0) / 1_000_000
            estimated_cost = f"${estimated:.4f} (추정)"
        elif model.startswith("claude-3-7-sonnet"):
            estimated = (usage.input_tokens * 3.0 + usage.output_tokens * 15.0) / 1_000_000
            estimated_cost = f"${estimated:.4f} (추정)"
        elif model.startswith("claude-3-opus"):
            estimated = (usage.input_tokens * 15.0 + usage.output_tokens * 75.0) / 1_000_000
            estimated_cost = f"${estimated:.4f} (추정)"
        return CommandResult(
            message=(
                f"모델: {model}\n"
                f"입력 토큰: {usage.input_tokens}\n"
                f"출력 토큰: {usage.output_tokens}\n"
                f"전체 토큰: {usage.total_tokens}\n"
                f"예상 비용: {estimated_cost}"
            )
        )

    async def _stats_handler(_: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        memory_count = len(list_memory_files(context.cwd))
        task_count = len(get_task_manager().list_tasks())
        tool_count = len(context.tool_registry.list_tools()) if context.tool_registry is not None else 0
        style = settings.output_style
        if context.app_state is not None:
            state = context.app_state.get()
            style = state.output_style
        return CommandResult(
            message=(
                "세션 통계:\n"
                f"- 메시지: {len(context.engine.messages)}\n"
                f"- 예상 토큰: {estimate_conversation_tokens(context.engine.messages)}\n"
                f"- 도구: {tool_count}\n"
                f"- 메모리 파일: {memory_count}\n"
                f"- 백그라운드 작업: {task_count}\n"
                f"- 출력 스타일: {style}"
            )
        )

    async def _memory_handler(args: str, context: CommandContext) -> CommandResult:
        tokens = args.split(maxsplit=1)
        if not tokens:
            memory_dir = get_project_memory_dir(context.cwd)
            entrypoint = get_memory_entrypoint(context.cwd)
            return CommandResult(
                message=f"메모리 디렉터리: {memory_dir}\n진입점: {entrypoint}"
            )
        action = tokens[0]
        rest = tokens[1] if len(tokens) == 2 else ""
        if action == "list":
            memory_files = list_memory_files(context.cwd)
            if not memory_files:
                return CommandResult(message="메모리 파일이 없습니다.")
            return CommandResult(message="\n".join(path.name for path in memory_files))
        if action == "show" and rest:
            memory_dir = get_project_memory_dir(context.cwd)
            path, invalid = _resolve_memory_entry_path(memory_dir, rest)
            if invalid:
                return CommandResult(message="메모리 항목 경로는 프로젝트 메모리 디렉터리 안에 있어야 합니다.")
            if path is None:
                return CommandResult(message=f"메모리 항목을 찾을 수 없습니다: {rest}")
            if not path.exists():
                return CommandResult(message=f"메모리 항목을 찾을 수 없습니다: {rest}")
            return CommandResult(message=path.read_text(encoding="utf-8"))
        if action == "add" and rest:
            title, separator, content = rest.partition("::")
            if not separator or not title.strip() or not content.strip():
                return CommandResult(message="사용법: /memory add TITLE :: CONTENT")
            path = add_memory_entry(context.cwd, title.strip(), content.strip())
            return CommandResult(message=f"메모리 항목을 추가했습니다: {path.name}")
        if action == "remove" and rest:
            if remove_memory_entry(context.cwd, rest.strip()):
                return CommandResult(message=f"메모리 항목을 제거했습니다: {rest.strip()}")
            return CommandResult(message=f"메모리 항목을 찾을 수 없습니다: {rest.strip()}")
        return CommandResult(message="사용법: /memory [list|show NAME|add TITLE :: CONTENT|remove NAME]")

    async def _hooks_handler(_: str, context: CommandContext) -> CommandResult:
        return CommandResult(message=context.hooks_summary or "설정된 훅이 없습니다.")

    async def _resume_handler(args: str, context: CommandContext) -> CommandResult:
        tokens = args.strip().split()

        # /resume <session_id> — load a specific session
        if tokens:
            sid = tokens[0]
            snapshot = context.session_backend.load_by_id(context.cwd, sid)
            if snapshot is None:
                return CommandResult(message=f"세션을 찾을 수 없습니다: {sid}")
            messages = sanitize_conversation_messages(
                [ConversationMessage.model_validate(item) for item in snapshot.get("messages", [])]
            )
            context.engine.load_messages(messages)
            summary = snapshot.get("summary", "")[:60]
            return CommandResult(
                message=f"세션 {sid}에서 메시지 {len(messages)}개를 복원했습니다"
                + (f" ({summary})" if summary else ""),
                replay_messages=messages,
            )

        # /resume — list sessions (for the TUI to show a picker)
        sessions = context.session_backend.list_snapshots(context.cwd, limit=None)
        if not sessions:
            # Fall back to latest.json
            snapshot = context.session_backend.load_latest(context.cwd)
            if snapshot is None:
                return CommandResult(message="이 프로젝트에 저장된 세션이 없습니다.")
            messages = sanitize_conversation_messages(
                [ConversationMessage.model_validate(item) for item in snapshot.get("messages", [])]
            )
            context.engine.load_messages(messages)
            return CommandResult(
                message=f"최근 세션에서 메시지 {len(messages)}개를 복원했습니다.",
                replay_messages=messages,
            )

        # Format session list for display / picker
        import time
        lines = ["저장된 세션:"]
        for s in sessions:
            ts = time.strftime("%m/%d %H:%M", time.localtime(s["created_at"]))
            summary = s["summary"][:50] or "(요약 없음)"
            lines.append(f"  {s['session_id']}  {ts}  메시지 {s['message_count']}개  {summary}")
        lines.append("")
        lines.append("특정 세션을 복원하려면 /resume <session_id>를 사용하세요.")
        return CommandResult(message="\n".join(lines))

    async def _export_handler(_: str, context: CommandContext) -> CommandResult:
        path = context.session_backend.export_markdown(cwd=context.cwd, messages=context.engine.messages)
        return CommandResult(message=f"대화 기록을 내보냈습니다: {path}")

    async def _share_handler(_: str, context: CommandContext) -> CommandResult:
        path = context.session_backend.export_markdown(cwd=context.cwd, messages=context.engine.messages)
        return CommandResult(message=f"공유용 대화 기록 스냅샷을 만들었습니다: {path}")

    async def _copy_handler(args: str, context: CommandContext) -> CommandResult:
        text = args.strip() or _last_message_text(context.engine.messages)
        if not text:
            return CommandResult(message="복사할 내용이 없습니다.")
        copied, target = _copy_to_clipboard(text)
        if copied:
            return CommandResult(message=f"클립보드에 {len(text)}자를 복사했습니다.")
        return CommandResult(message=f"클립보드를 사용할 수 없어 복사 내용을 저장했습니다: {target}")

    async def _session_handler(args: str, context: CommandContext) -> CommandResult:
        session_dir = context.session_backend.get_session_dir(context.cwd)
        tokens = args.split()
        if not tokens or tokens[0] == "show":
            latest = session_dir / "latest.json"
            transcript = session_dir / "transcript.md"
            lines = [
                f"세션 디렉터리: {session_dir}",
                f"최근 스냅샷: {'있음' if latest.exists() else '없음'}",
                f"대화 기록 내보내기: {'있음' if transcript.exists() else '없음'}",
                f"메시지 수: {len(context.engine.messages)}",
            ]
            return CommandResult(message="\n".join(lines))
        if tokens[0] == "ls":
            files = sorted(path.name for path in session_dir.iterdir())
            return CommandResult(message="\n".join(files) if files else "(비어 있음)")
        if tokens[0] == "path":
            return CommandResult(message=str(session_dir))
        if tokens[0] == "tag" and len(tokens) == 2:
            safe_name = "".join(character for character in tokens[1] if character.isalnum() or character in {"-", "_"})
            if not safe_name:
                return CommandResult(message="사용법: /session tag NAME")
            snapshot_path = context.session_backend.save_snapshot(
                cwd=context.cwd,
                model=context.app_state.get().model if context.app_state is not None else load_settings().model,
                system_prompt=build_runtime_system_prompt(load_settings(), cwd=context.cwd),
                messages=context.engine.messages,
                usage=context.engine.total_usage,
            )
            export_path = context.session_backend.export_markdown(cwd=context.cwd, messages=context.engine.messages)
            tagged_json = session_dir / f"{safe_name}.json"
            tagged_md = session_dir / f"{safe_name}.md"
            shutil.copy2(snapshot_path, tagged_json)
            shutil.copy2(export_path, tagged_md)
            return CommandResult(message=f"세션 태그를 저장했습니다: {safe_name}\n- {tagged_json}\n- {tagged_md}")
        if tokens[0] == "clear":
            if session_dir.exists():
                shutil.rmtree(session_dir)
            session_dir.mkdir(parents=True, exist_ok=True)
            return CommandResult(message=f"세션 저장소를 비웠습니다: {session_dir}")
        return CommandResult(message="사용법: /session [show|ls|path|tag NAME|clear]")

    async def _rewind_handler(args: str, context: CommandContext) -> CommandResult:
        turns = 1
        if args.strip():
            try:
                turns = max(1, int(args.strip()))
            except ValueError:
                return CommandResult(message="사용법: /rewind [TURNS]")
        before = len(context.engine.messages)
        updated = _rewind_turns(context.engine.messages, turns)
        context.engine.load_messages(updated)
        removed = before - len(updated)
        return CommandResult(message=f"{turns}턴을 되감아 메시지 {removed}개를 제거했습니다.")

    async def _tag_handler(args: str, context: CommandContext) -> CommandResult:
        name = args.strip()
        if not name:
            return CommandResult(message="사용법: /tag NAME")
        return await _session_handler(f"tag {name}", context)

    async def _files_handler(args: str, context: CommandContext) -> CommandResult:
        raw = args.strip()
        root = Path(context.cwd)
        max_items = 30
        tokens = raw.split(maxsplit=1)
        if tokens and tokens[0] == "dirs":
            dirs = [
                path
                for path in sorted(root.rglob("*"))
                if path.is_dir() and ".git" not in path.parts and ".venv" not in path.parts
            ]
            lines = [path.relative_to(root).as_posix() for path in dirs[:max_items]]
            if len(dirs) > max_items:
                lines.append(f"... {len(dirs) - max_items} more")
            return CommandResult(message="\n".join(lines) if lines else "(no directories)")
        if tokens and tokens[0].isdigit():
            max_items = max(1, min(int(tokens[0]), 200))
            raw = tokens[1] if len(tokens) == 2 else ""
        needle = raw.lower()
        files = [
            path
            for path in sorted(root.rglob("*"))
            if path.is_file() and ".git" not in path.parts and ".venv" not in path.parts
        ]
        if needle:
            files = [path for path in files if needle in path.relative_to(root).as_posix().lower()]
        lines = [path.relative_to(root).as_posix() for path in files[:max_items]]
        if len(files) > max_items:
            lines.append(f"... {len(files) - max_items} more")
        return CommandResult(
            message="\n".join(lines) if lines else "(no matching files)"
        )

    async def _agents_handler(args: str, context: CommandContext) -> CommandResult:
        tokens = args.split(maxsplit=1)
        guide = (
            "서브에이전트 안내:\n"
            "- 백그라운드 작업이나 병렬 조사가 필요할 때 모델에게 에이전트 도구로 위임하라고 요청하세요.\n"
            '- 일반적인 작업자 형태는 subagent_type="worker"입니다.\n'
            "- /agents presets 는 현재 등록된 subagent preset을 보여줍니다.\n"
            "- /agents 는 알려진 작업자 태스크를 나열합니다.\n"
            "- /agents show TASK_ID 는 특정 작업자의 출력과 메타데이터를 보여줍니다.\n"
            "- send_message(task_id=..., message=...) 로 생성된 작업자에게 후속 메시지를 보낼 수 있습니다.\n"
            "- task_output(task_id=...) 로 작업자의 최신 출력을 읽을 수 있습니다."
        )
        if tokens and tokens[0] in {"help", "usage"}:
            return CommandResult(
                message=guide
            )
        if tokens and tokens[0] in {"presets", "preset"}:
            agents = sorted(get_all_agent_definitions(), key=lambda agent: (agent.source, agent.name))
            rows = [
                agent
                for agent in agents
                if agent.name not in {"general-purpose", "worker", "verification", "Explore", "Plan"}
            ]
            if not rows:
                return CommandResult(message="등록된 subagent preset이 없습니다.")
            lines = ["등록된 subagent preset:"]
            for agent in rows:
                source = f" [{agent.source}]" if agent.source != "builtin" else ""
                route = agent.subagent_type or agent.name
                name = route if route == agent.name else f"{route} ({agent.name})"
                lines.append(f"- {name}{source}: {agent.description}")
            return CommandResult(message="\n".join(lines))
        if tokens and tokens[0] == "show" and len(tokens) == 2:
            task = get_task_manager().get_task(tokens[1])
            if task is None or task.type not in {"local_agent", "remote_agent", "in_process_teammate"}:
                return CommandResult(message=f"해당 ID의 에이전트를 찾을 수 없습니다: {tokens[1]}")
            output = get_task_manager().read_task_output(task.id)
            return CommandResult(
                message=(
                    f"{task.id} {task.type} {task.status} {task.description}\n"
                    f"메타데이터={task.metadata}\n"
                    f"출력:\n{output or '(출력 없음)'}"
                )
            )
        tasks = [
            task
            for task in get_task_manager().list_tasks()
            if task.type in {"local_agent", "remote_agent", "in_process_teammate"}
        ]
        if not tasks:
            return CommandResult(
                message=f"활성 또는 기록된 에이전트가 없습니다. 사용법은 /agents help 로 확인하세요.\n\n{guide}"
            )
        lines = [
            f"{task.id} {task.type} {task.status} {task.description}"
            for task in tasks
        ]
        return CommandResult(message="\n".join(lines))

    async def _init_handler(args: str, context: CommandContext) -> CommandResult:
        del args
        project_dir = get_project_config_dir(context.cwd)
        created: list[str] = []

        agents_md = Path(context.cwd) / "AGENTS.md"
        if not agents_md.exists():
            agents_md.write_text(
                "# Project Instructions\n\n"
                "- Use MyHarness tools deliberately.\n"
                "- Keep changes minimal and verify with tests when possible.\n",
                encoding="utf-8",
            )
            created.append(str(agents_md.relative_to(Path(context.cwd))))

        for relative, content in (
            (
                project_dir / "README.md",
                "# Project MyHarness Config\n\nThis directory stores project-specific MyHarness state.\n",
            ),
            (
                project_dir / "memory" / "MEMORY.md",
                "# Project Memory\n\nAdd reusable project knowledge here.\n",
            ),
            (
                project_dir / "plugins" / ".gitkeep",
                "",
            ),
            (
                project_dir / "skills" / ".gitkeep",
                "",
            ),
        ):
            relative.parent.mkdir(parents=True, exist_ok=True)
            if not relative.exists():
                relative.write_text(content, encoding="utf-8")
                created.append(str(relative.relative_to(Path(context.cwd))))

        if not created:
            return CommandResult(message="프로젝트가 이미 MyHarness용으로 초기화되어 있습니다.")
        return CommandResult(message="프로젝트 파일을 초기화했습니다:\n" + "\n".join(f"- {item}" for item in created))

    async def _bridge_handler(args: str, context: CommandContext) -> CommandResult:
        tokens = args.split()
        if not tokens or tokens[0] == "show":
            sessions = get_bridge_manager().list_sessions()
            lines = [
                "브리지 요약:",
                "- 백엔드 호스트: 사용 가능",
                f"- cwd: {context.cwd}",
                f"- 세션: {len(sessions)}",
                "- 유틸리티: encode, decode, sdk, spawn, list, output, stop",
            ]
            return CommandResult(message="\n".join(lines))
        if tokens[0] == "encode" and len(tokens) == 3:
            encoded = encode_work_secret(
                WorkSecret(version=1, session_ingress_token=tokens[2], api_base_url=tokens[1])
            )
            return CommandResult(message=encoded)
        if tokens[0] == "decode" and len(tokens) == 2:
            secret = decode_work_secret(tokens[1])
            return CommandResult(message=json.dumps(secret.__dict__, indent=2))
        if tokens[0] == "sdk" and len(tokens) == 3:
            return CommandResult(message=build_sdk_url(tokens[1], tokens[2]))
        if tokens[0] == "spawn" and len(tokens) >= 2:
            command = args[len("spawn ") :]
            handle = await get_bridge_manager().spawn(
                session_id=f"bridge-{datetime.now(timezone.utc).strftime('%H%M%S')}",
                command=command,
                cwd=context.cwd,
            )
            return CommandResult(
                message=f"브리지 세션 {handle.session_id} 시작됨 pid={handle.process.pid}"
            )
        if tokens[0] == "list":
            sessions = get_bridge_manager().list_sessions()
            if not sessions:
                return CommandResult(message="브리지 세션이 없습니다.")
            return CommandResult(
                message="\n".join(
                    f"{item.session_id} [{item.status}] pid={item.pid} {item.command}"
                    for item in sessions
                )
            )
        if tokens[0] == "output" and len(tokens) == 2:
            return CommandResult(message=get_bridge_manager().read_output(tokens[1]) or "(출력 없음)")
        if tokens[0] == "stop" and len(tokens) == 2:
            try:
                await get_bridge_manager().stop(tokens[1])
            except ValueError as exc:
                return CommandResult(message=str(exc))
            return CommandResult(message=f"브리지 세션 {tokens[1]}을(를) 중지했습니다.")
        return CommandResult(
            message="사용법: /bridge [show|encode API_BASE_URL TOKEN|decode SECRET|sdk API_BASE_URL SESSION_ID|spawn CMD|list|output SESSION_ID|stop SESSION_ID]"
        )

    async def _reload_plugins_handler(_: str, context: CommandContext) -> CommandResult:
        settings = _effective_command_settings(context)
        plugins = load_plugins(
            settings,
            context.cwd,
            extra_roots=context.extra_plugin_roots,
            include_program_plugins=True,
        )
        skill_registry = load_skill_registry(
            context.cwd,
            extra_skill_dirs=context.extra_skill_dirs,
            extra_plugin_roots=context.extra_plugin_roots,
            settings=settings,
            include_disabled=True,
        )
        skills = _visible_custom_skills(skill_registry.list_skills(), settings)
        lines = [
            f"Reloaded plugin and skill registry: {len(plugins)} plugin(s), {len(skills)} custom skill(s)."
        ]
        lines.append("")
        lines.append(_format_capability_management_text(settings, plugins, skills, context.cwd))
        return CommandResult(message="\n".join(lines))

    async def _skills_handler(args: str, context: CommandContext) -> CommandResult:
        settings = _effective_command_settings(context)
        skill_registry = load_skill_registry(
            context.cwd,
            extra_skill_dirs=context.extra_skill_dirs,
            extra_plugin_roots=context.extra_plugin_roots,
            settings=settings,
            include_disabled=True,
        )
        tokens = args.split(maxsplit=1)
        action = tokens[0].lower() if tokens else "list"
        rest = tokens[1].strip() if len(tokens) > 1 else ""
        if action in {"on", "off", "enable", "disable", "toggle"} and rest:
            skill = skill_registry.get(rest)
            if skill is None:
                return CommandResult(message=f"스킬을 찾을 수 없습니다: {rest}")
            if action in {"on", "enable"}:
                enabled = set_skill_enabled(skill.name, True)
            elif action in {"off", "disable"}:
                enabled = set_skill_enabled(skill.name, False)
            else:
                enabled = toggle_skill_enabled(skill.name)
            refreshed = load_skill_registry(
                context.cwd,
                extra_skill_dirs=context.extra_skill_dirs,
                extra_plugin_roots=context.extra_plugin_roots,
                settings=settings,
                include_disabled=True,
            )
            skills = _regular_custom_skills(refreshed.list_skills())
            return CommandResult(
                message=(
                    f"스킬 '{skill.name}'을(를) {'활성화' if enabled else '비활성화'}했습니다.\n\n"
                    f"{_format_skills_management_text(skills)}"
                )
            )
        if args and action not in {"list", "show"}:
            skill = skill_registry.get(args)
            if skill is None:
                return CommandResult(
                    message="사용법: /skills [list|show NAME|enable NAME|disable NAME|toggle NAME]"
                )
            return CommandResult(message=skill.content)
        if action == "show" and rest:
            skill = skill_registry.get(rest)
            if skill is None:
                return CommandResult(message=f"스킬을 찾을 수 없습니다: {rest}")
            return CommandResult(message=skill.content)
        skills = _regular_custom_skills(skill_registry.list_skills())
        return CommandResult(message=_format_skills_management_text(skills))

    async def _learned_skills_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        tokens = args.split()
        action = tokens[0].lower() if tokens else "show"
        mode_aliases = {
            "on": "use",
            "use": "use",
            "show": "show",
            "list": "list",
            "visible": "use",
            "hide": "hide",
            "hidden": "hide",
            "off": "off",
            "disable": "off",
            "disabled": "off",
        }
        normalized_action = mode_aliases.get(action, action)
        if normalized_action in {"use", "hide", "off"}:
            settings.learning.mode = normalized_action
            settings.learning.enabled = normalized_action != "off"
            save_settings(settings)
            label = {
                "use": "활성화하고 표시",
                "hide": "활성화하지만 $와 /help에서는 숨김",
                "off": "비활성화",
            }[normalized_action]
            return CommandResult(
                message=f"자동학습 스킬을 {label} 상태로 설정했습니다.",
                refresh_runtime=True,
            )
        if normalized_action not in {"show", "list"}:
            return CommandResult(message="사용법: /learned-skills [show|use|hide|off]")

        root = get_default_learning_skills_dir()
        learned = context.engine.tool_metadata.get("recent_learned_skills")
        effective_mode = settings.learning.effective_mode
        enabled_label = "비활성" if effective_mode == "off" else "활성"
        lines = [
            f"자동학습 스킬: {enabled_label} ({effective_mode})",
            f"프로그램 스킬 디렉터리: {root}",
        ]
        if isinstance(learned, list) and learned:
            lines.append("")
            lines.append("최근 자동 업데이트:")
            for item in learned[-8:]:
                if not isinstance(item, dict):
                    continue
                skill = str(item.get("skill") or "").strip()
                action_text = str(item.get("action") or "learned").strip()
                summary = str(item.get("summary") or "").strip()
                path = str(item.get("path") or "").strip()
                lines.append(f"- {skill} [{action_text}]: {summary}")
                if path:
                    lines.append(f"  {path}")
        else:
            lines.append("")
            lines.append("아직 이 세션의 자동 스킬 업데이트가 없습니다.")

        if root.exists():
            learned_dirs = sorted(
                path
                for path in root.iterdir()
                if path.is_dir() and path.name.startswith("learned-") and (path / "SKILL.md").exists()
            )
            if learned_dirs:
                lines.append("")
                lines.append("Program-local learned skills:")
                for path in learned_dirs[-12:]:
                    lines.append(f"- {path.name}: {path / 'SKILL.md'}")
        return CommandResult(message="\n".join(lines))

    async def _config_handler(args: str, context: CommandContext) -> CommandResult:
        del context
        settings = load_settings()
        tokens = args.split(maxsplit=2)
        if not tokens or tokens[0] == "show":
            return CommandResult(message=settings.model_dump_json(indent=2))
        if tokens[0] == "set" and len(tokens) == 3:
            key, value = tokens[1], tokens[2]
            if key not in Settings.model_fields:
                return CommandResult(message=f"Unknown config key: {key}")
            try:
                coerced = _coerce_setting_value(settings, key, value)
            except ValueError as exc:
                return CommandResult(message=str(exc))
            setattr(settings, key, coerced)
            save_settings(settings)
            return CommandResult(message=f"설정을 업데이트했습니다: {key}")
        return CommandResult(message="사용법: /config [show|set KEY VALUE]")

    async def _login_handler(args: str, context: CommandContext) -> CommandResult:
        del context
        settings = load_settings()
        profile_name, profile = settings.resolve_profile()
        provider = detect_provider(settings)
        api_key = args.strip()
        if not api_key:
            try:
                auth = settings.resolve_auth()
                auth_line = f"{auth.source}에서 설정됨"
            except Exception:
                auth_line = "설정되지 않음"
            return CommandResult(
                message=(
                    f"인증 상태:\n"
                    f"- 프로필: {profile_name}\n"
                    f"- 제공자: {provider.name}\n"
                    f"- 인증 소스: {profile.auth_source}\n"
                    f"- 인증 상태: {auth_status(settings)}\n"
                    f"- base_url: {settings.base_url or '(기본값)'}\n"
                    f"- 모델: {settings.model}\n"
                    f"- 자격 증명 소스: {auth_line}\n"
                    f"사용법: {'/login API_KEY EMPLOYEE_NO [COMPANY_CODE]' if profile.auth_source == 'pgpt_api_key' else '/login API_KEY'}"
                )
            )
        if profile.auth_source == "pgpt_api_key":
            values = _parse_pgpt_login_args(api_key)
            if not values.get("api_key") or not values.get("employee_no"):
                return CommandResult(message="사용법: /login API_KEY EMPLOYEE_NO [COMPANY_CODE]")
            env_values = {
                "PGPT_API_KEY": values["api_key"],
                "PGPT_EMPLOYEE_NO": values["employee_no"],
            }
            if values.get("company_code") and values["company_code"] != "30":
                env_values["PGPT_COMPANY_CODE"] = values["company_code"]
            _set_process_env(env_values)
            return CommandResult(
                message=(
                    "P-GPT 자격 증명을 현재 프로세스 환경에 불러왔습니다. "
                    "Windows 사용자 환경에 영구 등록하려면 run_myharness_web.bat을 실행한 뒤 안내가 나오면 setup을 선택하세요."
                )
            )
        env_var = _AUTH_ENV_BY_SOURCE.get(profile.auth_source)
        if env_var is None:
            return CommandResult(message=f"/login does not support auth source: {profile.auth_source}")
        _set_process_env({env_var: api_key})
        return CommandResult(message=f"API 키를 현재 프로세스 환경에 {env_var}(으)로 불러왔습니다.")

    async def _logout_handler(_: str, context: CommandContext) -> CommandResult:
        del context
        settings = load_settings()
        profile_name, profile = settings.resolve_profile()
        AuthManager(settings).clear_profile_credential(profile_name)
        env_var = _AUTH_ENV_BY_SOURCE.get(profile.auth_source)
        if env_var:
            os.environ.pop(env_var, None)
        if profile.auth_source == "pgpt_api_key":
            os.environ.pop("PGPT_EMPLOYEE_NO", None)
            os.environ.pop("PGPT_COMPANY_CODE", None)
        return CommandResult(message="저장된 API 키와 현재 프로세스 인증 환경을 지웠습니다.")

    async def _feedback_handler(args: str, context: CommandContext) -> CommandResult:
        del context
        path = get_feedback_log_path()
        if not args.strip():
            return CommandResult(message=f"피드백 로그: {path}\n사용법: /feedback TEXT")
        timestamp = datetime.now(timezone.utc).isoformat()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] {args.strip()}\n")
        return CommandResult(message=f"피드백을 {path}에 저장했습니다")

    async def _onboarding_handler(_: str, context: CommandContext) -> CommandResult:
        del context
        return CommandResult(
            message=(
                "MyHarness quickstart:\n"
                "1. Ask for a coding task in plain language.\n"
                "2. Use /help to inspect commands.\n"
                "3. Use /doctor to inspect runtime state.\n"
                "4. Use /tasks for background work and /memory for project memory.\n"
                "5. Set provider environment variables before starting the app if needed."
            )
        )

    async def _fast_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        current = (
            context.app_state.get().fast_mode
            if context.app_state is not None
            else settings.fast_mode
        )
        action = args.strip() or "show"
        if action == "show":
            return CommandResult(message=f"빠른 모드: {'켜짐' if current else '꺼짐'}")
        enabled = {"on": True, "off": False, "toggle": not current}.get(action)
        if enabled is None:
            return CommandResult(message="사용법: /fast [show|on|off|toggle]")
        settings.fast_mode = enabled
        save_settings(settings)
        if context.app_state is not None:
            context.app_state.set(fast_mode=enabled)
        return CommandResult(message=f"빠른 모드를 {'켰습니다' if enabled else '껐습니다'}.")

    async def _effort_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        current = context.app_state.get().effort if context.app_state is not None else settings.effort
        value = args.strip() or "show"
        if value == "show":
            return CommandResult(message=f"추론 강도: {_effort_label(current)}")
        if value not in {"auto", "none", "low", "medium", "high", "xhigh", "max"}:
            return CommandResult(message="사용법: /effort [show|auto|low|medium|high|xhigh|max]")
        stored_value = "none" if value == "auto" else value
        settings.effort = stored_value
        save_settings(settings)
        context.engine.set_reasoning_effort(stored_value)
        context.engine.set_system_prompt(build_runtime_system_prompt(settings, cwd=context.cwd))
        if context.app_state is not None:
            context.app_state.set(effort=stored_value)
        return CommandResult(message=f"추론 강도를 {_effort_label(stored_value)}(으)로 설정했습니다.")

    async def _passes_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        current = context.app_state.get().passes if context.app_state is not None else settings.passes
        value = args.strip() or "show"
        if value == "show":
            return CommandResult(message=f"패스: {current}")
        try:
            passes = max(1, min(int(value), 8))
        except ValueError:
            return CommandResult(message="사용법: /passes [show|COUNT]")
        settings.passes = passes
        save_settings(settings)
        context.engine.set_system_prompt(build_runtime_system_prompt(settings, cwd=context.cwd))
        if context.app_state is not None:
            context.app_state.set(passes=passes)
        return CommandResult(message=f"패스 수를 {passes}(으)로 설정했습니다.")

    async def _turns_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        engine_turns = "unlimited" if context.engine.max_turns is None else str(context.engine.max_turns)
        tokens = args.split()
        if not tokens or tokens[0] == "show":
            return CommandResult(
                message=(
                    f"최대 턴(엔진): {engine_turns}\n"
                    f"최대 턴(설정): {settings.max_turns}\n"
                    "사용법: /turns [show|unlimited|COUNT]"
                )
            )
        if tokens[0] == "set" and len(tokens) == 2:
            raw = tokens[1]
        elif len(tokens) == 1:
            raw = tokens[0]
        else:
            return CommandResult(message="사용법: /turns [show|unlimited|COUNT]")
        if raw.lower() == "unlimited":
            context.engine.set_max_turns(None)
            return CommandResult(
                message=(
                    "이 세션의 최대 턴을 무제한으로 설정했습니다. "
                    f"저장된 설정은 {settings.max_turns}로 유지됩니다."
                )
            )
        try:
            turns = int(raw)
        except ValueError:
            return CommandResult(message="사용법: /turns [show|unlimited|COUNT]")
        turns = max(1, min(turns, 512))
        settings.max_turns = turns
        save_settings(settings)
        context.engine.set_max_turns(turns)
        return CommandResult(message=f"최대 턴을 {turns}(으)로 설정했습니다.")

    async def _continue_handler(args: str, context: CommandContext) -> CommandResult:
        raw = args.strip()
        if not context.engine.has_pending_continuation():
            return CommandResult(message="계속할 항목이 없습니다. 대기 중인 도구 결과가 없습니다.")

        turns: int | None = None
        if raw:
            tokens = raw.split()
            if tokens[0] == "set" and len(tokens) == 2:
                raw = tokens[1]
            try:
                turns = int(raw)
            except ValueError:
                return CommandResult(message="사용법: /continue [COUNT]")
            turns = max(1, min(turns, 512))

        return CommandResult(
            message="대기 중인 도구 루프를 계속합니다...",
            continue_pending=True,
            continue_turns=turns,
        )

    async def _issue_handler(args: str, context: CommandContext) -> CommandResult:
        path = get_project_issue_file(context.cwd)
        tokens = args.split(maxsplit=1)
        action = tokens[0] if tokens else "show"
        rest = tokens[1] if len(tokens) == 2 else ""
        if action == "show":
            if not path.exists():
                return CommandResult(message=f"이슈 컨텍스트가 없습니다. 파일 경로: {path}")
            return CommandResult(message=path.read_text(encoding="utf-8"))
        if action == "set" and rest:
            title, separator, body = rest.partition("::")
            if not separator or not title.strip() or not body.strip():
                return CommandResult(message="사용법: /issue set TITLE :: BODY")
            content = f"# {title.strip()}\n\n{body.strip()}\n"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
            return CommandResult(message=f"이슈 컨텍스트를 {path}에 저장했습니다")
        if action == "clear":
            if path.exists():
                path.unlink()
                return CommandResult(message="이슈 컨텍스트를 지웠습니다.")
            return CommandResult(message="지울 이슈 컨텍스트가 없습니다.")
        return CommandResult(message="사용법: /issue [show|set TITLE :: BODY|clear]")

    async def _pr_comments_handler(args: str, context: CommandContext) -> CommandResult:
        path = get_project_pr_comments_file(context.cwd)
        tokens = args.split(maxsplit=1)
        action = tokens[0] if tokens else "show"
        rest = tokens[1] if len(tokens) == 2 else ""
        if action == "show":
            if not path.exists():
                return CommandResult(message=f"PR 댓글 컨텍스트가 없습니다. 파일 경로: {path}")
            return CommandResult(message=path.read_text(encoding="utf-8"))
        if action == "add" and rest:
            location, separator, comment = rest.partition("::")
            if not separator or not location.strip() or not comment.strip():
                return CommandResult(message="사용법: /pr_comments add FILE[:LINE] :: COMMENT")
            existing = path.read_text(encoding="utf-8") if path.exists() else "# PR Comments\n"
            if not existing.endswith("\n"):
                existing += "\n"
            existing += f"- {location.strip()}: {comment.strip()}\n"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(existing, encoding="utf-8")
            return CommandResult(message=f"PR 댓글 컨텍스트를 추가했습니다: {path}")
        if action == "clear":
            if path.exists():
                path.unlink()
                return CommandResult(message="PR 댓글 컨텍스트를 지웠습니다.")
            return CommandResult(message="지울 PR 댓글 컨텍스트가 없습니다.")
        return CommandResult(message="사용법: /pr_comments [show|add FILE[:LINE] :: COMMENT|clear]")

    async def _mcp_handler(args: str, context: CommandContext) -> CommandResult:
        settings = _effective_command_settings(context)
        tokens = args.split()
        plugins = load_plugins(
            settings,
            context.cwd,
            extra_roots=context.extra_plugin_roots,
            include_program_plugins=True,
        )
        servers = load_mcp_server_configs(settings, plugins, cwd=context.cwd, include_disabled=True)
        skill_registry = load_skill_registry(
            context.cwd,
            extra_skill_dirs=context.extra_skill_dirs,
            extra_plugin_roots=context.extra_plugin_roots,
            settings=settings,
            include_disabled=True,
        )
        mcp_skills = {skill.name: skill for skill in _mcp_routed_skills(skill_registry.list_skills())}
        if not tokens or tokens[0] == "list":
            return CommandResult(message=_format_mcp_management_text(settings, plugins, context.cwd, mcp_skills.values()))
        if tokens[0] in {"enable", "disable", "toggle"} and len(tokens) == 2:
            server_name = tokens[1]
            if server_name in mcp_skills:
                skill = mcp_skills[server_name]
                if tokens[0] == "enable":
                    enabled = set_skill_enabled(skill.name, True)
                elif tokens[0] == "disable":
                    enabled = set_skill_enabled(skill.name, False)
                else:
                    enabled = toggle_skill_enabled(skill.name)
                return CommandResult(
                    message=f"MCP 스킬 '{skill.name}'을(를) {'활성화' if enabled else '비활성화'}했습니다.",
                    refresh_runtime=True,
                )
            if server_name not in servers:
                return CommandResult(message=f"알 수 없는 MCP 서버: {server_name}")
            disabled = set(settings.disabled_mcp_servers or set())
            if tokens[0] == "enable":
                disabled.discard(server_name)
            elif tokens[0] == "disable":
                disabled.add(server_name)
            else:
                if server_name in disabled:
                    disabled.remove(server_name)
                else:
                    disabled.add(server_name)
            enabled = server_name not in disabled
            set_project_mcp_enabled(context.cwd, server_name, enabled, settings)
            return CommandResult(
                message=f"MCP 서버 '{server_name}'을(를) {'활성화' if enabled else '비활성화'}했습니다.",
                refresh_runtime=True,
            )
        if tokens and tokens[0] == "auth" and len(tokens) >= 3:
            server_name = tokens[1]
            config = settings.mcp_servers.get(server_name)
            if config is None:
                return CommandResult(message=f"알 수 없는 MCP 서버: {server_name}")

            if len(tokens) == 3:
                mode = "bearer"
                key = None
                value = tokens[2]
            elif len(tokens) == 4:
                mode = tokens[2]
                key = None
                value = tokens[3]
            elif len(tokens) == 5:
                mode = tokens[2]
                key = tokens[3]
                value = tokens[4]
            else:
                return CommandResult(
                    message="사용법: /mcp auth SERVER TOKEN | /mcp auth SERVER [bearer|env] VALUE | /mcp auth SERVER header KEY VALUE"
                )

            if hasattr(config, "headers"):
                if mode not in {"bearer", "header"}:
                    return CommandResult(message="HTTP/WS MCP 인증은 bearer 또는 header 모드를 지원합니다.")
                header_key = key or "Authorization"
                header_value = (
                    f"Bearer {value}" if mode == "bearer" and header_key == "Authorization" else value
                )
                headers = dict(getattr(config, "headers", {}) or {})
                headers[header_key] = header_value
                settings.mcp_servers[server_name] = config.model_copy(update={"headers": headers})
            elif hasattr(config, "env"):
                if mode not in {"bearer", "env"}:
                    return CommandResult(message="stdio MCP 인증은 bearer 또는 env 모드를 지원합니다.")
                env_key = key or "MCP_AUTH_TOKEN"
                env_value = f"Bearer {value}" if mode == "bearer" else value
                env = dict(getattr(config, "env", {}) or {})
                env[env_key] = env_value
                settings.mcp_servers[server_name] = config.model_copy(update={"env": env})
            else:
                return CommandResult(message=f"서버 {server_name}은(는) 인증 업데이트를 지원하지 않습니다")
            save_settings(settings)
            return CommandResult(message=f"{server_name} MCP 인증을 저장했습니다. 다시 연결하려면 세션을 재시작하세요.")
        return CommandResult(message="사용법: /mcp [list|enable NAME|disable NAME|toggle NAME|auth SERVER ...]")

    async def _plugin_handler(args: str, context: CommandContext) -> CommandResult:
        settings = _effective_command_settings(context)
        tokens = args.split()
        if not tokens or tokens[0] == "list":
            plugins = load_plugins(
                settings,
                context.cwd,
                extra_roots=context.extra_plugin_roots,
                include_program_plugins=True,
            )
            return CommandResult(message=_format_plugins_management_text(plugins))
        if tokens[0] == "enable" and len(tokens) == 2:
            plugins = {plugin.manifest.name: plugin for plugin in load_plugins(
                settings,
                context.cwd,
                extra_roots=context.extra_plugin_roots,
                include_program_plugins=True,
            )}
            plugin = plugins.get(tokens[1])
            reset_names = [skill.name for skill in plugin.skills] if plugin is not None else []
            set_project_plugin_enabled(context.cwd, tokens[1], True, settings, reset_skill_names=reset_names)
            return CommandResult(message=f"플러그인 '{tokens[1]}'을(를) 활성화했습니다. 다시 불러오려면 세션을 재시작하세요.")
        if tokens[0] == "disable" and len(tokens) == 2:
            plugins = {plugin.manifest.name: plugin for plugin in load_plugins(
                settings,
                context.cwd,
                extra_roots=context.extra_plugin_roots,
                include_program_plugins=True,
            )}
            plugin = plugins.get(tokens[1])
            reset_names = [skill.name for skill in plugin.skills] if plugin is not None else []
            set_project_plugin_enabled(context.cwd, tokens[1], False, settings, reset_skill_names=reset_names)
            return CommandResult(message=f"플러그인 '{tokens[1]}'을(를) 비활성화했습니다. 다시 불러오려면 세션을 재시작하세요.")
        if tokens[0] == "toggle" and len(tokens) == 2:
            plugins = load_plugins(
                settings,
                context.cwd,
                extra_roots=context.extra_plugin_roots,
                include_program_plugins=True,
            )
            known_plugins = {plugin.manifest.name: plugin for plugin in plugins}
            current = known_plugins.get(tokens[1])
            if current is None:
                return CommandResult(message=f"알 수 없는 플러그인: {tokens[1]}")
            enabled = not current.enabled
            set_project_plugin_enabled(
                context.cwd,
                tokens[1],
                enabled,
                settings,
                reset_skill_names=[skill.name for skill in current.skills],
            )
            return CommandResult(
                message=f"플러그인 '{tokens[1]}'을(를) {'활성화' if enabled else '비활성화'}했습니다. 다시 불러오려면 세션을 재시작하세요."
            )
        if tokens[0] == "install" and len(tokens) == 2:
            path = install_plugin_from_path(tokens[1])
            return CommandResult(message=f"플러그인을 {path}에 설치했습니다")
        if tokens[0] == "uninstall" and len(tokens) == 2:
            if uninstall_plugin(tokens[1]):
                return CommandResult(message=f"플러그인 '{tokens[1]}'을(를) 제거했습니다")
            return CommandResult(message=f"플러그인 '{tokens[1]}'을(를) 찾을 수 없습니다")
        plugins = load_plugins(
            settings,
            context.cwd,
            extra_roots=context.extra_plugin_roots,
            include_program_plugins=True,
        )
        if plugins:
            return CommandResult(message=_format_plugins_management_text(plugins))
        return CommandResult(message="사용법: /plugin [list|enable NAME|disable NAME|toggle NAME|install PATH|uninstall NAME]")

    _MODE_LABELS = {"default": "Default", "plan": "Plan Mode", "full_auto": "Auto"}
    _PLAN_MODE_VALUES = {PermissionMode.PLAN.value, "plan_mode", "permissionmode.plan"}

    def _normalize_permission_mode(value: object) -> PermissionMode | None:
        raw = str(value or "").strip().lower().replace(" ", "_")
        aliases = {
            "default": PermissionMode.DEFAULT,
            "permissionmode.default": PermissionMode.DEFAULT,
            "plan": PermissionMode.PLAN,
            "plan_mode": PermissionMode.PLAN,
            "permissionmode.plan": PermissionMode.PLAN,
            "full_auto": PermissionMode.FULL_AUTO,
            "auto": PermissionMode.FULL_AUTO,
            "permissionmode.full_auto": PermissionMode.FULL_AUTO,
        }
        return aliases.get(raw)

    def _stored_plan_previous_mode(settings, context: CommandContext) -> PermissionMode:
        state_previous = (
            getattr(context.app_state.get(), "plan_previous_permission_mode", "")
            if context.app_state is not None
            else ""
        )
        previous = (
            _normalize_permission_mode(state_previous)
            or settings.permission.plan_previous_mode
        )
        if previous is not None and previous != PermissionMode.PLAN:
            return previous
        return PermissionMode.FULL_AUTO if settings.yolo_mode_enabled else PermissionMode.DEFAULT

    def _set_runtime_permission_mode(
        settings,
        context: CommandContext,
        mode: PermissionMode,
        *,
        plan_previous_mode: PermissionMode | None = None,
    ) -> None:
        runtime_permission = settings.permission.model_copy(
            update={"mode": mode, "plan_previous_mode": plan_previous_mode}
        )
        context.engine.set_permission_checker(PermissionChecker(runtime_permission))
        if context.app_state is not None:
            context.app_state.set(
                permission_mode=mode.value,
                plan_previous_permission_mode=plan_previous_mode.value if plan_previous_mode is not None else "",
            )

    async def _permissions_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        tokens = args.split()
        if not tokens or tokens[0] == "show":
            permission = settings.permission
            active_mode = (
                context.app_state.get().permission_mode
                if context.app_state is not None
                else permission.mode.value
            )
            label = _MODE_LABELS.get(active_mode, active_mode)
            return CommandResult(
                message=(
                    f"Mode: {label}\n"
                    f"Allowed tools: {permission.allowed_tools}\n"
                    f"Denied tools: {permission.denied_tools}"
                )
            )
        target_mode: str | None = None
        if tokens[0] == "set" and len(tokens) == 2:
            target_mode = tokens[1]
        elif len(tokens) == 1 and tokens[0] in _MODE_LABELS:
            target_mode = tokens[0]
        if target_mode is not None:
            settings.permission.mode = PermissionMode(target_mode)
            settings.permission.plan_previous_mode = None
            save_settings(settings)
            context.engine.set_permission_checker(PermissionChecker(settings.permission))
            if context.app_state is not None:
                context.app_state.set(
                    permission_mode=settings.permission.mode.value,
                    plan_previous_permission_mode="",
                )
            label = _MODE_LABELS.get(target_mode, target_mode)
            return CommandResult(message=f"Permission mode set to {label}", refresh_runtime=True)
        return CommandResult(message="사용법: /permissions [show|MODE]")

    async def _plan_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        raw_app_mode = (
            context.app_state.get().permission_mode
            if context.app_state is not None
            else None
        )
        current_mode = str(raw_app_mode or "").strip().lower().replace(" ", "_")
        saved_mode = str(settings.permission.mode.value).strip().lower().replace(" ", "_")
        mode = args.strip() or ("off" if current_mode in _PLAN_MODE_VALUES or saved_mode in _PLAN_MODE_VALUES else "on")
        if mode in {"on", "enter"}:
            previous_mode = _normalize_permission_mode(raw_app_mode)
            if previous_mode is None:
                previous_mode = _normalize_permission_mode(settings.permission.mode.value)
            if previous_mode is None or previous_mode == PermissionMode.PLAN:
                previous_mode = _stored_plan_previous_mode(settings, context)
            _set_runtime_permission_mode(
                settings,
                context,
                PermissionMode.PLAN,
                plan_previous_mode=previous_mode,
            )
            return CommandResult(message="계획 모드를 켰습니다.")
        if mode in {"off", "exit"}:
            restored_mode = _stored_plan_previous_mode(settings, context)
            _set_runtime_permission_mode(settings, context, restored_mode)
            return CommandResult(message="계획 모드를 껐습니다.")
        return CommandResult(message="사용법: /plan [on|off]")

    async def _model_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        manager = AuthManager(settings)
        active_profile = manager.get_active_profile()
        _, profile = settings.resolve_profile(active_profile)
        tokens = args.split(maxsplit=1)
        if not tokens or tokens[0] == "show":
            return CommandResult(message=f"모델: {display_model_setting(profile)}\n프로필: {active_profile}")
        if tokens[0] == "set" and len(tokens) == 2:
            model_name = tokens[1].strip()
        elif args.strip():
            model_name = args.strip()
        else:
            model_name = None
        if model_name:
            if profile.allowed_models and model_name.lower() != "default" and model_name not in profile.allowed_models:
                allowed = ", ".join(profile.allowed_models)
                return CommandResult(message=f"모델 '{model_name}'은 프로필 '{active_profile}'에서 사용할 수 없습니다. 허용 모델: {allowed}")
            if model_name.lower() == "default":
                manager.update_profile(active_profile, last_model="")
                message = "모델을 기본값으로 되돌렸습니다."
            else:
                manager.update_profile(active_profile, last_model=model_name)
                message = f"모델을 {model_name}(으)로 설정했습니다."
            updated = load_settings()
            context.engine.set_model(updated.model)
            if context.app_state is not None:
                updated_profile = updated.resolve_profile()[1]
                context.app_state.set(model=display_model_setting(updated_profile))
            return CommandResult(message=message, refresh_runtime=True)
        return CommandResult(message="사용법: /model [show|MODEL]")

    async def _provider_handler(args: str, context: CommandContext) -> CommandResult:
        manager = AuthManager()
        profiles = manager.get_profile_statuses()
        tokens = args.split()
        if not tokens or tokens[0] == "show":
            active_name = manager.get_active_profile()
            active = profiles[active_name]
            lines = [
                f"활성 프로필: {active_name}",
                f"라벨: {active['label']}",
                f"프로바이더: {active['provider']}",
                f"인증 소스: {active['auth_source']}",
                f"설정됨: {'예' if active['configured'] else '아니요'}",
                f"기본 URL: {active['base_url'] or '(기본값)'}",
                f"모델: {active['model']}",
            ]
            return CommandResult(message="\n".join(lines))
        if tokens[0] == "list":
            lines = ["프로바이더 프로필:"]
            for name, info in profiles.items():
                marker = "*" if info["active"] else " "
                configured = "설정됨" if info["configured"] else "인증 없음"
                lines.append(f"{marker} {name} [{configured}] {info['label']} -> {info['model']}")
            return CommandResult(message="\n".join(lines))
        target = tokens[1] if tokens[0] == "use" and len(tokens) == 2 else (tokens[0] if len(tokens) == 1 else None)
        if target is None:
            return CommandResult(message="사용법: /provider [show|list|PROFILE]")
        manager.use_profile(target)
        updated = load_settings()
        profile = updated.resolve_profile()[1]
        context.engine.set_model(updated.model)
        if context.app_state is not None:
            context.app_state.set(
                model=display_model_setting(profile),
                provider=detect_provider(updated).name,
                active_profile=target,
                provider_label=profile.label,
                auth_status=auth_status(updated),
                base_url=updated.base_url or "",
            )
        return CommandResult(
            message=f"Switched provider profile to {target} ({profile.label}).",
            refresh_runtime=True,
        )

    async def _theme_handler(args: str, context: CommandContext) -> CommandResult:
        from myharness.themes import list_themes, load_theme

        settings = load_settings()
        tokens = args.split(maxsplit=1)
        current = (
            context.app_state.get().theme
            if context.app_state is not None and hasattr(context.app_state.get(), "theme")
            else settings.theme
        )

        if not tokens or tokens[0] == "show":
            try:
                theme = load_theme(current)
                lines = [
                    f"테마: {theme.name}",
                    f"  색상:  primary={theme.colors.primary}  secondary={theme.colors.secondary}"
                    f"  accent={theme.colors.accent}  error={theme.colors.error}"
                    f"  muted={theme.colors.muted}",
                    f"           background={theme.colors.background}  foreground={theme.colors.foreground}",
                    f"  테두리: style={theme.borders.style}",
                    f"  아이콘: spinner={theme.icons.spinner}  tool={theme.icons.tool}"
                    f"  error={theme.icons.error}  success={theme.icons.success}"
                    f"  agent={theme.icons.agent}",
                    f"  레이아웃: compact={theme.layout.compact}"
                    f"  show_tokens={theme.layout.show_tokens}"
                    f"  show_time={theme.layout.show_time}",
                ]
                return CommandResult(message="\n".join(lines))
            except KeyError:
                return CommandResult(message=f"테마: {current} (찾을 수 없음)")

        if tokens[0] == "list":
            available = list_themes()
            lines = [f"{'*' if name == current else ' '} {name}" for name in available]
            return CommandResult(message="\n".join(lines))

        if tokens[0] == "set" and len(tokens) == 2:
            name = tokens[1]
        elif len(tokens) == 1 and tokens[0] not in {"list", "preview"}:
            name = tokens[0]
        else:
            name = None
        if name is not None:
            try:
                load_theme(name)
            except KeyError:
                available = list_themes()
                return CommandResult(
                    message=f"알 수 없는 테마: {name!r}. 사용 가능: {', '.join(available)}"
                )
            settings.theme = name
            save_settings(settings)
            if context.app_state is not None:
                context.app_state.set(theme=name)
            return CommandResult(message=f"테마를 {name}(으)로 설정했습니다.")

        if tokens[0] == "preview" and len(tokens) == 2:
            name = tokens[1]
            try:
                theme = load_theme(name)
            except KeyError:
                available = list_themes()
                return CommandResult(
                    message=f"알 수 없는 테마: {name!r}. 사용 가능: {', '.join(available)}"
                )
            lines = [
                f"미리보기: {theme.name}",
                f"  primary    {theme.colors.primary}",
                f"  secondary  {theme.colors.secondary}",
                f"  accent     {theme.colors.accent}",
                f"  error      {theme.colors.error}",
                f"  muted      {theme.colors.muted}",
                f"  background {theme.colors.background}",
                f"  foreground {theme.colors.foreground}",
                f"  borders    {theme.borders.style}",
                f"  icons      spinner={theme.icons.spinner} tool={theme.icons.tool}"
                f" success={theme.icons.success} error={theme.icons.error}"
                f" agent={theme.icons.agent}",
            ]
            return CommandResult(message="\n".join(lines))

        return CommandResult(message="사용법: /theme [list|show|NAME|preview NAME]")

    async def _output_style_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        tokens = args.split(maxsplit=1)
        styles = load_output_styles()
        available = {style.name: style for style in styles}
        current = (
            context.app_state.get().output_style
            if context.app_state is not None
            else settings.output_style
        )
        if not tokens or tokens[0] == "show":
            return CommandResult(message=f"Output style: {current}")
        if tokens[0] == "list":
            return CommandResult(
                message="\n".join(f"{style.name} [{style.source}]" for style in styles)
            )
        if tokens[0] == "set" and len(tokens) == 2:
            style_name = tokens[1]
        elif len(tokens) == 1 and tokens[0] not in {"list"}:
            style_name = tokens[0]
        else:
            style_name = None
        if style_name is not None:
            if style_name not in available:
                return CommandResult(message=f"Unknown output style: {style_name}")
            settings.output_style = style_name
            save_settings(settings)
            if context.app_state is not None:
                context.app_state.set(output_style=style_name)
            return CommandResult(message=f"Output style set to {style_name}")
        return CommandResult(message="사용법: /output-style [show|list|NAME]")

    async def _keybindings_handler(_: str, context: CommandContext) -> CommandResult:
        from myharness.keybindings import get_keybindings_path, load_keybindings

        bindings = (
            context.app_state.get().keybindings
            if context.app_state is not None and context.app_state.get().keybindings
            else load_keybindings()
        )
        lines = [f"Keybindings file: {get_keybindings_path()}"]
        lines.extend(f"{key} -> {command}" for key, command in sorted(bindings.items()))
        return CommandResult(message="\n".join(lines))

    async def _vim_handler(args: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        current = (
            context.app_state.get().vim_enabled
            if context.app_state is not None
            else settings.vim_mode
        )
        action = args.strip() or "show"
        if action == "show":
            return CommandResult(message=f"Vim 모드: {'켜짐' if current else '꺼짐'}")
        enabled = {"on": True, "off": False, "toggle": not current}.get(action)
        if enabled is None:
            return CommandResult(message="사용법: /vim [show|on|off|toggle]")
        settings.vim_mode = enabled
        save_settings(settings)
        if context.app_state is not None:
            context.app_state.set(vim_enabled=enabled)
        return CommandResult(message=f"Vim 모드를 {'켰습니다' if enabled else '껐습니다'}.")

    async def _voice_handler(args: str, context: CommandContext) -> CommandResult:
        from myharness.voice import extract_keyterms, inspect_voice_capabilities

        settings = load_settings()
        diagnostics = inspect_voice_capabilities(detect_provider(settings))
        current = (
            context.app_state.get().voice_enabled
            if context.app_state is not None
            else settings.voice_mode
        )
        tokens = args.split(maxsplit=1)
        if not tokens or tokens[0] == "show":
            return CommandResult(
                message=(
                    f"음성 모드: {'켜짐' if current else '꺼짐'}\n"
                    f"Available: {'yes' if diagnostics.available else 'no'}\n"
                    f"Recorder: {diagnostics.recorder or '(none)'}\n"
                    f"Reason: {diagnostics.reason}"
                )
            )
        if tokens[0] == "keyterms" and len(tokens) == 2:
            keyterms = extract_keyterms(tokens[1])
            return CommandResult(message="\n".join(keyterms) if keyterms else "(no keyterms)")
        enabled = {"on": True, "off": False, "toggle": not current}.get(tokens[0])
        if enabled is None:
            return CommandResult(message="사용법: /voice [show|on|off|toggle|keyterms TEXT]")
        settings.voice_mode = enabled
        save_settings(settings)
        if context.app_state is not None:
            context.app_state.set(
                voice_enabled=enabled,
                voice_available=diagnostics.available,
                voice_reason=diagnostics.reason,
            )
        return CommandResult(message=f"음성 모드를 {'켰습니다' if enabled else '껐습니다'}.")

    async def _doctor_handler(_: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        manager = AuthManager(settings)
        active_profile_name, active_profile = settings.resolve_profile()
        memory_dir = get_project_memory_dir(context.cwd)
        state = context.app_state.get() if context.app_state is not None else None
        lines = [
            "진단 요약:",
            f"- cwd: {context.cwd}",
            f"- active_profile: {active_profile_name}",
            f"- model: {settings.model}",
            f"- provider_workflow: {active_profile.label}",
            f"- auth_source: {active_profile.auth_source}",
            f"- permission_mode: {state.permission_mode if state is not None else settings.permission.mode}",
            f"- theme: {state.theme if state is not None else settings.theme}",
            f"- output_style: {state.output_style if state is not None else settings.output_style}",
            f"- vim_mode: {'on' if (state.vim_enabled if state is not None else settings.vim_mode) else 'off'}",
            f"- voice_mode: {'on' if (state.voice_enabled if state is not None else settings.voice_mode) else 'off'}",
            f"- effort: {_effort_label(state.effort if state is not None else settings.effort)}",
            f"- passes: {state.passes if state is not None else settings.passes}",
            f"- memory_dir: {memory_dir}",
            f"- plugin_count: {max(len(context.plugin_summary.splitlines()) - 1, 0) if context.plugin_summary else 0}",
            f"- mcp_configured: {'yes' if context.mcp_summary and 'No MCP' not in context.mcp_summary and '설정된 MCP 서버가 없습니다' not in context.mcp_summary else 'no'}",
            f"- auth_configured: {'yes' if manager.get_profile_statuses()[active_profile_name]['configured'] else 'no'}",
        ]
        return CommandResult(message="\n".join(lines))

    async def _privacy_settings_handler(_: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        session_dir = context.session_backend.get_session_dir(context.cwd)
        lines = [
            "Privacy settings:",
            f"- user_config_dir: {get_config_dir()}",
            f"- project_config_dir: {get_project_config_dir(context.cwd)}",
            f"- session_dir: {session_dir}",
            f"- feedback_log: {get_feedback_log_path()}",
            f"- api_base_url: {settings.base_url or '(default Anthropic-compatible endpoint)'}",
            "- network: enabled only for provider and explicit web/MCP calls",
            "- storage: local files under ~/.myharness and project .myharness",
        ]
        return CommandResult(message="\n".join(lines))

    async def _rate_limit_options_handler(_: str, context: CommandContext) -> CommandResult:
        settings = load_settings()
        provider = "moonshot-compatible" if (settings.base_url and "moonshot" in settings.base_url) else "anthropic-compatible"
        lines = [
            "레이트 리밋 대응 옵션:",
            f"- provider: {provider}",
            "- 가벼운 요청에는 /passes를 줄이거나 /effort low로 전환하세요",
            "- 응답을 짧게 하고 도구 호출을 줄이려면 /fast를 켜세요",
            "- 긴 대화는 재시도 전에 /compact로 줄이세요",
            "- 오래 걸리는 로컬 작업은 백그라운드 /tasks를 우선 고려하세요",
        ]
        return CommandResult(message="\n".join(lines))

    async def _release_notes_handler(_: str, context: CommandContext) -> CommandResult:
        path = Path(context.cwd) / "RELEASE_NOTES.md"
        if path.exists():
            return CommandResult(message=path.read_text(encoding="utf-8"))
        return CommandResult(
            message=(
                "# 릴리스 노트\n\n"
                "- React TUI가 기본 `oh` 인터페이스입니다.\n"
                "- 세션, 파일, 브리지, 에이전트, 복사, 되감기, 추론 강도, 패스, 개인정보 명령을 보강했습니다.\n"
                "- 도구, MCP, 작업, 플러그인, 노트북, LSP, cron, worktree 흐름 전반의 실제 모델 검증을 확장했습니다.\n"
            )
        )

    async def _upgrade_handler(_: str, context: CommandContext) -> CommandResult:
        del context
        try:
            version = importlib.metadata.version("myharness")
        except importlib.metadata.PackageNotFoundError:
            version = "0.1.7"
        return CommandResult(
            message=(
                f"Current version: {version}\n"
                "Upgrade instructions:\n"
                "- uv sync --extra dev\n"
                "- uv pip install -e .\n"
                "- npm --prefix frontend/terminal install"
            )
        )

    async def _diff_handler(args: str, context: CommandContext) -> CommandResult:
        if args.strip() == "full":
            ok, output = _run_git_command(context.cwd, "diff", "HEAD")
            return CommandResult(message=output or "(no diff)")
        ok, output = _run_git_command(context.cwd, "diff", "--stat")
        if not ok:
            return CommandResult(message=output)
        return CommandResult(message=output or "(no diff)")

    async def _branch_handler(args: str, context: CommandContext) -> CommandResult:
        action = args.strip() or "show"
        if action == "show":
            ok, current = _run_git_command(context.cwd, "branch", "--show-current")
            if not ok:
                return CommandResult(message=current)
            return CommandResult(message=f"Current branch: {current or '(detached HEAD)'}")
        if action == "list":
            ok, branches = _run_git_command(context.cwd, "branch", "--format", "%(refname:short)")
            return CommandResult(message=branches if ok else branches)
        return CommandResult(message="사용법: /branch [show|list]")

    async def _commit_handler(args: str, context: CommandContext) -> CommandResult:
        message = args.strip()
        if not message:
            ok, status = _run_git_command(context.cwd, "status", "--short")
            return CommandResult(message=status if ok and status else "(working tree clean)")
        ok, status = _run_git_command(context.cwd, "status", "--short")
        if not ok:
            return CommandResult(message=status)
        if not status.strip():
            return CommandResult(message="Nothing to commit.")
        ok, output = _run_git_command(context.cwd, "add", "-A")
        if not ok:
            return CommandResult(message=output)
        ok, output = _run_git_command(context.cwd, "commit", "-m", message)
        return CommandResult(message=output if ok else output)

    async def _tasks_handler(args: str, context: CommandContext) -> CommandResult:
        manager = get_task_manager()
        tokens = args.split(maxsplit=2)
        if not tokens or tokens[0] == "list":
            tasks = manager.list_tasks()
            if not tasks:
                return CommandResult(message="No background tasks.")
            return CommandResult(
                message="\n".join(f"{task.id} {task.type} {task.status} {task.description}" for task in tasks)
            )
        if tokens[0] == "run" and len(tokens) >= 2:
            command = args[len("run ") :]
            task = await manager.create_shell_task(
                command=command,
                description=command[:80],
                cwd=context.cwd,
            )
            return CommandResult(message=f"작업을 시작했습니다: {task.id}")
        if tokens[0] == "stop" and len(tokens) == 2:
            task = await manager.stop_task(tokens[1])
            return CommandResult(message=f"작업을 중지했습니다: {task.id}")
        if tokens[0] == "show" and len(tokens) == 2:
            task = manager.get_task(tokens[1])
            if task is None:
                return CommandResult(message=f"작업을 찾을 수 없습니다: {tokens[1]}")
            return CommandResult(message=str(task))
        if tokens[0] == "update" and len(tokens) == 3:
            task_id = tokens[1]
            rest = tokens[2]
            field, _, value = rest.partition(" ")
            if not value.strip():
                return CommandResult(
                    message="사용법: /tasks update ID [description TEXT|progress NUMBER|note TEXT]"
                )
            try:
                if field == "description":
                    task = manager.update_task(task_id, description=value)
                    return CommandResult(message=f"작업 설명을 업데이트했습니다: {task.id}")
                if field == "progress":
                    try:
                        progress = int(value)
                    except ValueError:
                        return CommandResult(message="진행률은 0부터 100 사이의 정수여야 합니다.")
                    task = manager.update_task(task_id, progress=progress)
                    return CommandResult(message=f"작업 {task.id} 진행률을 {progress}%로 업데이트했습니다.")
                if field == "note":
                    task = manager.update_task(task_id, status_note=value)
                    return CommandResult(message=f"작업 메모를 업데이트했습니다: {task.id}")
            except ValueError as exc:
                return CommandResult(message=str(exc))
            return CommandResult(
                message="사용법: /tasks update ID [description TEXT|progress NUMBER|note TEXT]"
            )
        if tokens[0] == "output" and len(tokens) == 2:
            return CommandResult(message=manager.read_task_output(tokens[1]) or "(출력 없음)")
        return CommandResult(
            message=(
                "사용법: /tasks "
                "[list|run CMD|stop ID|show ID|update ID description TEXT|update ID progress NUMBER|update ID note TEXT|output ID]"
            )
        )

    registry.register(SlashCommand("help", "사용 가능한 명령어를 보여줍니다", _help_handler))
    registry.register(
        SlashCommand("exit", "MyHarness를 종료합니다", _exit_handler, aliases=("quit",))
    )
    registry.register(SlashCommand("clear", "현재 대화 기록을 지웁니다", _clear_handler))
    registry.register(SlashCommand("version", "설치된 MyHarness 버전을 보여줍니다", _version_handler))
    registry.register(SlashCommand("status", "세션 상태를 보여줍니다", _status_handler))
    registry.register(SlashCommand("context", "현재 런타임 시스템 프롬프트를 보여줍니다", _context_handler))
    registry.register(SlashCommand("summary", "대화 기록을 요약합니다", _summary_handler))
    registry.register(SlashCommand("compact", "오래된 대화 기록을 압축합니다", _compact_handler))
    registry.register(SlashCommand("cost", "토큰 사용량과 예상 비용을 보여줍니다", _cost_handler))
    registry.register(SlashCommand("usage", "사용량과 토큰 추정치를 보여줍니다", _usage_handler))
    registry.register(SlashCommand("stats", "세션 통계를 보여줍니다", _stats_handler))
    registry.register(SlashCommand("memory", "프로젝트 메모리를 확인하고 관리합니다", _memory_handler))
    registry.register(SlashCommand("hooks", "설정된 훅을 보여줍니다", _hooks_handler))
    registry.register(SlashCommand("resume", "최근 저장된 세션을 복원합니다", _resume_handler))
    registry.register(SlashCommand("session", "현재 세션 저장 정보를 확인합니다", _session_handler))
    registry.register(SlashCommand("export", "현재 대화 기록을 내보냅니다", _export_handler))
    registry.register(SlashCommand("share", "공유 가능한 대화 스냅샷을 만듭니다", _share_handler))
    registry.register(SlashCommand("copy", "최근 응답이나 입력한 텍스트를 복사합니다", _copy_handler))
    registry.register(SlashCommand("tag", "현재 세션의 이름 있는 스냅샷을 만듭니다", _tag_handler))
    registry.register(SlashCommand("rewind", "최근 대화 턴을 되돌립니다", _rewind_handler))
    registry.register(SlashCommand("files", "현재 작업공간의 파일을 나열합니다", _files_handler))
    registry.register(SlashCommand("init", "프로젝트 MyHarness 파일을 초기화합니다", _init_handler))
    registry.register(SlashCommand("bridge", "브리지 헬퍼와 브리지 세션을 확인합니다", _bridge_handler))
    registry.register(SlashCommand("login", "인증 상태를 보거나 현재 세션 환경변수에 API 키를 싣습니다", _login_handler))
    registry.register(SlashCommand("logout", "저장된 API 키와 현재 세션 인증 환경변수를 지웁니다", _logout_handler))
    registry.register(SlashCommand("feedback", "CLI 피드백을 로컬 로그에 저장합니다", _feedback_handler))
    registry.register(SlashCommand("onboarding", "빠른 시작 안내를 보여줍니다", _onboarding_handler))
    registry.register(SlashCommand("skills", "사용 가능한 스킬을 보거나 자세히 확인합니다", _skills_handler))
    registry.register(
        SlashCommand(
            "learned-skills",
            "자동 학습 스킬을 보거나 켜고 끕니다",
            _learned_skills_handler,
        )
    )
    registry.register(SlashCommand("config", "설정을 보거나 변경합니다", _config_handler))
    registry.register(SlashCommand("mcp", "MCP 서버를 나열하거나 켜고 끕니다", _mcp_handler))
    registry.register(
        SlashCommand(
            "plugin",
            "플러그인을 관리합니다",
            _plugin_handler,
            remote_invocable=False,
            remote_admin_opt_in=True,
        )
    )
    registry.register(
        SlashCommand(
            "reload-plugins",
            "이 작업공간의 플러그인 검색을 다시 실행합니다",
            _reload_plugins_handler,
            remote_invocable=False,
            remote_admin_opt_in=True,
        )
    )
    registry.register(
        SlashCommand(
            "permissions",
            "권한 모드를 보거나 변경합니다",
            _permissions_handler,
            remote_invocable=False,
            remote_admin_opt_in=True,
        )
    )
    registry.register(
        SlashCommand(
            "plan",
            "계획 권한 모드를 켜거나 끕니다",
            _plan_handler,
            remote_invocable=False,
            remote_admin_opt_in=True,
        )
    )
    registry.register(SlashCommand("fast", "빠른 모드를 보거나 변경합니다", _fast_handler))
    registry.register(SlashCommand("effort", "추론 강도를 보거나 변경합니다", _effort_handler))
    registry.register(SlashCommand("passes", "추론 반복 횟수를 보거나 변경합니다", _passes_handler))
    registry.register(SlashCommand("turns", "최대 에이전트 턴 수를 보거나 변경합니다", _turns_handler))
    registry.register(SlashCommand("continue", "중단된 이전 도구 루프를 이어서 실행합니다", _continue_handler))
    registry.register(SlashCommand("provider", "프로바이더 프로필을 보거나 전환합니다", _provider_handler))
    registry.register(SlashCommand("model", "기본 모델을 보거나 변경합니다", _model_handler))
    registry.register(SlashCommand("theme", "TUI 테마를 나열, 설정, 표시 또는 미리보기합니다", _theme_handler))
    registry.register(SlashCommand("output-style", "출력 스타일을 보거나 변경합니다", _output_style_handler))
    registry.register(SlashCommand("keybindings", "적용된 키 바인딩을 보여줍니다", _keybindings_handler))
    registry.register(SlashCommand("vim", "Vim 모드를 보거나 변경합니다", _vim_handler))
    registry.register(SlashCommand("voice", "음성 모드를 보거나 변경합니다", _voice_handler))
    registry.register(SlashCommand("doctor", "환경 진단 정보를 보여줍니다", _doctor_handler))
    registry.register(SlashCommand("diff", "Git diff 출력을 보여줍니다", _diff_handler))
    registry.register(SlashCommand("branch", "Git 브랜치 정보를 보여줍니다", _branch_handler))
    registry.register(SlashCommand("commit", "Git 상태를 보거나 커밋을 생성합니다", _commit_handler))
    registry.register(SlashCommand("issue", "프로젝트 이슈 컨텍스트를 보거나 변경합니다", _issue_handler))
    registry.register(SlashCommand("pr_comments", "PR 코멘트 컨텍스트를 보거나 변경합니다", _pr_comments_handler))
    registry.register(SlashCommand("privacy-settings", "로컬 개인정보와 저장 설정을 보여줍니다", _privacy_settings_handler))
    registry.register(SlashCommand("rate-limit-options", "요청 제한 부담을 줄이는 방법을 보여줍니다", _rate_limit_options_handler))
    registry.register(SlashCommand("release-notes", "최근 MyHarness 릴리스 노트를 보여줍니다", _release_notes_handler))
    registry.register(SlashCommand("upgrade", "업그레이드 안내를 보여줍니다", _upgrade_handler))
    registry.register(SlashCommand("agents", "에이전트와 팀 작업을 나열하거나 확인합니다", _agents_handler))
    registry.register(SlashCommand("subagents", "서브에이전트 사용량과 작업자 태스크를 확인합니다", _agents_handler))
    registry.register(SlashCommand("tasks", "백그라운드 작업을 관리합니다", _tasks_handler))
    for command in [*_create_autopilot_commands(), *_create_repo_commands()]:
        registry.register(command)

    for plugin_command in plugin_commands or ():
        if not plugin_command.user_invocable:
            continue

        async def _plugin_command_handler(
            args: str,
            context: CommandContext,
            *,
            command: PluginCommandDefinition = plugin_command,
        ) -> CommandResult:
            prompt = _render_plugin_command_prompt(
                command,
                args,
                getattr(context, "session_id", None),
            )
            if command.disable_model_invocation:
                return CommandResult(message=prompt)
            return CommandResult(
                submit_prompt=prompt,
                submit_model=command.model,
            )

        registry.register(
            SlashCommand(
                plugin_command.name,
                plugin_command.description,
                _plugin_command_handler,
            )
        )
    return registry


def _resolve_memory_entry_path(memory_dir: Path, candidate: str) -> tuple[Path | None, bool]:
    """Resolve a memory entry path while enforcing containment under ``memory_dir``."""

    base = memory_dir.resolve()
    resolved, invalid = _resolve_memory_candidate(base, candidate)
    if invalid:
        return None, True
    if resolved is not None and resolved.exists():
        return resolved, False
    fallback, invalid = _resolve_memory_candidate(base, f"{candidate}.md")
    if invalid:
        return None, True
    if fallback is not None and fallback.exists():
        return fallback, False
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", candidate.strip().lower()).strip("_")
    if slug and slug != candidate:
        slugged, invalid = _resolve_memory_candidate(base, f"{slug}.md")
        if invalid:
            return None, True
        if slugged is not None and slugged.exists():
            return slugged, False
    return None, False


def _resolve_memory_candidate(memory_dir: Path, candidate: str) -> tuple[Path | None, bool]:
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = memory_dir / path
    resolved = path.resolve()
    try:
        resolved.relative_to(memory_dir)
    except ValueError:
        return None, True
    return resolved, False

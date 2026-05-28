"""Promote verified repeated mistakes into small local skills."""

from __future__ import annotations

import hashlib
import re
import textwrap
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from myharness.skills.loader import get_program_skills_dirs

MAX_TRACKED_FAILURES = 20
MAX_TRACKED_LEARNED_SKILLS = 12
MAX_EVIDENCE_BLOCKS_PER_SKILL = 8
YOUTUBE_TRANSCRIPT_SIGNATURE = "youtube-transcript-yt-dlp"

_SECRET_PATTERNS = (
    re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b"),
)


@dataclass(frozen=True)
class LearningCandidate:
    """One repeated mistake ready to become or update a skill."""

    skill_name: str
    trigger_description: str
    lesson: str
    do_next_time: str
    avoid_next_time: str
    evidence_hash: str
    confidence: float
    failure_signature: str


@dataclass(frozen=True)
class LearningResult:
    """Persistence result for an automatic learning pass."""

    candidate: LearningCandidate
    skill_path: Path
    action: str


def get_default_learning_skills_dir() -> Path:
    """Return the program-local ``.skills`` directory used for learned skills."""

    program_dirs = get_program_skills_dirs()
    if program_dirs:
        return program_dirs[0]
    package_dir = Path(__file__).resolve().parents[1]
    for ancestor in package_dir.parents:
        if (ancestor / "pyproject.toml").exists() and (ancestor / "src" / "myharness").exists():
            return ancestor / ".skills"
    return package_dir.parent / ".skills"


def remember_tool_failure(
    metadata: dict[str, object] | None,
    *,
    tool_name: str,
    tool_input: dict[str, object],
    tool_output: str,
) -> None:
    """Store a compact, redacted failure signature for later learning."""

    if metadata is None:
        return
    failures = metadata.setdefault("recent_tool_failures", [])
    if not isinstance(failures, list):
        failures = []
        metadata["recent_tool_failures"] = failures
    signature = _failure_signature(tool_name, tool_input, tool_output)
    summary = _failure_summary(tool_name, tool_input, tool_output)
    failures.append(
        {
            "signature": signature,
            "category": _failure_category(tool_name),
            "tool": _redact(tool_name)[:80],
            "summary": _redact(summary)[:320],
        }
    )
    if len(failures) > MAX_TRACKED_FAILURES:
        del failures[:-MAX_TRACKED_FAILURES]


def analyze_learning_candidate(metadata: dict[str, object] | None) -> LearningCandidate | None:
    """Return a skill candidate when a repeated failure was followed by verification."""

    if not isinstance(metadata, dict):
        return None
    failures = metadata.get("recent_tool_failures")
    verified_work = metadata.get("recent_verified_work")
    if not isinstance(failures, list) or not isinstance(verified_work, list) or not verified_work:
        return None
    verified_summary = _latest_helpful_verified_work(verified_work)
    if verified_summary is None:
        return None

    failure_items = [item for item in failures if isinstance(item, dict)]
    signatures = [str(item.get("signature") or "").strip() for item in failure_items]
    signature_counts = Counter(signature for signature in signatures if signature)
    repeated = [(signature, count) for signature, count in signature_counts.items() if count >= 2]
    if not repeated:
        return None

    signature, count = sorted(repeated, key=lambda item: (-item[1], item[0]))[0]
    matching = [
        item for item in failure_items if str(item.get("signature") or "").strip() == signature
    ]
    summary = str(matching[-1].get("summary") or signature).strip()
    evidence_hash = hashlib.sha256(
        "\n".join([signature, summary, verified_summary]).encode("utf-8")
    ).hexdigest()[:16]
    slug = _slugify(f"learned-{signature}")[:60]
    confidence = min(0.95, 0.65 + (count * 0.1))
    specialized = _specialized_candidate(
        signature=signature,
        summary=summary,
        verified_summary=verified_summary,
        evidence_hash=evidence_hash,
        confidence=confidence,
    )
    if specialized is not None:
        return specialized

    return LearningCandidate(
        skill_name=slug,
        trigger_description=(
            "Use when MyHarness sees this repeated verified failure pattern: "
            f"{_redact(summary)[:160]}"
        ),
        lesson=f"A repeated failure was observed and later verified as resolved: {_redact(summary)[:220]}",
        do_next_time=f"Start by applying the verified corrective path: {verified_summary}",
        avoid_next_time=(
            "Do not repeat the failing command, tool input, or assumption "
            "without checking the verified fix first."
        ),
        evidence_hash=evidence_hash,
        confidence=confidence,
        failure_signature=signature,
    )


def run_auto_skill_learning(
    metadata: dict[str, object] | None,
    *,
    enabled: bool = True,
    skills_dir: Path | None = None,
) -> LearningResult | None:
    """Analyze metadata and persist a learned skill when the gate passes."""

    if not enabled or metadata is None:
        return None
    candidate = analyze_learning_candidate(metadata)
    if candidate is None:
        return None
    result = persist_learning_candidate(candidate, skills_dir=skills_dir)
    _remember_learning_result(metadata, result)
    return result


def persist_learning_candidate(
    candidate: LearningCandidate,
    *,
    skills_dir: Path | None = None,
) -> LearningResult:
    """Create or update the program-local skill for a candidate."""

    root = (skills_dir or get_default_learning_skills_dir()).resolve()
    skill_dir = _select_learning_skill_dir(root, candidate)
    skill_file = skill_dir / "SKILL.md"
    patterns_file = skill_dir / "references" / "learned-patterns.md"
    existing_patterns = patterns_file.read_text(encoding="utf-8") if patterns_file.exists() else ""
    if candidate.evidence_hash in existing_patterns or _has_duplicate_pattern(
        existing_patterns, candidate
    ):
        return LearningResult(candidate=candidate, skill_path=skill_file, action="unchanged")

    skill_dir.mkdir(parents=True, exist_ok=True)
    patterns_file.parent.mkdir(parents=True, exist_ok=True)
    if not skill_file.exists():
        skill_file.write_text(_render_skill(candidate), encoding="utf-8")
        action = "created"
    else:
        action = "updated"
    patterns_file.write_text(
        _prune_evidence_blocks(existing_patterns + _render_pattern(candidate)),
        encoding="utf-8",
        newline="\n",
    )
    return LearningResult(candidate=candidate, skill_path=skill_file, action=action)


def _remember_learning_result(metadata: dict[str, object], result: LearningResult) -> None:
    learned = metadata.setdefault("recent_learned_skills", [])
    if not isinstance(learned, list):
        learned = []
        metadata["recent_learned_skills"] = learned
    entry = {
        "skill": result.skill_path.parent.name,
        "action": result.action,
        "evidence_hash": result.candidate.evidence_hash,
        "summary": result.candidate.lesson[:240],
        "path": str(result.skill_path),
    }
    learned[:] = [
        item
        for item in learned
        if not isinstance(item, dict) or item.get("evidence_hash") != result.candidate.evidence_hash
    ]
    learned.append(entry)
    if len(learned) > MAX_TRACKED_LEARNED_SKILLS:
        del learned[:-MAX_TRACKED_LEARNED_SKILLS]


def _render_skill(candidate: LearningCandidate) -> str:
    return (
        "---\n"
        f"name: {candidate.skill_name}\n"
        f"description: >\n{_indent_wrapped(candidate.trigger_description)}\n"
        "---\n\n"
        f"# {candidate.skill_name}\n\n"
        "This skill was generated automatically from a repeated, verified MyHarness failure pattern.\n\n"
        "## Generalization Rules\n"
        "- Treat stored evidence as examples, not as the only trigger.\n"
        "- Before creating another `learned-*` skill, inspect existing `learned-*` "
        "skills and update or merge into a broader one when it fits.\n"
        "- Prefer reusable failure classes such as platform, tool, status code, file type, or workflow step over exact URLs, paths, prompts, or IDs.\n"
        "- Reuse an existing helper script, skill, API route, or validator before assembling a new one-off command.\n"
        "- If the verified work is only inspection and not a real corrective path, treat the lesson as low-confidence and diagnose first.\n\n"
        "## When To Use\n"
        f"- {candidate.trigger_description}\n\n"
        "## Process\n"
        "1. Read `references/learned-patterns.md` for the concrete observed pattern.\n"
        "2. Apply the verified corrective path before retrying the failed approach.\n"
        "3. Keep new evidence concise and avoid storing raw transcripts or secrets.\n"
        "\n## Recommended Next Step\n"
        f"- {candidate.do_next_time}\n"
        "\n## Avoid\n"
        f"- {candidate.avoid_next_time}\n"
    )


def _select_learning_skill_dir(root: Path, candidate: LearningCandidate) -> Path:
    exact_dir = root / candidate.skill_name
    if (exact_dir / "SKILL.md").exists():
        return exact_dir

    preferred_name = _preferred_existing_learned_skill_name(candidate)
    if preferred_name:
        preferred_dir = root / preferred_name
        if (preferred_dir / "SKILL.md").exists():
            return preferred_dir

    compatible_dir = _find_compatible_existing_learned_skill(root, candidate)
    if compatible_dir is not None:
        return compatible_dir

    return exact_dir


def _preferred_existing_learned_skill_name(candidate: LearningCandidate) -> str | None:
    signature = candidate.failure_signature
    skill_name = candidate.skill_name
    if (
        signature.startswith(("web-fetch-", "web-search-"))
        or skill_name.startswith(("learned-web-fetch-", "learned-web-search-"))
    ):
        return "learned-web-research-recovery"
    if (
        signature == YOUTUBE_TRANSCRIPT_SIGNATURE
        or skill_name.startswith("learned-cmd-")
        or skill_name.startswith("learned-category-bash")
        or signature.startswith(("cmd-", "bash-", "shell-", "npm-", "python-", "yt-dlp-"))
    ):
        return "learned-command-failures"
    return None


def _find_compatible_existing_learned_skill(
    root: Path,
    candidate: LearningCandidate,
) -> Path | None:
    if not root.exists():
        return None
    category = _candidate_learning_category(candidate)
    if category is None:
        return None
    for skill_dir in sorted(root.glob("learned-*")):
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue
        text = _redact(skill_file.read_text(encoding="utf-8", errors="replace").lower())
        if category == "web" and any(
            keyword in text
            for keyword in ("web search", "web_search", "web fetch", "web_fetch", "source-backed")
        ):
            return skill_dir
        if category == "command" and any(
            keyword in text
            for keyword in ("command", "shell", "cmd", "npm", "python", "yt-dlp", "test command")
        ):
            return skill_dir
    return None


def _candidate_learning_category(candidate: LearningCandidate) -> str | None:
    signature = candidate.failure_signature
    skill_name = candidate.skill_name
    if signature.startswith(("web-fetch-", "web-search-")) or skill_name.startswith(
        ("learned-web-fetch-", "learned-web-search-")
    ):
        return "web"
    if (
        signature == YOUTUBE_TRANSCRIPT_SIGNATURE
        or skill_name.startswith(("learned-cmd-", "learned-category-bash"))
        or signature.startswith(("cmd-", "bash-", "shell-", "npm-", "python-", "yt-dlp-"))
    ):
        return "command"
    return None


def _render_pattern(candidate: LearningCandidate) -> str:
    return (
        f"\n## Evidence {candidate.evidence_hash}\n"
        f"- Confidence: {candidate.confidence:.2f}\n"
        f"- Signature: `{candidate.failure_signature}`\n"
        f"- Lesson: {candidate.lesson}\n"
        f"- Do next time: {candidate.do_next_time}\n"
        f"- Avoid next time: {candidate.avoid_next_time}\n"
    )


def _failure_signature(tool_name: str, tool_input: dict[str, object], output: str) -> str:
    normalized = _normalized_failure_signature(tool_name, tool_input, output)
    if normalized:
        return normalized
    input_hint = ""
    for key in ("command", "path", "file_path", "pattern", "name", "url", "query"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            input_hint = value.strip()
            break
    first_line = next((line.strip() for line in output.splitlines() if line.strip()), "")
    raw = "|".join([tool_name.strip().lower(), input_hint[:120].lower(), first_line[:120].lower()])
    return _slugify(_redact(raw))[:80]


def _failure_summary(tool_name: str, tool_input: dict[str, object], output: str) -> str:
    input_hint = ""
    for key in ("command", "path", "file_path", "pattern", "name", "url", "query"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            input_hint = f" input={value.strip()[:160]}"
            break
    first_line = next((line.strip() for line in output.splitlines() if line.strip()), "tool failed")
    return f"{tool_name}{input_hint}: {first_line[:180]}"


def _failure_category(tool_name: str) -> str:
    return _slugify(tool_name.strip().lower() or "tool")


def _slugify(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned or "learned-skill"


def _normalized_failure_signature(
    tool_name: str,
    tool_input: dict[str, object],
    output: str,
) -> str | None:
    tool_slug = _slugify(tool_name.strip().lower())
    normalized_output = " ".join(output.lower().split())
    command = str(tool_input.get("command") or "").lower()
    if "yt-dlp" in command and _contains_youtube_url(command):
        return YOUTUBE_TRANSCRIPT_SIGNATURE
    if tool_slug == "web-search" and (
        "no search results found" in normalized_output
        or "검색 결과가 없습니다" in normalized_output
    ):
        return "web-search-no-results"

    if tool_slug in {"web-fetch", "web-search"}:
        status = _extract_http_status(output)
        domain = _extract_domain(tool_input, output)
        if status and domain:
            return f"{tool_slug}-{status}-{_slugify(domain)}"[:80]
    return None


def _contains_youtube_url(value: str) -> bool:
    return "youtube.com/" in value or "youtu.be/" in value


def _specialized_candidate(
    *,
    signature: str,
    summary: str,
    verified_summary: str,
    evidence_hash: str,
    confidence: float,
) -> LearningCandidate | None:
    if signature != YOUTUBE_TRANSCRIPT_SIGNATURE:
        return None
    return LearningCandidate(
        skill_name="learned-youtube-transcript-yt-dlp",
        trigger_description=(
            "Use when a YouTube link needs transcript/subtitle extraction or a yt-dlp "
            "YouTube subtitle command failed."
        ),
        lesson=(
            "Repeated one-off yt-dlp/Python command assembly for YouTube transcripts "
            f"was observed and then resolved. Last failure: {_redact(summary)[:180]}"
        ),
        do_next_time=(
            "Run the reusable helper first: "
            'python .skills/insane-search/scripts/youtube_transcript.py "URL" --json. '
            f"Verified path: {verified_summary}"
        ),
        avoid_next_time=(
            "Do not rebuild a long yt-dlp plus inline Python command for each YouTube URL "
            "unless the reusable helper itself fails."
        ),
        evidence_hash=evidence_hash,
        confidence=confidence,
        failure_signature=signature,
    )


def _extract_http_status(output: str) -> str | None:
    match = re.search(r"Client error ['\"]?(\d{3})\b", output, flags=re.IGNORECASE)
    return match.group(1) if match else None


def _extract_domain(tool_input: dict[str, object], output: str) -> str | None:
    candidates: list[str] = []
    for key in ("url", "uri", "href"):
        value = tool_input.get(key)
        if isinstance(value, str):
            candidates.append(value)
    candidates.extend(re.findall(r"https?://[^\s'\"\)]+", output))
    for candidate in candidates:
        parsed = urlparse(candidate.rstrip(".,;"))
        if parsed.hostname:
            return parsed.hostname.lower().removeprefix("www.")
    return None


def _latest_helpful_verified_work(verified_work: list[object]) -> str | None:
    for item in reversed(verified_work):
        summary = _redact(str(item))[:240]
        if summary and _is_helpful_verified_work(summary):
            return summary
    return None


def _is_helpful_verified_work(summary: str) -> bool:
    normalized = " ".join(summary.lower().split())
    if not normalized:
        return False
    if normalized.startswith(
        ("inspected file ", "checked repository matches ", "expanded glob pattern ")
    ):
        return False
    if normalized.startswith("ran command "):
        command = normalized.removeprefix("ran command ").strip()
        return not command.startswith(("cp ", "copy ", "grep ", "rg "))
    return True


def _has_duplicate_pattern(existing_patterns: str, candidate: LearningCandidate) -> bool:
    for block in _evidence_blocks(existing_patterns):
        if (
            f"- Signature: `{candidate.failure_signature}`" in block
            and f"- Lesson: {candidate.lesson}" in block
        ):
            return True
    return False


def _prune_evidence_blocks(patterns: str) -> str:
    blocks = _evidence_blocks(patterns)
    kept = blocks[-MAX_EVIDENCE_BLOCKS_PER_SKILL:]
    return "\n\n".join(kept).strip() + "\n"


def _evidence_blocks(patterns: str) -> list[str]:
    cleaned = patterns.strip()
    if not cleaned:
        return []
    return [block.strip() for block in re.split(r"\n(?=## Evidence )", cleaned) if block.strip()]


def _redact(value: str) -> str:
    text = value
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED_SECRET]", text)
    text = re.sub(r"C:\\Users\\[^\\\s]+", r"C:\\Users\\[USER]", text, flags=re.IGNORECASE)
    text = re.sub(r"/home/[^/\s]+", "/home/[USER]", text)
    return " ".join(text.split())


def _indent_wrapped(value: str) -> str:
    lines = textwrap.wrap(value.strip(), width=88) or [""]
    return "\n".join(f"  {line}" for line in lines)

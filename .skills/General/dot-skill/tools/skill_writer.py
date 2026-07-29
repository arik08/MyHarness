#!/usr/bin/env python3
"""Write and update dot-skill generated artifacts in English."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Optional

from skill_presets import (
    get_character_preset,
    normalize_character,
    normalize_research_profile,
    resolve_existing_storage_root,
    resolve_storage_root,
)
from skill_schema import (
    PRIMARY_ARTIFACTS,
    build_identity_string,
    build_manifest,
    enrich_skill_meta,
    now_iso,
    sync_legacy_fields,
)

SKILL_MD_TEMPLATE = """\
---
name: {combined_name}
description: {description}
user-invocable: true
---

# {display_name}

{identity}

---

## PART A: Work

{work_content}

---

## PART B: Persona

{persona_content}

---

## Operating Rules

When any task or question arrives:

1. Start with PART B: decide whether this model would take the task and what posture it would use.
2. Execute with PART A: use the work methods, heuristics, and capability profile to do the task.
3. Preserve PART B in the response: keep the persona's tone, pacing, and boundaries.

Layer 0 rules in PART B always take priority and must never be violated.
"""


def slugify(name: str) -> str:
    """Convert a human-readable English name into a stable slug."""
    slug = re.sub(r"[^a-z0-9_-]+", "_", name.lower()).strip("_")
    slug = re.sub(r"_+", "_", slug)
    return slug or "person"


def render_combined_skill(meta: dict, work_content: str, persona_content: str) -> str:
    """Render the combined SKILL.md file from normalized metadata."""
    artifacts = meta["artifacts"]
    identity = build_identity_string(meta)
    description = meta.get("summary") or (
        f"{meta['display_name']}, {identity}" if identity else meta["display_name"]
    )
    return SKILL_MD_TEMPLATE.format(
        combined_name=artifacts["combined_name"],
        description=description,
        display_name=meta["display_name"],
        identity=identity,
        work_content=work_content,
        persona_content=persona_content,
    )


def render_work_skill(meta: dict, work_content: str) -> str:
    """Render the work-only skill artifact."""
    artifacts = meta["artifacts"]
    description = f"{meta['display_name']} work capability only, without persona."
    return (
        f"---\nname: {artifacts['work_name']}\n"
        f"description: {description}\n"
        f"user-invocable: true\n---\n\n{work_content}\n"
    )


def render_persona_skill(meta: dict, persona_content: str) -> str:
    """Render the persona-only skill artifact."""
    artifacts = meta["artifacts"]
    description = f"{meta['display_name']} persona only, without work capability."
    return (
        f"---\nname: {artifacts['persona_name']}\n"
        f"description: {description}\n"
        f"user-invocable: true\n---\n\n{persona_content}\n"
    )


def write_artifacts(skill_dir: Path, meta: dict, work_content: str, persona_content: str) -> None:
    """Write all generated artifacts for a skill version."""
    artifacts = meta["artifacts"]
    manifest = build_manifest(meta)
    (skill_dir / artifacts["work_doc"]).write_text(work_content, encoding="utf-8")
    (skill_dir / artifacts["persona_doc"]).write_text(persona_content, encoding="utf-8")
    (skill_dir / artifacts["combined_skill"]).write_text(
        render_combined_skill(meta, work_content, persona_content), encoding="utf-8"
    )
    (skill_dir / artifacts["work_skill"]).write_text(render_work_skill(meta, work_content), encoding="utf-8")
    (skill_dir / artifacts["persona_skill"]).write_text(render_persona_skill(meta, persona_content), encoding="utf-8")
    (skill_dir / artifacts["manifest"]).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (skill_dir / "meta.json").write_text(json.dumps(sync_legacy_fields(meta), ensure_ascii=False, indent=2), encoding="utf-8")


def create_skill(base_dir: Path, slug: str, meta: dict, work_content: str, persona_content: str) -> Path:
    """Create a new generated skill directory."""
    normalized_meta = enrich_skill_meta(meta, slug, meta.get("character"))
    preset = get_character_preset(normalized_meta["character"])
    skill_dir = base_dir / slug
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "versions").mkdir(exist_ok=True)
    for relative_path in preset.get("knowledge_dirs", ("docs", "messages", "emails")):
        (skill_dir / "knowledge" / relative_path).mkdir(parents=True, exist_ok=True)
    normalized_meta["lifecycle"]["created_at"] = normalized_meta.get("created_at", now_iso())
    normalized_meta["lifecycle"]["updated_at"] = normalized_meta["lifecycle"]["created_at"]
    normalized_meta["lifecycle"]["version"] = "v1"
    normalized_meta["generation"]["corrections_count"] = normalized_meta.get("corrections_count", 0)
    sync_legacy_fields(normalized_meta)
    write_artifacts(skill_dir, normalized_meta, work_content, persona_content)
    return skill_dir


def backup_current_artifacts(skill_dir: Path, version_name: str) -> None:
    """Copy current artifacts into versions/<version_name>."""
    version_dir = skill_dir / "versions" / version_name
    version_dir.mkdir(parents=True, exist_ok=True)
    for filename in PRIMARY_ARTIFACTS:
        src = skill_dir / filename
        if src.exists():
            shutil.copy2(src, version_dir / filename)


SECTION_HEADING_RE = re.compile(r"^##\s+.+$", re.MULTILINE)


def merge_markdown_patch(existing_content: str, patch_content: str) -> str:
    """Replace matching level-2 sections; append unmatched sections."""
    matches = list(SECTION_HEADING_RE.finditer(patch_content))
    if not matches:
        return existing_content + ("\n\n" if existing_content else "") + patch_content
    merged = existing_content
    replaced_any = False
    for index, match in enumerate(matches):
        heading = match.group(0)
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(patch_content)
        patch_section = patch_content[start:end].strip()
        section_match = re.search(rf"(?m)^{re.escape(heading)}\s*$", merged)
        if not section_match:
            merged = merged.rstrip() + "\n\n" + patch_section
            continue
        replaced_any = True
        section_start = section_match.start()
        next_section = re.search(r"(?m)^##\s+.+$", merged[section_match.end():])
        section_end = section_match.end() + next_section.start() if next_section else len(merged)
        merged = merged[:section_start].rstrip() + "\n\n" + patch_section + "\n\n" + merged[section_end:].lstrip()
    return (merged.strip() + "\n") if replaced_any else merged


def apply_correction(persona_content: str, correction: dict) -> str:
    """Append a normalized correction entry to persona content."""
    scene = correction.get("scene", "general")
    correction_line = f"\n- [{scene}] should not {correction['wrong']}; should {correction['correct']}"
    target = "## Correction Log"
    if target in persona_content:
        insert_pos = persona_content.index(target) + len(target)
        rest = persona_content[insert_pos:]
        placeholder = "\n\n(No entries yet)"
        if rest.startswith(placeholder):
            rest = rest[len(placeholder):]
        return persona_content[:insert_pos] + correction_line + rest
    return persona_content + f"\n\n## Correction Log\n{correction_line}\n"


def normalize_corrections(correction: dict | list[dict] | None) -> list[dict]:
    """Normalize a correction payload into a flat list."""
    if not correction:
        return []
    if isinstance(correction, list):
        return [item for item in correction if isinstance(item, dict) and {"wrong", "correct"} <= item.keys()]
    if isinstance(correction, dict):
        if {"wrong", "correct"} <= correction.keys():
            return [correction]
        for key in ("persona_corrections", "corrections"):
            value = correction.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict) and {"wrong", "correct"} <= item.keys()]
    return []


def update_skill(skill_dir: Path, work_patch: Optional[str] = None, persona_patch: Optional[str] = None, correction: Optional[dict | list[dict]] = None) -> str:
    """Update an existing skill, archive the previous version, and regenerate artifacts."""
    meta_path = skill_dir / "meta.json"
    meta = enrich_skill_meta(json.loads(meta_path.read_text(encoding="utf-8")), skill_dir.name)
    current_version = meta.get("version", "v1")
    try:
        version_num = int(current_version.lstrip("v").split("_")[0]) + 1
    except ValueError:
        version_num = 2
    new_version = f"v{version_num}"
    backup_current_artifacts(skill_dir, current_version)
    artifacts = meta["artifacts"]
    work_path = skill_dir / artifacts["work_doc"]
    persona_path = skill_dir / artifacts["persona_doc"]
    work_content = work_path.read_text(encoding="utf-8") if work_path.exists() else ""
    persona_content = persona_path.read_text(encoding="utf-8") if persona_path.exists() else ""
    if work_patch:
        work_content = merge_markdown_patch(work_content, work_patch)
    if persona_patch:
        persona_content = merge_markdown_patch(persona_content, persona_patch)
    elif correction:
        corrections = normalize_corrections(correction)
        for item in corrections:
            persona_content = apply_correction(persona_content, item)
        if corrections:
            meta["generation"]["corrections_count"] = meta.get("corrections_count", 0) + len(corrections)
    meta["lifecycle"]["version"] = new_version
    meta["lifecycle"]["updated_at"] = now_iso()
    sync_legacy_fields(meta)
    write_artifacts(skill_dir, meta, work_content, persona_content)
    return new_version


def list_skills(base_dir: Path) -> list[dict]:
    """List generated skills from a storage root."""
    skills: list[dict] = []
    if not base_dir.exists():
        return skills
    for skill_dir in sorted(base_dir.iterdir()):
        if not skill_dir.is_dir():
            continue
        meta_path = skill_dir / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = enrich_skill_meta(json.loads(meta_path.read_text(encoding="utf-8")), skill_dir.name)
        except Exception:
            continue
        skills.append({
            "slug": meta.get("slug", skill_dir.name),
            "kind": meta.get("kind", "meta-skill"),
            "character": meta.get("character", "colleague"),
            "research_profile": meta.get("research_profile", "standard"),
            "name": meta.get("display_name", skill_dir.name),
            "identity": build_identity_string(meta),
            "version": meta.get("version", "v1"),
            "updated_at": meta.get("updated_at", ""),
            "corrections_count": meta.get("corrections_count", 0),
        })
    return skills


def resolve_base_dir(base_dir_arg: str | None, character: str) -> Path:
    return resolve_storage_root(character, base_dir_arg)


def install_generated_hosts(skill_dir: Path, args: argparse.Namespace, install_claude_skill: bool) -> list[str]:
    """Install generated skills into selected host discovery directories."""
    output_lines: list[str] = []
    if install_claude_skill:
        from install_claude_generated_skill import install_generated_skill, should_install_command_shim
        install_result = install_generated_skill(
            skill_dir,
            Path(args.claude_skills_dir).expanduser() if args.claude_skills_dir else Path.home() / ".claude" / "skills",
            commands_dir=Path(args.claude_commands_dir).expanduser() if args.claude_commands_dir else Path.home() / ".claude" / "commands",
            force=True,
            install_command_shim=args.install_claude_command_shim or should_install_command_shim(),
        )
        output_lines.append(f"  Claude skill: {install_result['skill_dir']}")
        output_lines.append(f"  Claude trigger: /{install_result['command_name']}")
    if args.install_openclaw_skill:
        from install_openclaw_generated_skill import install_generated_skill
        install_result = install_generated_skill(
            skill_dir,
            Path(args.openclaw_skills_dir).expanduser() if args.openclaw_skills_dir else Path.home() / ".openclaw" / "workspace" / "skills",
            force=True,
        )
        output_lines.append(f"  OpenClaw skill: {install_result['skill_dir']}")
    if args.install_codex_skill:
        from install_codex_generated_skill import install_generated_skill
        install_result = install_generated_skill(
            skill_dir,
            Path(args.codex_skills_dir).expanduser() if args.codex_skills_dir else Path.home() / ".codex" / "skills",
            force=True,
        )
        output_lines.append(f"  Codex skill: {install_result['skill_dir']}")
    return output_lines


def main() -> None:
    parser = argparse.ArgumentParser(description="dot-skill artifact writer")
    parser.add_argument("--action", required=True, choices=["create", "update", "list"])
    parser.add_argument("--slug", help="Skill slug used for the output directory")
    parser.add_argument("--name", help="Display name for the skill")
    parser.add_argument("--character", default="colleague", help="Character family preset")
    parser.add_argument("--research-profile", help="Celebrity research profile")
    parser.add_argument("--type", help="Deprecated compatibility alias for --character")
    parser.add_argument("--meta", help="Path to the metadata JSON file")
    parser.add_argument("--work", help="Path to the work.md content file")
    parser.add_argument("--persona", help="Path to the persona.md content file")
    parser.add_argument("--work-patch", help="Path to a work.md patch file")
    parser.add_argument("--persona-patch", help="Path to a persona.md patch file")
    parser.add_argument("--correction-json", help="Path to a correction JSON file")
    parser.add_argument("--base-dir", help="Skill storage root")
    parser.add_argument("--install-claude-skill", action="store_true", help="Install the generated skill into Claude Code")
    parser.add_argument("--no-install-claude-skill", action="store_true", help="Skip Claude Code installation")
    parser.add_argument("--install-claude-command-shim", action="store_true", help="Install a Claude slash-command shim")
    parser.add_argument("--claude-skills-dir", help="Override Claude Code skills directory")
    parser.add_argument("--claude-commands-dir", help="Override Claude Code commands directory")
    parser.add_argument("--install-openclaw-skill", action="store_true", help="Install into OpenClaw")
    parser.add_argument("--openclaw-skills-dir", help="Override OpenClaw skills directory")
    parser.add_argument("--install-codex-skill", action="store_true", help="Install into Codex")
    parser.add_argument("--codex-skills-dir", help="Override Codex skills directory")
    args = parser.parse_args()

    requested_character = normalize_character(args.character or args.type)
    auto_install_default = os.environ.get("DOT_SKILL_AUTO_INSTALL_CLAUDE", "1") != "0"
    install_claude_skill = (args.install_claude_skill or auto_install_default) and not args.no_install_claude_skill

    if args.action == "list":
        base_dir = resolve_existing_storage_root(requested_character, base_dir_arg=args.base_dir)
        skills = list_skills(base_dir)
        if not skills:
            print(f"No {requested_character} skills found")
            return
        print(f"Found {len(skills)} skills:\n")
        for skill in skills:
            updated = skill["updated_at"][:10] if skill["updated_at"] else "unknown"
            print(f"  [{skill['slug']}] {skill['name']} - {skill['identity']}")
            print(f"    Character: {skill['character']}  Profile: {skill['research_profile']}  Version: {skill['version']}  Updated: {updated}")
        return

    if not args.slug and not args.name:
        print("error: create/update requires --slug or --name", file=sys.stderr)
        sys.exit(1)

    meta: dict = json.loads(Path(args.meta).read_text(encoding="utf-8")) if args.meta else {}
    if args.name:
        meta["name"] = args.name
        meta["display_name"] = args.name
    meta["character"] = normalize_character(meta.get("character", meta.get("type", requested_character)))
    meta["research_profile"] = normalize_research_profile(meta["character"], args.research_profile or meta.get("research_profile"))
    meta["type"] = meta.get("type") or meta["character"]
    meta.setdefault("classification", {})["language"] = "en"

    if args.action == "create":
        base_dir = resolve_base_dir(args.base_dir, requested_character)
        slug = args.slug or slugify(meta.get("display_name", meta.get("name", "person")))
        work_content = Path(args.work).read_text(encoding="utf-8") if args.work else ""
        persona_content = Path(args.persona).read_text(encoding="utf-8") if args.persona else ""
        skill_dir = create_skill(base_dir, slug, meta, work_content, persona_content)
        print(f"Created skill: {skill_dir}")
        print(f"  Character: {meta['character']}")
        print(f"  Research Profile: {meta['research_profile']}")
        install_lines = install_generated_hosts(skill_dir, args, install_claude_skill)
        if install_lines:
            print("\n".join(install_lines))
        else:
            print("  Host installs: skipped")
        return

    slug = args.slug or slugify(meta.get("display_name", meta.get("name", "person")))
    base_dir = resolve_existing_storage_root(requested_character, slug=slug, base_dir_arg=args.base_dir)
    skill_dir = base_dir / slug
    if not skill_dir.exists():
        print(f"error: skill directory not found: {skill_dir}", file=sys.stderr)
        sys.exit(1)
    work_patch = Path(args.work_patch).read_text(encoding="utf-8") if args.work_patch else None
    persona_patch = Path(args.persona_patch).read_text(encoding="utf-8") if args.persona_patch else None
    correction = json.loads(Path(args.correction_json).read_text(encoding="utf-8")) if args.correction_json else None
    new_version = update_skill(skill_dir, work_patch, persona_patch, correction)
    print(f"Updated skill to {new_version}: {skill_dir}")
    install_lines = install_generated_hosts(skill_dir, args, install_claude_skill)
    if install_lines:
        print("\n".join(install_lines))


if __name__ == "__main__":
    main()

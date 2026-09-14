from __future__ import annotations

from pathlib import Path

import pytest

from myharness.learning.service import (
    LearningCandidate,
    analyze_learning_candidate,
    get_default_learning_skills_dir,
    persist_learning_candidate,
    remember_tool_failure,
    run_auto_skill_learning,
)
from myharness.skills import load_skill_registry


def test_default_learning_skills_dir_is_general_category(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "myharness.learning.service.get_program_skills_dirs",
        lambda: [tmp_path / ".skills"],
    )

    assert get_default_learning_skills_dir() == tmp_path / ".skills" / "General"


def test_repeated_verified_failure_creates_program_local_skill(tmp_path: Path):
    metadata: dict[str, object] = {"recent_verified_work": ["Ran pytest after using python [passed]"]}
    for _ in range(2):
        remember_tool_failure(
            metadata,
            tool_name="bash",
            tool_input={"command": "python -m pytest tests/test_demo.py"},
            tool_output="'python' is not recognized as an internal or external command",
        )

    result = run_auto_skill_learning(metadata, skills_dir=tmp_path / ".skills")

    assert result is not None
    assert result.action == "created"
    assert result.skill_path.exists()
    assert "repeated, verified MyHarness failure pattern" in result.skill_path.read_text(encoding="utf-8")
    patterns = result.skill_path.parent / "references" / "learned-patterns.md"
    assert result.candidate.evidence_hash in patterns.read_text(encoding="utf-8")
    assert (result.skill_path.parent / ".learning.lock").exists()
    learned = metadata.get("recent_learned_skills")
    assert isinstance(learned, list)
    assert learned[-1]["skill"] == result.skill_path.parent.name
    assert metadata["skill_registry_dirty"] is True

    registry = load_skill_registry(tmp_path, extra_skill_dirs=[tmp_path / ".skills"])
    assert registry.get(result.skill_path.parent.name) is not None


def test_single_failure_does_not_create_candidate():
    metadata: dict[str, object] = {"recent_verified_work": ["Verified the fix"]}
    remember_tool_failure(
        metadata,
        tool_name="bash",
        tool_input={"command": "npm test"},
        tool_output="one-off failure",
    )

    assert analyze_learning_candidate(metadata) is None


def test_unverified_repeated_failure_does_not_create_candidate():
    metadata: dict[str, object] = {}
    for _ in range(2):
        remember_tool_failure(
            metadata,
            tool_name="bash",
            tool_input={"command": "npm test"},
            tool_output="same failure",
        )

    assert analyze_learning_candidate(metadata) is None


def test_three_failures_in_same_category_do_not_create_candidate():
    metadata: dict[str, object] = {"recent_verified_work": ["Verified the corrected file workflow"]}
    for path in ("missing-one.txt", "missing-two.txt", "missing-three.txt"):
        remember_tool_failure(
            metadata,
            tool_name="read_file",
            tool_input={"path": path},
            tool_output=f"{path} was not found",
        )

    candidate = analyze_learning_candidate(metadata)

    assert candidate is None


def test_web_search_no_results_variants_share_signature():
    metadata: dict[str, object] = {
        "recent_verified_work": ["Fetched remote content from https://example.com/fallback"]
    }
    remember_tool_failure(
        metadata,
        tool_name="web_search",
        tool_input={"query": "example english"},
        tool_output="No search results found.",
    )
    remember_tool_failure(
        metadata,
        tool_name="web_search",
        tool_input={"query": "example korean"},
        tool_output="검색 결과가 없습니다.",
    )

    candidate = analyze_learning_candidate(metadata)

    assert candidate is not None
    assert candidate.failure_signature == "web-search-no-results"


def test_web_fetch_signature_uses_status_and_domain_not_path():
    metadata: dict[str, object] = {
        "recent_verified_work": ["Fetched remote content from https://r.jina.ai/http://example.com/a"]
    }
    for path in ("first", "second"):
        remember_tool_failure(
            metadata,
            tool_name="web_fetch",
            tool_input={"url": f"https://example.com/{path}"},
            tool_output=(
                "web_fetch failed: Client error '403 Forbidden' "
                f"for url 'https://example.com/{path}'"
            ),
        )

    candidate = analyze_learning_candidate(metadata)

    assert candidate is not None
    assert candidate.failure_signature == "web-fetch-403-example-com"


def test_youtube_yt_dlp_failures_create_reusable_transcript_skill(tmp_path: Path):
    metadata: dict[str, object] = {
        "recent_verified_work": [
            "Ran command python .skills/General/insane-search/scripts/youtube_transcript.py URL --json"
        ]
    }
    for video_id in ("uqdwML8VzUY", "I9nDOSGfwZg"):
        remember_tool_failure(
            metadata,
            tool_name="cmd",
            tool_input={
                "command": (
                    "yt-dlp --dump-json --skip-download "
                    f'"https://www.youtube.com/watch?v={video_id}"'
                )
            },
            tool_output="WARNING: [youtube] No supported JavaScript runtime could be found",
        )

    candidate = analyze_learning_candidate(metadata)
    assert candidate is not None
    assert candidate.failure_signature == "youtube-transcript-yt-dlp"
    assert candidate.skill_name == "learned-youtube-transcript-yt-dlp"
    assert "youtube_transcript.py" in candidate.do_next_time

    result = persist_learning_candidate(candidate, skills_dir=tmp_path / ".skills")
    skill_text = result.skill_path.read_text(encoding="utf-8")
    assert "description: >" in skill_text
    assert "reusable helper" in skill_text


def test_unhelpful_verified_work_does_not_create_candidate():
    metadata: dict[str, object] = {
        "recent_verified_work": [
            "Inspected file C:\\Users\\Myeongcheol\\repo\\report.html (lines 1-20)",
            "Ran command cp outputs/report.html outputs/report_v1.html [(출력 없음)]",
        ]
    }
    for _ in range(2):
        remember_tool_failure(
            metadata,
            tool_name="web_search",
            tool_input={"query": "stale result"},
            tool_output="No search results found.",
        )

    assert analyze_learning_candidate(metadata) is None


def test_secret_and_user_path_are_redacted(tmp_path: Path):
    leaked_api_key = "sk-" + "x" * 26
    metadata: dict[str, object] = {
        "recent_verified_work": ["Verified with token=super-secret-value at C:\\Users\\Myeongcheol\\repo"]
    }
    for _ in range(2):
        remember_tool_failure(
            metadata,
            tool_name="bash",
            tool_input={"command": "curl -H token=super-secret-value C:\\Users\\Myeongcheol\\repo"},
            tool_output=f"failed with {leaked_api_key}",
        )

    candidate = analyze_learning_candidate(metadata)
    assert candidate is not None
    result = persist_learning_candidate(candidate, skills_dir=tmp_path / ".skills")
    combined = result.skill_path.read_text(encoding="utf-8")
    combined += (result.skill_path.parent / "references" / "learned-patterns.md").read_text(encoding="utf-8")

    assert "super-secret-value" not in combined
    assert leaked_api_key not in combined
    assert "Myeongcheol" not in combined
    assert "[REDACTED_SECRET]" in combined


def test_existing_candidate_is_not_duplicated(tmp_path: Path):
    metadata: dict[str, object] = {"recent_verified_work": ["Verified the fix"]}
    for _ in range(2):
        remember_tool_failure(
            metadata,
            tool_name="bash",
            tool_input={"command": "npm test"},
            tool_output="same failure",
        )
    candidate = analyze_learning_candidate(metadata)
    assert candidate is not None

    first = persist_learning_candidate(candidate, skills_dir=tmp_path / ".skills")
    second = persist_learning_candidate(candidate, skills_dir=tmp_path / ".skills")

    assert first.action == "created"
    assert second.action == "unchanged"


def test_existing_learned_skill_is_updated_before_creating_specific_duplicate(tmp_path: Path):
    skills_root = tmp_path / ".skills"
    existing_dir = skills_root / "learned-command-failures"
    references_dir = existing_dir / "references"
    references_dir.mkdir(parents=True)
    (existing_dir / "SKILL.md").write_text(
        "---\n"
        "name: learned-command-failures\n"
        "description: Use when command failures need workflow diagnosis.\n"
        "---\n\n"
        "# Learned Command Failures\n",
        encoding="utf-8",
    )
    (references_dir / "learned-patterns.md").write_text("", encoding="utf-8")

    metadata: dict[str, object] = {"recent_verified_work": ["Ran npm test after fixing setup"]}
    for _ in range(2):
        remember_tool_failure(
            metadata,
            tool_name="cmd",
            tool_input={
                "command": "npm run test:react -- src/components/__tests__/Composer.test.tsx"
            },
            tool_output="AssertionError: expected composer to submit",
        )
    candidate = analyze_learning_candidate(metadata)
    assert candidate is not None

    result = persist_learning_candidate(candidate, skills_dir=skills_root)

    assert result.action == "updated"
    assert result.skill_path == existing_dir / "SKILL.md"
    assert not (skills_root / candidate.skill_name).exists()
    patterns = (references_dir / "learned-patterns.md").read_text(encoding="utf-8")
    assert candidate.evidence_hash in patterns


def test_persist_caps_evidence_and_skips_duplicate_signature_lesson(tmp_path: Path):
    base = LearningCandidate(
        skill_name="learned-demo",
        trigger_description="Use for repeated demo failures",
        lesson="Use the stable fallback",
        do_next_time="Fetch the stable fallback URL",
        avoid_next_time="Do not repeat the broken URL",
        evidence_hash="hash0000",
        confidence=0.85,
        failure_signature="web-fetch-403-example-com",
    )

    first = persist_learning_candidate(base, skills_dir=tmp_path / ".skills")
    duplicate = persist_learning_candidate(
        LearningCandidate(
            **{
                **base.__dict__,
                "evidence_hash": "hash0001",
            }
        ),
        skills_dir=tmp_path / ".skills",
    )
    for index in range(2, 12):
        persist_learning_candidate(
            LearningCandidate(
                **{
                    **base.__dict__,
                    "lesson": f"Use stable fallback {index}",
                    "evidence_hash": f"hash{index:04d}",
                }
            ),
            skills_dir=tmp_path / ".skills",
        )

    patterns = (first.skill_path.parent / "references" / "learned-patterns.md").read_text(
        encoding="utf-8"
    )

    assert duplicate.action == "unchanged"
    assert patterns.count("## Evidence") == 8
    assert "hash0000" not in patterns
    assert "hash0001" not in patterns
    assert "hash0011" in patterns


@pytest.mark.parametrize(("signatures", "name"), [
    (("web-search-no-results", "web-fetch-403-new-example"), "learned-web-research-recovery"),
    (("cmd-new-command-error", "python-unseen-helper-error"), "learned-command-failures"),
    (("mcp-new-provider-invalid-id", "mcp-another-provider-timeout"), "learned-mcp-recovery"),
    (("write-file-new-chart-rejected", "read-file-missing-input"), "learned-file-recovery"),
    (("unregistered-tool-failure", "another-new-operation-error"), "learned-tool-recovery"),
])
def test_new_failures_share_common_group_on_fresh_install(tmp_path, monkeypatch, signatures, name):
    program_skills = tmp_path / ".skills"
    monkeypatch.setattr("myharness.learning.service.get_program_skills_dirs", lambda: [program_skills])
    monkeypatch.setattr("myharness.skills.loader.get_program_skills_dirs", lambda: [program_skills])
    for index, signature in enumerate(signatures):
        candidate = LearningCandidate(
            skill_name=f"learned-{signature}", trigger_description="One specific failure",
            lesson=f"Observed failure {index}", do_next_time="One specific correction",
            avoid_next_time="One specific input", evidence_hash=f"new-evidence-{index}",
            confidence=0.85, failure_signature=signature,
        )
        result = persist_learning_candidate(candidate)
        assert result.skill_path == program_skills / "General" / name / "SKILL.md"
        assert result.action == ("created" if index == 0 else "updated")
    assert len(list(program_skills.rglob("SKILL.md"))) == 1
    assert not (program_skills / "POSCO_Skill").exists()
    registry = load_skill_registry(tmp_path, extra_skill_dirs=[program_skills])
    assert registry.get(name) is not None
    assert "One specific failure" not in result.skill_path.read_text(encoding="utf-8")
    evidence = result.skill_path.parent / "references" / "learned-patterns.md"
    assert evidence.read_text(encoding="utf-8").count("## Evidence") == 2


def test_learning_keeps_curated_guidance_and_historical_evidence(tmp_path):
    root = tmp_path / "General"
    folder = root / "learned-mcp-recovery"
    refs = folder / "references"
    refs.mkdir(parents=True)
    instructions = "---\nname: learned-mcp-recovery\ndescription: MCP recovery\n---\nCurated instructions\n"
    (folder / "SKILL.md").write_text(instructions, encoding="utf-8")
    archive = refs / "historical-evidence.md"
    archive.write_text("Preserved historical evidence", encoding="utf-8")
    for index in range(10):
        candidate = LearningCandidate(
            skill_name=f"learned-mcp-provider-{index}", trigger_description="MCP failure",
            lesson=f"Correction {index}", do_next_time="Retry corrected request",
            avoid_next_time="Invalid input", evidence_hash=f"mcp-{index}",
            confidence=0.85, failure_signature=f"mcp-provider-{index}-invalid",
        )
        persist_learning_candidate(candidate, skills_dir=root)
    assert (folder / "SKILL.md").read_text(encoding="utf-8") == instructions
    assert archive.read_text(encoding="utf-8") == "Preserved historical evidence"
    assert len(list(root.glob("*/SKILL.md"))) == 1


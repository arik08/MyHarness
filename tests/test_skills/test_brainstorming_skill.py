from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_brainstorming_skill_does_not_gate_concrete_build_requests():
    skill_text = (ROOT / ".skills" / "General" / "brainstorming" / "SKILL.md").read_text(encoding="utf-8")

    assert "Do not use for direct build or change requests" in skill_text
    assert "A request such as \"make this HTML game\"" in skill_text
    assert "stop the brainstorming workflow and immediately continue" in skill_text
    assert "Do not create a design document instead of the requested artifact" in skill_text
    assert "resume the original implementation immediately" in skill_text
    assert "Never offer it as a detour from a concrete build request" in skill_text
    assert "This applies to EVERY project regardless of perceived simplicity" not in skill_text
    assert "The message should contain ONLY the offer above" not in skill_text

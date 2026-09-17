from pathlib import Path

from myharness.skills import load_skill_registry


ROOT = Path(__file__).resolve().parents[2]


def test_bundled_slide_skill_includes_its_executable_resources(tmp_path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    skill = load_skill_registry(ROOT).get("slidestyle-html")
    assert skill is not None
    assert skill.source == "skill-category:General"
    folder = Path(skill.path).parent
    for relative in (
        "assets/skeleton.html", "scripts/audit.js", "scripts/contrast.py",
        "scripts/export_pdf.py", "scripts/qr_svg.py", "references/stage.md",
        "references/reveal.md", "references/korean-type.md", "references/verify.md",
        "references/palette.md", "references/charts.md",
    ):
        assert (folder / relative).is_file(), relative
    assert not (folder / ".git").exists()

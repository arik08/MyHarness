import os
from pathlib import Path

from myharness.plugins.loader import _load_plugin_skills
from myharness.skills.loader import load_skills_from_dirs


def test_cached_files_refresh_on_edits_atomic_replacement_addition_and_deletion(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    path = root / "first" / "SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text("# First\nOld content", encoding="utf-8")
    read_text = Path.read_text
    reads = []

    def counted_read(file, *args, **kwargs):
        reads.append(file)
        return read_text(file, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counted_read)
    first = load_skills_from_dirs([root])
    assert load_skills_from_dirs([root]) == first
    assert reads == [path]
    old_stat = path.stat()
    path.write_text("# First\nNew content", encoding="utf-8")
    os.utime(path, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns + 1_000_000))
    assert load_skills_from_dirs([root])[0].content.endswith("New content")
    replacement = path.with_suffix(".tmp")
    replacement.write_text("# First\nNext update", encoding="utf-8")
    os.utime(replacement, ns=(old_stat.st_atime_ns, path.stat().st_mtime_ns))
    replacement.replace(path)
    assert load_skills_from_dirs([root])[0].content.endswith("Next update")
    extra = root / "second" / "SKILL.md"
    extra.parent.mkdir()
    extra.write_text("# Second\nNew skill", encoding="utf-8")
    assert {s.name for s in load_skills_from_dirs([root])} == {"First", "Second"}
    path.unlink()
    assert [s.name for s in load_skills_from_dirs([root])] == ["Second"]


def test_cache_keeps_project_and_plugin_sources_separate(tmp_path):
    path = tmp_path / "first" / "SKILL.md"
    path.parent.mkdir()
    path.write_text("---\nname: first\nsource: skill-mcp:example\n---\n\nInstructions", encoding="utf-8")
    assert load_skills_from_dirs([tmp_path], source="project")[0].source == "skill-mcp:example"
    assert _load_plugin_skills(tmp_path, "one")[0].source == "plugin:one"
    assert _load_plugin_skills(tmp_path, "two")[0].source == "plugin:two"

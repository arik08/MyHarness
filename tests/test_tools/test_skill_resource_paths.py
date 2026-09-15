"""Skill resources stay addressable from an unrelated task directory."""

from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from myharness.tools.base import ToolExecutionContext
from myharness.tools.skill_tool import SkillTool, SkillToolInput


@pytest.mark.asyncio
@pytest.mark.parametrize("folder", ["installed skill", "relocated/한글 스킬"])
async def test_loaded_skill_paths_run_from_task_workspace(tmp_path, monkeypatch, folder):
    package = tmp_path / folder
    scripts = package / "scripts"
    scripts.mkdir(parents=True)
    script = scripts / "inspect_document.py"
    script.write_text(
        "from pathlib import Path\nimport sys\nprint(Path(sys.argv[1]).read_text(encoding='utf-8'))\n",
        encoding="utf-8",
    )
    content = "Run python <skill>/scripts/inspect_document.py outputs/document.txt"
    skill_file = package / "SKILL.md"
    skill_file.write_text(content, encoding="utf-8")
    skill = SimpleNamespace(name="new-review", description="Review", content=content,
                            path=str(skill_file), source="test")
    monkeypatch.setitem(SkillTool.execute.__globals__, "load_skill_registry", lambda *a, **k: {skill.name: skill})
    monkeypatch.setitem(SkillTool.execute.__globals__, "increment_skill_usage_count", lambda name: None)
    workspace = tmp_path / "task workspace"
    (workspace / "outputs").mkdir(parents=True)
    (workspace / "outputs/document.txt").write_text("artifact verified", encoding="utf-8")
    context = ToolExecutionContext(cwd=workspace)
    result = await SkillTool().execute(SkillToolInput(name=skill.name), context)
    directory_line = next(line for line in result.output.splitlines() if line.startswith("Skill directory (<skill>): "))
    directory = Path(directory_line.removeprefix("Skill directory (<skill>): "))
    run = subprocess.run([sys.executable, str(directory / "scripts/inspect_document.py"),
                          "outputs/document.txt"], cwd=workspace, capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert run.stdout.strip() == "artifact verified"
    assert not (workspace / "scripts").exists()
    assert "does not change the command working directory" in result.output
    assert skill_file.read_text(encoding="utf-8") == content

    source = await SkillTool().execute(SkillToolInput(name=skill.name, mode="source"), context)
    assert content in source.metadata["transcript_output"]
    assert "Skill directory (<skill>):" not in source.metadata["transcript_output"]


@pytest.mark.asyncio
async def test_skill_without_location_does_not_invent_resource_directory(tmp_path, monkeypatch):
    skill = SimpleNamespace(name="remote", description="Remote", content="Read scripts/check.py", path=None, source="test")
    monkeypatch.setitem(SkillTool.execute.__globals__, "load_skill_registry", lambda *a, **k: {skill.name: skill})
    monkeypatch.setitem(SkillTool.execute.__globals__, "increment_skill_usage_count", lambda name: None)
    result = await SkillTool().execute(SkillToolInput(name=skill.name), ToolExecutionContext(cwd=tmp_path))
    assert "no filesystem location" in result.output
    assert "Skill directory (<skill>):" not in result.output

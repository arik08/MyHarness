"""Avoid blocking duplicate environment probes during runtime construction."""

from dataclasses import replace
from unittest.mock import Mock

import pytest

from myharness.config.settings import Settings
from myharness.prompts import context, system_prompt
from myharness.prompts.environment import EnvironmentInfo


@pytest.mark.parametrize("custom_prompt,task_worker,coordinator", [
    (None, False, False),
    ("Custom office assistant.", False, False),
    (None, True, False),
    (None, False, True),
    (None, True, True),
])
def test_environment_is_detected_once_and_preserved(tmp_path, monkeypatch, custom_prompt,
                                                  task_worker, coordinator):
    probe = Mock(return_value=EnvironmentInfo(
        os_name="Windows", os_version="test", platform_machine="AMD64", shell="powershell",
        cwd=str(tmp_path), home_dir="test-home", date="2026-09-30", python_version="3.13",
        python_executable="test-python", virtual_env=None, is_git_repo=True, git_branch="review",
    ))
    monkeypatch.setattr(system_prompt, "get_environment_info", probe)
    monkeypatch.setattr(context, "is_coordinator_mode", lambda: coordinator)
    monkeypatch.setattr(context, "get_coordinator_system_prompt", lambda: "Coordinator instructions.")
    monkeypatch.setattr(context, "_build_skills_section", lambda *args, **kwargs: "")
    monkeypatch.setattr(context, "load_local_rules", lambda: None)
    prompt = context.build_runtime_system_prompt(
        Settings(system_prompt=custom_prompt, memory={"enabled": False}),
        cwd=tmp_path, task_worker=task_worker,
    )
    if coordinator and not task_worker:
        probe.assert_not_called()
        assert prompt.startswith("Coordinator instructions.")
    else:
        probe.assert_called_once_with(cwd=str(tmp_path))
        assert f"- Working directory: {tmp_path}" in prompt
        assert "- Date: 2026-09-30" in prompt
        assert "- Git: yes (branch: review)" in prompt
        if custom_prompt:
            assert prompt.startswith(custom_prompt)
    assert "# Task Execution Contract" in prompt


@pytest.mark.parametrize("profile", ["full", "continuation"])
def test_volatile_session_facts_follow_the_unchanged_instruction_prefix(tmp_path, monkeypatch, profile):
    env = EnvironmentInfo(
        os_name="Windows", os_version="test", platform_machine="AMD64", shell="powershell",
        cwd=str(tmp_path), home_dir="test-home", date="2026-09-30", python_version="3.13",
        python_executable="test-python", virtual_env=None, is_git_repo=True, git_branch="review",
    )
    probe = Mock(return_value=env)
    monkeypatch.setattr(system_prompt, "get_environment_info", probe)
    monkeypatch.setattr(context, "is_coordinator_mode", lambda: False)
    monkeypatch.setattr(context, "_build_skills_section", lambda *a, **kw: "# Available Skills\nStable catalog")
    monkeypatch.setattr(context, "load_project_instructions_prompt", lambda *a: "# Project Instructions\nKeep private data local.")
    monkeypatch.setattr(context, "load_local_rules", lambda: "Use powershell.")
    settings = Settings(memory={"enabled": False}, effort="low", passes=1)
    first = context.build_runtime_system_prompt(settings, cwd=tmp_path, prompt_profile=profile)
    probe.return_value = replace(env, date="2026-10-01", git_branch="next")
    settings.effort = "high"
    settings.passes = 3
    settings.fast_mode = True
    second = context.build_runtime_system_prompt(settings, cwd=tmp_path, prompt_profile=profile)
    prefix = first[:first.index("# Environment")]
    assert second.startswith(prefix)
    assert len(prefix) > 10000
    assert "# Project Instructions" in prefix
    assert "# Available Skills" in prefix
    assert second.count("# Environment") == 1
    assert "2026-10-01" in second and "branch: next" in second
    assert "- Effort: high" in second and "- Passes: 3" in second
    assert "Fast mode is enabled" in second

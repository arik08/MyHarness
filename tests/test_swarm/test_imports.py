"""Import regression tests for swarm startup."""

from __future__ import annotations

import importlib
import sys

from myharness.platforms import get_platform


def test_create_default_tool_registry_does_not_import_mailbox_eagerly():
    for module_name in list(sys.modules):
        if module_name == "myharness.tools" or module_name.startswith("myharness.tools."):
            sys.modules.pop(module_name, None)
        if module_name == "myharness.swarm" or module_name.startswith("myharness.swarm."):
            sys.modules.pop(module_name, None)

    tools = importlib.import_module("myharness.tools")
    registry = tools.create_default_tool_registry()

    command_tool = "cmd" if get_platform() == "windows" else "bash"
    assert registry.get(command_tool) is not None
    assert "myharness.swarm.mailbox" not in sys.modules
    assert "myharness.swarm.lockfile" not in sys.modules

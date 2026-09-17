"""File tools must not destroy the previous file when saving fails."""

import json
from pathlib import Path

import pytest

from myharness.tools.base import ToolExecutionContext
from myharness.tools.file_edit_tool import FileEditTool, FileEditToolInput
from myharness.tools.file_write_tool import FileWriteTool, FileWriteToolInput
from myharness.tools.notebook_edit_tool import NotebookEditTool, NotebookEditToolInput


async def save(kind: str, path: Path, content: str) -> None:
    context = ToolExecutionContext(cwd=path.parent)
    if kind == "write":
        await FileWriteTool().execute(FileWriteToolInput(path=path.name, content=content), context)
    elif kind == "edit":
        await FileEditTool().execute(
            FileEditToolInput(path=path.name, old_str="original", new_str=content), context
        )
    else:
        await NotebookEditTool().execute(
            NotebookEditToolInput(path=path.name, cell_index=0, new_source=content), context
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["write", "edit"])
async def test_encoding_failure_preserves_original(tmp_path: Path, kind: str) -> None:
    path = tmp_path / "document.txt"
    original = b"original\r\nkeep this file\r\n"
    path.write_bytes(original)
    with pytest.raises(UnicodeEncodeError):
        await save(kind, path, "invalid \ud800 text")
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["write", "edit", "notebook"])
@pytest.mark.parametrize("operation", ["fsync", "replace"])
async def test_save_failure_preserves_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, operation: str
) -> None:
    path = tmp_path / ("document.ipynb" if kind == "notebook" else "document.txt")
    original = json.dumps({"cells": [], "nbformat": 4}).encode() if kind == "notebook" else b"original\n"
    path.write_bytes(original)

    def fail(*args, **kwargs):
        raise OSError("simulated storage failure")

    monkeypatch.setattr(f"myharness.utils.fs.os.{operation}", fail)
    with pytest.raises(OSError, match="simulated storage failure"):
        await save(kind, path, "updated")
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.asyncio
async def test_write_respects_disabled_directory_creation(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        await FileWriteTool().execute(
            FileWriteToolInput(path="missing/document.txt", content="new", create_directories=False),
            ToolExecutionContext(cwd=tmp_path),
        )
    assert not (tmp_path / "missing").exists()

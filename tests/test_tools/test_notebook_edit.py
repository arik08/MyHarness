"""Notebook edits preserve the notebook format and unrelated cell data."""

import json
import re
from pathlib import Path

import pytest

from myharness.tools.base import ToolExecutionContext
from myharness.tools.notebook_edit_tool import NotebookEditTool, NotebookEditToolInput


async def edit(path: Path, **kwargs):
    return await NotebookEditTool().execute(
        NotebookEditToolInput(path=path.name, cell_index=kwargs.pop("cell_index", 0), **kwargs),
        ToolExecutionContext(cwd=path.parent),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("cell_type", ["code", "markdown"])
async def test_new_cells_have_unique_format_45_ids(tmp_path: Path, cell_type: str):
    path = tmp_path / "new.ipynb"
    result = await edit(path, cell_index=2, new_source="hello", cell_type=cell_type)
    assert not result.is_error
    notebook = json.loads(path.read_text())
    assert notebook["nbformat_minor"] == 5
    ids = [cell.get("id", "") for cell in notebook["cells"]]
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value) for value in ids)
    assert len(set(ids)) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("target_type", ["code", "markdown"])
async def test_converting_cell_removes_incompatible_fields(tmp_path: Path, target_type: str):
    path = tmp_path / "existing.ipynb"
    original_type = "markdown" if target_type == "code" else "code"
    cell = {"id": "keep-id", "cell_type": original_type, "metadata": {"tags": ["keep"]}, "source": ["old\n"]}
    if original_type == "code":
        cell.update(outputs=[{"output_type": "stream", "name": "stdout", "text": "old\n"}], execution_count=7)
    else:
        cell["attachments"] = {"image.png": {"image/png": "AA=="}}
    other = {"id": "other", "cell_type": "markdown", "metadata": {}, "source": "untouched"}
    path.write_text(json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [cell, other]}))
    result = await edit(path, new_source="new", cell_type=target_type, mode="append")
    assert not result.is_error
    cells = json.loads(path.read_text())["cells"]
    assert cells[1] == other
    assert cells[0]["id"] == "keep-id"
    assert cells[0]["metadata"] == {"tags": ["keep"]}
    assert cells[0]["source"] == "old\nnew"
    if target_type == "code":
        assert "attachments" not in cells[0]
        assert cells[0]["outputs"] == []
        assert cells[0]["execution_count"] is None
    else:
        assert "outputs" not in cells[0]
        assert "execution_count" not in cells[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("contents", ["[]", "null", '{"nbformat":3,"worksheets":[]}', '{"nbformat":4,"cells":{}}', '{"nbformat":4}', '{"nbformat":4,"cells":[null]}', '{invalid'])
async def test_invalid_or_unsupported_notebook_is_not_rewritten(tmp_path: Path, contents: str):
    path = tmp_path / "invalid.ipynb"
    path.write_bytes(contents.encode())
    result = await edit(path, new_source="new")
    assert result.is_error
    assert path.read_bytes() == contents.encode()


@pytest.mark.asyncio
async def test_older_format_retains_version_without_unsupported_ids(tmp_path: Path):
    path = tmp_path / "older.ipynb"
    path.write_text(json.dumps({"nbformat": 4, "nbformat_minor": 0, "metadata": {}, "cells": []}))
    result = await edit(path, cell_index=2, new_source="code")
    assert not result.is_error
    notebook = json.loads(path.read_text())
    assert notebook["nbformat_minor"] == 0
    assert all("id" not in cell for cell in notebook["cells"])


@pytest.mark.asyncio
@pytest.mark.parametrize("source", [None, 123, {}, ["line", 123]])
async def test_invalid_source_is_not_silently_converted(tmp_path: Path, source):
    path = tmp_path / "invalid.ipynb"
    original = json.dumps({"nbformat": 4, "nbformat_minor": 5, "cells": [{"source": source}]}).encode()
    path.write_bytes(original)
    result = await edit(path, new_source="new", mode="append")
    assert result.is_error
    assert path.read_bytes() == original


@pytest.mark.asyncio
@pytest.mark.parametrize("cell_type", ["code", "markdown"])
async def test_same_type_edit_preserves_existing_cell_data(tmp_path: Path, cell_type: str):
    path = tmp_path / "same.ipynb"
    cell = {"id": "stable", "cell_type": cell_type, "source": "old", "metadata": {"tags": ["keep"]}}
    if cell_type == "code":
        cell.update(outputs=[{"output_type": "stream", "name": "stdout", "text": "old"}], execution_count=2)
    else:
        cell["attachments"] = {"image.png": {"image/png": "AA=="}}
    path.write_text(json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [cell]}))
    result = await edit(path, new_source="new", cell_type=cell_type)
    assert not result.is_error
    assert json.loads(path.read_text())["cells"][0] == {**cell, "source": "new"}

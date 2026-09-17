"""Minimal Jupyter notebook editing tool."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.utils.fs import atomic_write_text


class NotebookEditToolInput(BaseModel):
    """Arguments for notebook editing."""

    path: str = Field(description="Path to the .ipynb file")
    cell_index: int = Field(description="Zero-based cell index", ge=0)
    new_source: str = Field(description="Replacement or appended source for the target cell")
    cell_type: Literal["code", "markdown"] = Field(default="code")
    mode: Literal["replace", "append"] = Field(default="replace")
    create_if_missing: bool = Field(default=True)


class NotebookEditTool(BaseTool):
    """Edit notebook cells without requiring nbformat."""

    name = "notebook_edit"
    description = "Create or edit a Jupyter notebook cell."
    input_model = NotebookEditToolInput

    async def execute(
        self,
        arguments: NotebookEditToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        path = _resolve_path(context.cwd, arguments.path)
        try:
            notebook = await asyncio.to_thread(
                _load_notebook,
                path,
                create_if_missing=arguments.create_if_missing,
            )
        except ValueError:
            return ToolResult(
                output="유효한 nbformat 4 노트북이 아닙니다. 원본 파일은 변경하지 않았습니다.",
                is_error=True,
            )
        if notebook is None:
            return ToolResult(output=f"노트북을 찾을 수 없습니다: {path}", is_error=True)

        cells = notebook["cells"]
        needs_cell_ids = notebook.get("nbformat_minor", 0) >= 5
        while len(cells) <= arguments.cell_index:
            cells.append(_empty_cell(arguments.cell_type, include_id=needs_cell_ids))

        cell = cells[arguments.cell_index]
        try:
            existing = _normalize_source(cell.get("source", ""))
        except ValueError:
            return ToolResult(output="셀 source는 문자열 또는 문자열 목록이어야 합니다. 원본 파일은 변경하지 않았습니다.", is_error=True)
        cell["cell_type"] = arguments.cell_type
        if needs_cell_ids:
            cell.setdefault("id", uuid4().hex)
        cell.setdefault("metadata", {})
        if arguments.cell_type == "code":
            cell.pop("attachments", None)
            cell.setdefault("outputs", [])
            cell.setdefault("execution_count", None)
        else:
            cell.pop("outputs", None)
            cell.pop("execution_count", None)

        updated = arguments.new_source if arguments.mode == "replace" else f"{existing}{arguments.new_source}"
        cell["source"] = updated

        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(
            atomic_write_text,
            path,
            json.dumps(notebook, indent=2) + "\n",
            encoding="utf-8",
            newline=None,
        )
        return ToolResult(output=f"노트북 셀 {arguments.cell_index}을(를) 업데이트했습니다: {path}")


def _resolve_path(base: Path, candidate: str) -> Path:
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _load_notebook(path: Path, *, create_if_missing: bool) -> dict | None:
    if path.exists():
        notebook = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(notebook, dict)
            or notebook.get("nbformat") != 4
            or not isinstance(notebook.get("nbformat_minor", 0), int)
            or not isinstance(notebook.get("cells"), list)
            or any(not isinstance(cell, dict) for cell in notebook["cells"])
        ):
            raise ValueError("Unsupported or invalid notebook structure")
        return notebook
    if not create_if_missing:
        return None
    return {
        "cells": [],
        "metadata": {"language_info": {"name": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def _empty_cell(cell_type: str, *, include_id: bool = True) -> dict:
    cell = {"cell_type": cell_type, "metadata": {}, "source": ""}
    if include_id:
        cell["id"] = uuid4().hex
    if cell_type == "code":
        cell.update(outputs=[], execution_count=None)
    return cell


def _normalize_source(source: str | list[str]) -> str:
    if isinstance(source, list) and all(isinstance(line, str) for line in source):
        return "".join(source)
    if isinstance(source, str):
        return source
    raise ValueError("Invalid cell source")

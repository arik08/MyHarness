"""Tool for maintaining a project TODO file."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field, model_validator

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class TodoWriteItemInput(BaseModel):
    """One markdown checklist item."""

    text: str = Field(description="TODO item text")
    checked: bool = Field(default=False)


class TodoWriteToolInput(BaseModel):
    """Arguments for TODO writes."""

    item: str | None = Field(default=None, description="TODO item text")
    checked: bool = Field(default=False)
    path: str = Field(default="TODO.md")
    persist: bool = Field(default=True, description="Whether to write the checklist to disk.")
    todos: list[TodoWriteItemInput] | None = Field(
        default=None,
        description=(
            "Full checklist to render or persist. Use this for session task progress checklists; "
            "when updating progress, pass the full current checklist and check only items that "
            "have actually completed since the prior update."
        ),
    )

    @model_validator(mode="after")
    def default_progress_checklists_to_session_only(self) -> "TodoWriteToolInput":
        if self.todos is not None and "persist" not in self.__pydantic_fields_set__:
            self.persist = False
        return self


class TodoWriteTool(BaseTool):
    """Add or update an item in a TODO markdown file."""

    name = "todo_write"
    description = (
        "Add a new TODO item or update a markdown checklist. For session progress, update the "
        "full checklist immediately after each step completes instead of marking several steps "
        "done only at the end. If there is no concrete checklist item yet, skip this tool; empty "
        "calls are treated as no-ops."
    )
    input_model = TodoWriteToolInput

    def is_read_only(self, arguments: TodoWriteToolInput) -> bool:
        if not arguments.item and not arguments.todos:
            return True
        if arguments.item is not None and not arguments.item.strip():
            return True
        if arguments.todos is not None and not any(item.text.strip() for item in arguments.todos):
            return True
        return not arguments.persist

    async def execute(self, arguments: TodoWriteToolInput, context: ToolExecutionContext) -> ToolResult:
        path = Path(context.cwd) / arguments.path

        if arguments.todos is not None:
            lines = [
                f"- [{'x' if item.checked else ' '}] {item.text.strip()}"
                for item in arguments.todos
                if item.text.strip()
            ]
            if not lines:
                return ToolResult(output="")
            markdown = "\n".join(lines)
            if not arguments.persist:
                return ToolResult(output=markdown)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"# TODO\n{markdown}\n", encoding="utf-8")
            return ToolResult(output=f"Updated {path}\n{markdown}")

        if not arguments.item or not arguments.item.strip():
            return ToolResult(output="")
        item = arguments.item.strip()
        existing = path.read_text(encoding="utf-8") if path.exists() else "# TODO\n"

        unchecked_line = f"- [ ] {item}"
        checked_line = f"- [x] {item}"
        target_line = checked_line if arguments.checked else unchecked_line

        if unchecked_line in existing and arguments.checked:
            # Mark existing unchecked item as done (in-place update)
            updated = existing.replace(unchecked_line, checked_line, 1)
        elif target_line in existing:
            # Item already in desired state — no-op
            return ToolResult(output=f"No change needed in {path}")
        else:
            # New item — append
            updated = existing.rstrip() + f"\n{target_line}\n"

        if not arguments.persist:
            return ToolResult(output=target_line)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(updated, encoding="utf-8")
        return ToolResult(output=f"Updated {path}")

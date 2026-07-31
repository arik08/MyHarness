"""Bounded append and reverse-tail helpers for rotating JSONL files."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

DEFAULT_READ_CHUNK_BYTES = 64 * 1024


def append_rotating_line(path: Path, line: str, *, max_bytes: int) -> None:
    """Append one line, rotating the current file to a single bounded backup."""
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = line.encode("utf-8")
    if not encoded.endswith(b"\n"):
        encoded += b"\n"
    try:
        current_size = path.stat().st_size
    except FileNotFoundError:
        current_size = 0
    if current_size + len(encoded) > max_bytes:
        backup = rotated_backup_path(path)
        backup.unlink(missing_ok=True)
        if path.exists():
            path.replace(backup)
            _trim_to_complete_line_tail(backup, max_bytes)
    with path.open("ab") as handle:
        handle.write(encoded)


def iter_rotating_lines_reverse(
    path: Path,
    *,
    read_chunk_bytes: int = DEFAULT_READ_CHUNK_BYTES,
) -> Iterator[bytes]:
    """Yield non-empty lines newest-first from the current file and its backup."""
    for candidate in (path, rotated_backup_path(path)):
        try:
            with candidate.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                position = handle.tell()
                remainder = b""
                while position > 0:
                    read_size = min(read_chunk_bytes, position)
                    position -= read_size
                    handle.seek(position)
                    block = handle.read(read_size) + remainder
                    lines = block.split(b"\n")
                    remainder = lines[0]
                    for line in reversed(lines[1:]):
                        if line:
                            yield line
                if remainder:
                    yield remainder
        except FileNotFoundError:
            continue


def rotated_backup_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.1")


def _trim_to_complete_line_tail(path: Path, max_bytes: int) -> None:
    try:
        with path.open("r+b") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            if size <= max_bytes:
                return
            handle.seek(size - max_bytes)
            tail = handle.read(max_bytes)
            first_newline = tail.find(b"\n")
            if first_newline >= 0:
                tail = tail[first_newline + 1:]
            handle.seek(0)
            handle.write(tail)
            handle.truncate()
    except FileNotFoundError:
        return

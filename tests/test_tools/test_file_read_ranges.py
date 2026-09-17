import io
from pathlib import Path

import pytest

from myharness.tools.base import ToolExecutionContext
from myharness.tools.file_read_tool import (
    FILE_READ_MAX_OUTPUT_CHARS, FILE_READ_TRUNCATION_NOTICE,
    FileReadTool, FileReadToolInput, _read_selected_lines,
)


def test_reader_stops_after_requested_range(monkeypatch):
    class RangeStream(io.StringIO):
        def readline(self, size=-1):
            assert self.tell() < len("skip\nkeep\n"), "read past requested range"
            return super().readline(size)

    monkeypatch.setattr(Path, "open", lambda *args, **kwargs: RangeStream("skip\nkeep\nshould not read\n"))
    assert _read_selected_lines(Path("sample.txt"), 1, 1) == (False, ["keep"])


def test_reader_bounds_individual_reads_even_when_skipping(monkeypatch):
    class BoundedStream(io.StringIO):
        def readline(self, size=-1):
            assert 0 < size <= FILE_READ_MAX_OUTPUT_CHARS + 1
            return super().readline(size)

    content = "x" * (FILE_READ_MAX_OUTPUT_CHARS * 2) + "\nselected\n"
    monkeypatch.setattr(Path, "open", lambda *args, **kwargs: BoundedStream(content))
    assert _read_selected_lines(Path("sample.txt"), 1, 1) == (False, ["selected"])


@pytest.mark.asyncio
@pytest.mark.parametrize("contents,offset,limit,expected", [
    ("", 0, 1, None), ("one\ntwo", 2, 1, None),
    ("one\r\ntwo\r\nthree", 1, 1, "     2\ttwo"),
    ("one\rtwo\rthree", 1, 2, "     2\ttwo\n     3\tthree"),
    ("one\n\nthree", 1, 1, "     2\t"),
    ("one\ntwo", 1, 1, "     2\ttwo"),
])
async def test_line_range_boundaries(tmp_path, contents, offset, limit, expected):
    path = tmp_path / "sample.txt"
    path.write_bytes(contents.encode())
    result = await FileReadTool().execute(FileReadToolInput(path=path.name, offset=offset, limit=limit), ToolExecutionContext(cwd=tmp_path))
    assert not result.is_error
    assert result.output == expected if expected is not None else "선택한 범위에 내용이 없습니다" in result.output


@pytest.mark.asyncio
async def test_many_large_lines_have_bounded_output(tmp_path):
    path = tmp_path / "large.txt"
    path.write_bytes(("한" * 400000 + "\n").encode() * 4)
    result = await FileReadTool().execute(FileReadToolInput(path=path.name), ToolExecutionContext(cwd=tmp_path))
    assert result.output.endswith(FILE_READ_TRUNCATION_NOTICE)
    assert len(result.output) == FILE_READ_MAX_OUTPUT_CHARS + len(FILE_READ_TRUNCATION_NOTICE)


@pytest.mark.asyncio
async def test_binary_in_requested_range_is_rejected(tmp_path):
    path = tmp_path / "binary.dat"
    path.write_bytes(b"header\n\x00data\n")
    result = await FileReadTool().execute(FileReadToolInput(path=path.name), ToolExecutionContext(cwd=tmp_path))
    assert result.is_error

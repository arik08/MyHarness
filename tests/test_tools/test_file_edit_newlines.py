import pytest

from myharness.tools.base import ToolExecutionContext
from myharness.tools.file_edit_tool import FileEditTool, FileEditToolInput
from myharness.tools.file_write_tool import FileWriteTool, FileWriteToolInput


async def edit(tmp_path, original: bytes, **kwargs):
    path = tmp_path / "sample.txt"
    path.write_bytes(original)
    result = await FileEditTool().execute(FileEditToolInput(path=path.name, **kwargs), ToolExecutionContext(cwd=tmp_path))
    return result, path.read_bytes()


@pytest.mark.asyncio
@pytest.mark.parametrize("original", [b"one\ntwo\n", b"one\r\ntwo\r\n", b"one\rtwo\r", b"one\r\ntwo\nlast\r", b"\xef\xbb\xbfone\ntwo", b"one"])
async def test_single_word_edit_preserves_all_other_bytes(tmp_path, original):
    result, saved = await edit(tmp_path, original, old_str="one", new_str="ONE")
    assert not result.is_error
    assert saved == original.replace(b"one", b"ONE", 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
@pytest.mark.parametrize("argument_newline", ["\n", "\r\n", "\r"])
async def test_multiline_edit_matches_normalized_read_output(tmp_path, newline, argument_newline):
    original = newline.join(["before", "a.*", "b", "after", ""]).encode()
    result, saved = await edit(tmp_path, original, old_str=f"a.*{argument_newline}b", new_str="A\nB\nC")
    assert not result.is_error
    assert saved == newline.join(["before", "A", "B", "C", "after", ""]).encode()


@pytest.mark.asyncio
async def test_replace_all_respects_each_occurrences_newlines(tmp_path):
    result, saved = await edit(tmp_path, b"a\r\nb\r\nmid\na\nb\n", old_str="a\nb", new_str="A\nB", replace_all=True)
    assert not result.is_error
    assert "치환 2건" in result.output
    assert saved == b"A\r\nB\r\nmid\nA\nB\n"


@pytest.mark.asyncio
async def test_noop_preserves_mixed_newlines_inside_match(tmp_path):
    original = b"a\r\nb\nc\r"
    result, saved = await edit(tmp_path, original, old_str="a\nb\nc\n", new_str="a\nb\nc\n")
    assert not result.is_error
    assert saved == original


@pytest.mark.asyncio
async def test_batch_failure_preserves_original_bytes(tmp_path):
    original = b"a\r\nb\n"
    result, saved = await edit(tmp_path, original, edits=[{"old_str": "a\nb", "new_str": "A\nB"}, {"old_str": "missing", "new_str": "new"}])
    assert result.is_error
    assert saved == original


@pytest.mark.asyncio
async def test_one_crlf_cannot_match_two_newlines(tmp_path):
    original = b"a\r\nb"
    result, saved = await edit(tmp_path, original, old_str="a\n\nb", new_str="new")
    assert result.is_error
    assert saved == original


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["one\ntwo\n", "one\r\ntwo\r\n", "one\rtwo\n", "\ufeff한글\n끝"])
async def test_complete_text_write_preserves_supplied_line_endings(tmp_path, content):
    result = await FileWriteTool().execute(FileWriteToolInput(path="sample.txt", content=content), ToolExecutionContext(cwd=tmp_path))
    assert not result.is_error
    assert (tmp_path / "sample.txt").read_bytes() == content.encode("utf-8")

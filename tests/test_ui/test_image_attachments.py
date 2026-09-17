import base64
from types import SimpleNamespace

import pytest

from myharness.ui.image_attachments import uploaded_image_blocks


@pytest.mark.parametrize("name,media_type,expected", [
    ("chart.png", "image/png", "image/png"),
    ("photo.jpeg", "image/jpeg", "image/jpeg"),
    ("photo.webp", "image/webp", "image/webp"),
    ("animation.gif", "image/gif", "image/gif"),
    ("screenshot.PNG", "application/octet-stream", "image/png"),
    ("screenshot.jpg", "", "image/jpeg"),
])
def test_loads_uploaded_image_bytes_without_absolute_model_paths(tmp_path, name, media_type, expected):
    relative = f".myharness/client-uploads/{name}"
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.write_bytes(b"exact image bytes")
    images = uploaded_image_blocks(str(tmp_path), [SimpleNamespace(path=relative, media_type=media_type)])
    assert len(images) == 1
    assert images[0].media_type == expected
    assert base64.b64decode(images[0].data) == target.read_bytes()
    assert images[0].source_path == relative


@pytest.mark.parametrize("case", ["missing", "outside", "empty", "oversized"])
def test_invalid_uploaded_images_fail_before_model_request(tmp_path, monkeypatch, case):
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "image.png"
    if case == "outside":
        target = tmp_path / "outside.png"
    if case != "missing":
        target.write_bytes(b"" if case == "empty" else b"image")
    if case == "oversized":
        monkeypatch.setattr("myharness.ui.image_attachments.MAX_IMAGE_BYTES", 4)
    with pytest.raises(ValueError) as error:
        uploaded_image_blocks(root, [SimpleNamespace(path=str(target), media_type="image/png")])
    assert str(tmp_path) not in str(error.value)


def test_documents_and_svg_remain_file_references(tmp_path):
    assert uploaded_image_blocks(tmp_path, [
        SimpleNamespace(path="source.pdf", media_type="application/pdf"),
        SimpleNamespace(path="diagram.svg", media_type="image/svg+xml"),
        SimpleNamespace(path="notes.txt", media_type="text/plain"),
    ]) == []

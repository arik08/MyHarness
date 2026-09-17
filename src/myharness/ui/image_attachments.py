"""Load uploaded images into the same model input used for pasted images."""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

from myharness.engine.messages import ImageBlock

MAX_IMAGE_BYTES = 10 * 1024 * 1024
_INLINE_MEDIA_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def uploaded_image_blocks(cwd: str | Path, attachment_refs: list[object]) -> list[ImageBlock]:
    root = Path(cwd).resolve()
    images = []
    for item in attachment_refs:
        relative = str(getattr(item, "path", "") or "").strip()
        media_type = str(getattr(item, "media_type", "") or "").strip().lower()
        if media_type in {"", "application/octet-stream"}:
            media_type = mimetypes.guess_type(relative)[0] or ""
        if media_type not in _INLINE_MEDIA_TYPES:
            continue
        try:
            target = (root / relative).resolve()
            normalized = target.relative_to(root).as_posix()
            with target.open("rb") as stream:
                content = stream.read(MAX_IMAGE_BYTES + 1)
        except (OSError, ValueError) as exc:
            raise ValueError("첨부 이미지를 읽을 수 없습니다. 파일을 다시 첨부해 주세요.") from exc
        if not content:
            raise ValueError("첨부 이미지가 비어 있습니다. 파일을 다시 첨부해 주세요.")
        if len(content) > MAX_IMAGE_BYTES:
            raise ValueError("이미지는 10MB 이하만 첨부할 수 있습니다.")
        images.append(ImageBlock(
            media_type=media_type,
            data=base64.b64encode(content).decode("ascii"),
            source_path=normalized,
        ))
    return images

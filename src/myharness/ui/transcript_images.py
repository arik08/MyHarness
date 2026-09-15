"""Small, durable image references for transcript rendering."""

from __future__ import annotations

import base64
import binascii
import hashlib
import logging
from pathlib import Path

_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg"}


def transcript_images(cwd: Path, attachments, attachment_refs) -> list[dict[str, str]]:
    images = []
    for index, item in enumerate(attachments):
        media_type = str(getattr(item, "media_type", ""))
        if media_type not in _EXTENSIONS or not getattr(item, "data", ""):
            continue
        try:
            content = base64.b64decode(item.data, validate=True)
            if not content:
                continue
            relative = Path(".myharness/client-uploads/images") / (hashlib.sha256(content).hexdigest() + _EXTENSIONS[media_type])
            target = (Path(cwd) / relative).resolve()
            target.relative_to(Path(cwd).resolve())
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(content)
            images.append({"name": item.name or f"이미지 {index + 1}", "path": relative.as_posix(), "media_type": media_type})
        except (OSError, ValueError, binascii.Error):
            logging.getLogger(__name__).warning("Could not save transcript image preview", exc_info=True)
    for item in attachment_refs:
        if str(getattr(item, "media_type", "")).startswith("image/") and getattr(item, "path", ""):
            images.append({"name": item.name or Path(item.path).name, "path": item.path, "media_type": item.media_type})
    return images

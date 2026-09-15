import base64

from myharness.ui.protocol import BackendEvent, FrontendAttachment, TranscriptItem
from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost
from myharness.ui.transcript_images import transcript_images


def test_images_persist_as_references_and_survive_history_serialization(tmp_path):
    content = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WZkAAAAASUVORK5CYII=")
    image = FrontendAttachment(media_type="image/png", data=base64.b64encode(content).decode(), name="arbitrary.png")
    refs = [FrontendAttachment(media_type="image/webp", path=".myharness/client-uploads/photo.webp", name="photo.webp")]
    images = transcript_images(tmp_path, [image], refs)
    assert len(images) == 2
    assert (tmp_path / images[0]["path"]).read_bytes() == content
    assert "data" not in images[0]
    assert transcript_images(tmp_path, [image], refs) == images
    host = ReactBackendHost(BackendHostConfig())
    event = BackendEvent(type="transcript_item", item=TranscriptItem(role="user", text="[image attachments: 1]", display_text="", images=images))
    host._record_history_event(event)
    assert host._history_events[0]["images"] == images
    assert host._history_events[0]["display_text"] == ""
    assert BackendEvent.model_validate_json(event.model_dump_json()).item.images == images


def test_invalid_images_do_not_break_submission(tmp_path):
    images = transcript_images(tmp_path, [FrontendAttachment(media_type="image/png", data="bad base64!", name="bad.png")], [])
    assert images == []
    assert list(tmp_path.iterdir()) == []

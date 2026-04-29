from __future__ import annotations

from myharness.channels.impl.base import resolve_channel_media_dir


def test_resolve_channel_media_dir_uses_ohmo_workspace(monkeypatch, tmp_path):
    workspace = tmp_path / ".ohmo-home"
    monkeypatch.setenv("OHMO_WORKSPACE", str(workspace))
    monkeypatch.delenv("MYHARNESS_CHANNEL_MEDIA_DIR", raising=False)
    monkeypatch.delenv("MYHARNESS_DATA_DIR", raising=False)

    media_dir = resolve_channel_media_dir("feishu")

    assert media_dir == workspace / "attachments" / "feishu"
    assert media_dir.is_dir()


def test_resolve_channel_media_dir_uses_myharness_data_dir(monkeypatch, tmp_path):
    data_dir = tmp_path / ".myharness-data"
    monkeypatch.delenv("OHMO_WORKSPACE", raising=False)
    monkeypatch.delenv("MYHARNESS_CHANNEL_MEDIA_DIR", raising=False)
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(data_dir))

    media_dir = resolve_channel_media_dir("telegram")

    assert media_dir == data_dir / "media" / "telegram"
    assert media_dir.is_dir()

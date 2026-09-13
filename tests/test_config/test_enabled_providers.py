"""Only the two supported provider workflows may be selected."""
import pytest

from myharness.config.settings import Settings, ProviderProfile, default_provider_profiles


def test_catalog_contains_only_pgpt_and_codex():
    assert set(default_provider_profiles()) == {"p-gpt", "codex"}


@pytest.mark.parametrize("name", ["gemini", "claude-api", "claude-subscription", "openai-compatible", "copilot", "moonshot", "minimax", "custom"])
def test_saved_disabled_provider_cannot_return_or_be_selected(name):
    settings = Settings(active_profile=name, profiles={name: ProviderProfile(
        label="Disabled", default_model="test-model", provider="gemini", api_format="openai", auth_source="gemini_api_key",
    )})
    assert set(settings.merged_profiles()) == {"p-gpt", "codex"}
    assert settings.resolve_profile()[0] == "p-gpt"
    with pytest.raises(ValueError, match="Disabled or unknown"):
        settings.resolve_profile(name)


def test_saved_profile_cannot_replace_enabled_provider_with_disabled_one():
    settings = Settings(profiles={"codex": ProviderProfile(
        label="Disabled", default_model="test-model", provider="anthropic", api_format="anthropic", auth_source="anthropic_api_key",
    )})
    assert settings.resolve_profile("codex")[1].provider == "openai_codex"


def test_provider_menu_contains_only_enabled_workflows(monkeypatch):
    from myharness.auth.manager import AuthManager
    from myharness.runtime_catalog import _provider_select_options
    monkeypatch.setattr(AuthManager, "get_auth_source_statuses", lambda self: {})
    assert [item["value"] for item in _provider_select_options(Settings())] == ["p-gpt", "codex"]

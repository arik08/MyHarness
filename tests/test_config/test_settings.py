"""Tests for myharness.config.settings."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from myharness.config.settings import (
    ProviderProfile,
    Settings,
    display_model_setting,
    load_settings,
    model_output_profile,
    report_token_limits_for_model,
    supported_model_output_token_limits,
    normalize_anthropic_model_name,
    save_settings,
    strip_ansi_escape_sequences,
    _apply_env_overrides,
)


def test_checked_in_project_settings_default_to_pgpt(tmp_path):
    settings_path = Path(__file__).resolve().parents[2] / ".myharness" / "settings.json"
    # Inspect the shipped default independently of local overrides and ADMIN policy.
    isolated_path = tmp_path / "settings.json"
    isolated_path.write_bytes(settings_path.read_bytes())
    settings = load_settings(isolated_path, apply_model_policy=False)

    assert settings.active_profile == "p-gpt"
    assert settings.provider == "openai"
    assert settings.api_format == "openai"
    assert settings.resolve_profile()[0] == "p-gpt"
    assert settings.model == settings.resolve_profile()[1].default_model
    assert settings.resolve_profile()[1].allows_model(settings.model)
    assert settings.effort == "low"


class TestSettings:
    def test_defaults(self):
        s = Settings()
        assert s.api_key == ""
        assert s.model == "claude-sonnet-4-6"
        assert s.max_tokens == 42000
        assert s.timeout == 180.0
        assert s.max_turns == 200
        assert s.fast_mode is False
        assert s.effort == "low"
        assert s.permission.mode == "default"
        assert s.sandbox.enabled is False
        assert s.sandbox.filesystem.allow_write == ["."]

    def test_env_override_keeps_max_tokens_user_configurable(self, monkeypatch):
        monkeypatch.setenv("MYHARNESS_MAX_TOKENS", "12345")

        updated = _apply_env_overrides(Settings())

        assert updated.max_tokens == 12345
        assert updated.effective_max_tokens("gpt-5.5") == 12345

    def test_gpt55_output_profile(self):
        profile = model_output_profile("gpt-5.5")

        assert profile.context_window_tokens == 1_050_000
        assert profile.model_max_output_tokens == 128_000
        assert profile.interactive_max_tokens == 42_000
        assert report_token_limits_for_model("gpt-5.5") == {
            "outline": 8_000,
            "section": 18_000,
            "review": 8_000,
        }

    def test_gpt54_mini_output_profile(self):
        profile = model_output_profile("gpt-5.4-mini")

        assert profile.context_window_tokens == 400_000
        assert profile.model_max_output_tokens == 128_000
        assert profile.interactive_max_tokens == 42_000
        assert report_token_limits_for_model("gpt-5.4-mini") == {
            "outline": 6_000,
            "section": 14_000,
            "review": 6_000,
        }

    def test_gpt54_output_profile(self):
        profile = model_output_profile("gpt-5.4")

        assert profile.context_window_tokens == 1_050_000
        assert profile.model_max_output_tokens == 128_000
        assert profile.interactive_max_tokens == 42_000
        assert report_token_limits_for_model("gpt-5.4") == {
            "outline": 8_000,
            "section": 18_000,
            "review": 8_000,
        }

    def test_model_specific_output_token_limit_overrides_global_limit(self):
        settings = Settings(
            model="gpt-5.4-mini",
            max_tokens=42_000,
            model_output_token_limits={"gpt-5.4-mini": 14_000},
        )

        assert settings.effective_max_tokens() == 14_000

    def test_model_specific_output_token_limit_is_capped_to_official_max(self):
        settings = Settings(
            model="gpt-5.5",
            model_output_token_limits={"gpt-5.5": 200_000},
        )

        assert settings.effective_max_tokens() == 128_000

    def test_supported_model_output_token_limits(self):
        assert supported_model_output_token_limits() == {
            "gpt-5.6-luna": 128_000,
            "gpt-5.6-terra": 128_000,
            "gpt-5.6-sol": 128_000,
            "gpt-5.5": 128_000,
            "gpt-5.4": 128_000,
            "gpt-5.4-mini": 128_000,
        }

    def test_resolve_api_key_from_instance(self):
        s = Settings(api_key="sk-test-123")
        assert s.resolve_api_key() == "sk-test-123"

    def test_resolve_api_key_from_env(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-456")
        s = Settings()
        assert s.resolve_api_key() == "sk-env-456"

    def test_resolve_api_key_instance_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-456")
        s = Settings(api_key="sk-instance-789")
        assert s.resolve_api_key() == "sk-instance-789"

    def test_resolve_api_key_missing_raises(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        s = Settings()
        with pytest.raises(ValueError, match="No API key found"):
            s.resolve_api_key()

    def test_merge_cli_overrides(self):
        s = Settings(active_profile="p-gpt")
        updated = s.merge_cli_overrides(model="gpt-5.6-terra", verbose=True, api_key=None)
        assert updated.model == "gpt-5.6-terra"
        assert updated.verbose is True
        # api_key=None should not override the default
        assert updated.api_key == ""

    def test_merge_cli_overrides_returns_new_instance(self):
        s = Settings(active_profile="p-gpt")
        updated = s.merge_cli_overrides(model="gpt-5.6-terra")
        assert s.model != updated.model
        assert s is not updated

    def test_merge_cli_overrides_keeps_selected_profile_provider_with_model(self):
        s = Settings()
        updated = s.merge_cli_overrides(active_profile="codex", model="gpt-5.6-sol")

        profile_name, profile = updated.resolve_profile()
        assert profile_name == "codex"
        assert profile.provider == "openai_codex"
        assert updated.provider == "openai_codex"
        assert updated.model == "gpt-5.6-sol"
        assert profile.last_model == "gpt-5.6-sol"




    def test_env_overrides_pick_up_compact_threshold_settings(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("MYHARNESS_CONTEXT_WINDOW_TOKENS", "123456")
        monkeypatch.setenv("MYHARNESS_AUTO_COMPACT_THRESHOLD_TOKENS", "120000")
        path = tmp_path / "settings.json"
        path.write_text(json.dumps({}))
        s = load_settings(path)
        assert s.context_window_tokens == 123456
        assert s.auto_compact_threshold_tokens == 120000



class TestLoadSaveSettings:
    def test_load_missing_file_returns_defaults(self, tmp_path: Path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
        monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
        monkeypatch.delenv("MYHARNESS_BASE_URL", raising=False)
        monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
        monkeypatch.delenv("MYHARNESS_MODEL", raising=False)
        path = tmp_path / "nonexistent.json"
        s = load_settings(path)
        assert s == Settings().materialize_active_profile()

    def test_load_existing_file(self, tmp_path: Path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
        monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
        monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
        monkeypatch.delenv("MYHARNESS_MODEL", raising=False)
        path = tmp_path / "settings.json"
        path.write_text(json.dumps({"active_profile": "p-gpt", "api_format": "openai", "provider": "openai", "model": "gpt-5.6-terra", "profiles": {"p-gpt": {"label": "P-GPT", "provider": "openai", "api_format": "openai", "auth_source": "pgpt_api_key", "default_model": "gpt-5.6-luna", "last_model": "gpt-5.6-terra"}}, "verbose": True, "fast_mode": True}))
        s = load_settings(path)
        assert s.model == "gpt-5.6-terra"
        assert s.verbose is True
        assert s.fast_mode is True
        assert s.api_key == ""  # default preserved

    def test_save_and_load_roundtrip(self, tmp_path: Path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
        monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
        monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
        monkeypatch.delenv("MYHARNESS_MODEL", raising=False)
        path = tmp_path / "settings.json"
        original = Settings(
            api_key="sk-roundtrip", active_profile="p-gpt", api_format="openai", provider="openai",
            model="gpt-5.6-terra",
            verbose=True,
            web_concurrency={
                "max_cpu_percent": 90,
                "max_memory_percent": 98,
                "max_busy_sessions_per_client": 4,
                "idle_session_timeout_minutes": 45,
            },
        )
        save_settings(original, path)
        loaded = load_settings(path)
        assert loaded.api_key == ""
        assert "api_key" not in json.loads(path.read_text(encoding="utf-8"))
        assert loaded.model == original.model
        assert loaded.verbose == original.verbose
        assert loaded.web_concurrency == original.web_concurrency

    def test_load_migrates_disabled_flat_provider_to_pgpt(self, tmp_path: Path):
        path = tmp_path / "settings.json"
        path.write_text(
            json.dumps(
                {
                    "api_format": "anthropic",
                    "provider": "anthropic",
                    "model": "kimi-k2.5",
                    "base_url": "https://api.moonshot.cn/anthropic",
                }
            ),
            encoding="utf-8",
        )

        loaded = load_settings(path)
        profile_name, profile = loaded.resolve_profile()

        assert profile_name == "p-gpt"
        assert profile.auth_source == "pgpt_api_key"
        assert profile.resolved_model == "gpt-5.6-luna"
        assert loaded.base_url == profile.base_url
        assert loaded.model == "gpt-5.6-luna"

    def test_materialize_active_profile_uses_profile_model(self):
        settings = Settings(
            active_profile="codex",
            profiles={
                "codex": ProviderProfile(
                    label="Codex Subscription",
                    provider="openai_codex",
                    api_format="openai",
                    auth_source="codex_subscription",
                    default_model="gpt-5.5",
                    last_model="gpt-5.6-sol",
                )
            },
        )

        materialized = settings.materialize_active_profile()

        assert materialized.provider == "openai_codex"
        assert materialized.api_format == "openai"
        assert materialized.model == "gpt-5.6-sol"

    def test_materialize_active_profile_projects_compact_threshold_settings(self):
        settings = Settings(
            active_profile="p-gpt",
            profiles={
                "p-gpt": ProviderProfile(
                    label="OpenAI-Compatible API",
                    provider="openai",
                    api_format="openai",
                    auth_source="pgpt_api_key",
                    default_model="gpt-5.6-luna",
                    context_window_tokens=100000,
                    auto_compact_threshold_tokens=90000,
                )
            },
        )

        materialized = settings.materialize_active_profile()

        assert materialized.context_window_tokens == 100000
        assert materialized.auto_compact_threshold_tokens == 90000

    def test_merge_cli_active_profile_does_not_inherit_flat_provider_fields(self):
        settings = Settings(
            active_profile="moonshot",
            provider="moonshot",
            api_format="openai",
            base_url="https://api.moonshot.cn/v1",
            model="kimi-k2.5",
            profiles={
                "moonshot": ProviderProfile(
                    label="Moonshot",
                    provider="moonshot",
                    api_format="openai",
                    auth_source="moonshot_api_key",
                    default_model="kimi-k2.5",
                    last_model="kimi-k2.5",
                    base_url="https://api.moonshot.cn/v1",
                ),
                "codex": ProviderProfile(
                    label="Codex Subscription",
                    provider="openai_codex",
                    api_format="openai",
                    auth_source="codex_subscription",
                    default_model="gpt-5.5",
                    last_model="gpt-5.5",
                ),
            },
        )

        updated = settings.merge_cli_overrides(active_profile="codex")
        profile_name, profile = updated.resolve_profile()

        assert profile_name == "codex"
        assert updated.provider == "openai_codex"
        assert updated.base_url is None
        assert updated.model == "gpt-5.6-luna"
        assert profile.provider == "openai_codex"
        assert profile.auth_source == "codex_subscription"

    def test_merge_cli_active_profile_keeps_profile_compact_threshold_settings(self):
        settings = Settings(
            active_profile="codex",
            context_window_tokens=64000,
            auto_compact_threshold_tokens=60000,
            profiles={
                "codex": ProviderProfile(
                    label="Moonshot",
                    provider="openai_codex",
                    api_format="openai",
                    auth_source="codex_subscription",
                    default_model="gpt-5.6-terra",
                    last_model="gpt-5.6-terra",
                    base_url="https://api.moonshot.cn/v1",
                    context_window_tokens=64000,
                    auto_compact_threshold_tokens=60000,
                ),
                "p-gpt": ProviderProfile(
                    label="OpenAI-Compatible API",
                    provider="openai",
                    api_format="openai",
                    auth_source="pgpt_api_key",
                    default_model="gpt-5.6-luna",
                    last_model="gpt-5.6-luna",
                    base_url="https://relay.example.com/v1",
                    context_window_tokens=200000,
                    auto_compact_threshold_tokens=180000,
                ),
            },
        )

        updated = settings.merge_cli_overrides(active_profile="p-gpt")

        assert updated.base_url == "https://relay.example.com/v1"
        assert updated.context_window_tokens == 200000
        assert updated.auto_compact_threshold_tokens == 180000




    def test_display_model_setting_uses_default_alias(self):
        profile = ProviderProfile(
            label="Claude API",
            provider="anthropic",
            api_format="anthropic",
            auth_source="anthropic_api_key",
            default_model="claude-sonnet-4-6",
            last_model=None,
        )

        assert display_model_setting(profile) == "default"




def test_normalize_anthropic_model_name_matches_hermes_behavior():
    assert normalize_anthropic_model_name("anthropic/claude-sonnet-4-20250514") == "claude-sonnet-4-20250514"
    assert normalize_anthropic_model_name("claude-opus-4.6") == "claude-opus-4-6"

    def test_save_creates_parent_dirs(self, tmp_path: Path):
        path = tmp_path / "deep" / "nested" / "settings.json"
        save_settings(Settings(), path)
        assert path.exists()

    def test_load_with_permission_settings(self, tmp_path: Path):
        path = tmp_path / "settings.json"
        path.write_text(
            json.dumps(
                {
                    "permission": {
                        "mode": "full_auto",
                        "allowed_tools": ["Bash", "Read"],
                    }
                }
            )
        )
        s = load_settings(path)
        assert s.permission.mode == "full_auto"
        assert s.permission.allowed_tools == ["Bash", "Read"]

    def test_load_applies_env_overrides(self, tmp_path: Path, monkeypatch):
        path = tmp_path / "settings.json"
        path.write_text(json.dumps({"model": "from-file", "base_url": "https://file.example"}))
        monkeypatch.setenv("ANTHROPIC_MODEL", "from-env-model")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://env.example/anthropic")
        monkeypatch.setenv("MYHARNESS_TIMEOUT", "42.5")
        monkeypatch.setenv("MYHARNESS_MAX_TURNS", "42")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env-override")
        monkeypatch.setenv("MYHARNESS_SANDBOX_ENABLED", "true")
        monkeypatch.setenv("MYHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE", "1")

        s = load_settings(path)

        assert s.model == "from-env-model"
        assert s.base_url == "https://env.example/anthropic"
        assert s.timeout == 42.5
        assert s.max_turns == 42
        assert s.api_key == ""
        assert s.resolve_auth().value == "sk-env-override"
        assert s.sandbox.enabled is True
        assert s.sandbox.fail_if_unavailable is True

    def test_load_with_sandbox_settings(self, tmp_path: Path):
        path = tmp_path / "settings.json"
        path.write_text(
            json.dumps(
                {
                    "sandbox": {
                        "enabled": True,
                        "enabled_platforms": ["linux", "wsl"],
                        "network": {"allowed_domains": ["github.com"]},
                        "filesystem": {"allow_write": [".", "/tmp"], "deny_write": [".env"]},
                    }
                }
            )
        )

        s = load_settings(path)

        assert s.sandbox.enabled is True
        assert s.sandbox.enabled_platforms == ["linux", "wsl"]
        assert s.sandbox.network.allowed_domains == ["github.com"]
        assert s.sandbox.filesystem.allow_write == [".", "/tmp"]
        assert s.sandbox.filesystem.deny_write == [".env"]


class TestAnsiEscapeSequences:
    """Tests for ANSI escape sequence handling in settings."""

    def test_strip_ansi_escape_sequences(self):
        """Test that ANSI escape sequences are properly stripped."""
        # Normal model name should pass through unchanged
        assert strip_ansi_escape_sequences("claude-opus-4-6") == "claude-opus-4-6"
        # Bold formatting should be stripped
        assert strip_ansi_escape_sequences("\x1b[1mclaude-opus-4-6\x1b[0m") == "claude-opus-4-6"
        # Green + bold formatting should be stripped
        assert strip_ansi_escape_sequences("\x1b[32m\x1b[1mclaude-opus-4-6\x1b[0m") == "claude-opus-4-6"
        # Only bold prefix
        assert strip_ansi_escape_sequences("\x1b[1mclaude-opus-4-6") == "claude-opus-4-6"
        # Only reset suffix
        assert strip_ansi_escape_sequences("claude-opus-4-6\x1b[0m") == "claude-opus-4-6"
        # Empty string should return empty string
        assert strip_ansi_escape_sequences("") == ""
        # None should return None
        assert strip_ansi_escape_sequences(None) is None


    def test_env_override_strips_ansi_from_myharness_model(self, monkeypatch):
        """Test that ANSI escape sequences are stripped from MYHARNESS_MODEL env var."""
        monkeypatch.setenv("MYHARNESS_MODEL", "\x1b[32mgpt-5.6-luna\x1b[0m")
        s = Settings(active_profile="p-gpt")
        updated = _apply_env_overrides(s)
        assert updated.model == "gpt-5.6-luna"

    def test_env_override_rejects_model_outside_profile_policy(self, monkeypatch):
        monkeypatch.setenv("MYHARNESS_MODEL", "gpt-4o")

        with pytest.raises(ValueError, match="not allowed for profile 'codex'"):
            _apply_env_overrides(Settings(active_profile="codex"))

    def test_merge_cli_overrides_strips_ansi_from_model(self):
        """Test that ANSI escape sequences are stripped from CLI model override."""
        s = Settings(active_profile="p-gpt")
        updated = s.merge_cli_overrides(model="\x1b[1mgpt-5.6-terra\x1b[0m")
        assert updated.model == "gpt-5.6-terra"


class TestGeminiProvider:
    """Tests for the Google Gemini OpenAI-compatible provider profile."""


    def test_gemini_compatible_not_in_default_provider_profiles(self):
        from myharness.config.settings import default_provider_profiles

        profiles = default_provider_profiles()
        assert "gemini-compatible" not in profiles

    def test_saved_gemini_compatible_profile_is_not_merged(self):
        settings = Settings(
            profiles={
                "gemini-compatible": ProviderProfile(
                    label="Gemini Compatible",
                    provider="openai",
                    api_format="openai",
                    auth_source="gemini_api_key",
                    default_model="gemini-3.5-flash",
                    base_url="https://generativelanguage.googleapis.com/v1beta/openai",
                    allowed_models=["gemini-3.5-flash"],
                )
            }
        )

        profiles = settings.merged_profiles()

        assert "gemini-compatible" not in profiles

    def test_auth_source_provider_name_gemini(self):
        from myharness.config.settings import auth_source_provider_name

        assert auth_source_provider_name("gemini_api_key") == "gemini"

    def test_default_auth_source_for_gemini_provider(self):
        from myharness.config.settings import default_auth_source_for_provider

        assert default_auth_source_for_provider("gemini") == "gemini_api_key"






class TestMiniMaxProvider:
    """Tests for MiniMax provider profile and auth integration."""


    def test_auth_source_provider_name_minimax(self):
        from myharness.config.settings import auth_source_provider_name

        assert auth_source_provider_name("minimax_api_key") == "minimax"

    def test_default_auth_source_for_minimax_provider(self):
        from myharness.config.settings import default_auth_source_for_provider

        assert default_auth_source_for_provider("minimax") == "minimax_api_key"




class TestPgptOpenAICompatibleProvider:
    """Tests for the P-GPT OpenAI-compatible provider profile."""

    def test_pgpt_in_default_provider_profiles(self):
        from myharness.config.settings import default_provider_profiles

        profiles = default_provider_profiles()
        profile = profiles["p-gpt"]
        assert profile.label == "P-GPT"
        assert profile.provider == "openai"
        assert profile.api_format == "openai"
        assert profile.auth_source == "pgpt_api_key"
        assert profile.default_model == "gpt-5.6-luna"
        assert profile.allowed_models == [
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
        ]
        assert profile.base_url == "http://pgpt.posco.com/s01a01-gpt/v1"

    def test_codex_subscription_default_profile_includes_gpt56_family(self):
        from myharness.config.settings import default_provider_profiles

        profile = default_provider_profiles()["codex"]

        assert profile.label == "Codex Subscription"
        assert profile.provider == "openai_codex"
        assert profile.default_model == "gpt-5.6-luna"
        assert profile.allowed_models == [
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
        ]

    def test_builtin_model_policy_prunes_removed_saved_models(self, monkeypatch):
        from myharness.config.settings import BUILTIN_MODEL_POLICIES, ModelPolicy, ProviderProfile

        monkeypatch.setitem(
            BUILTIN_MODEL_POLICIES,
            "codex",
            ModelPolicy(default_model="gpt-5.6-luna", allowed_models=("gpt-5.6-luna",)),
        )
        settings = Settings(
            active_profile="codex",
            subagent_model="gpt-5.4-mini",
            profiles={
                "codex": ProviderProfile(
                    label="Codex Subscription",
                    provider="openai_codex",
                    api_format="openai",
                    auth_source="codex_subscription",
                    default_model="gpt-5.5",
                    last_model="gpt-5.5",
                    allowed_models=["gpt-5.5", "gpt-5.4"],
                )
            },
        )

        profile = settings.merged_profiles()["codex"]
        materialized = settings.materialize_active_profile()

        assert profile.default_model == "gpt-5.6-luna"
        assert profile.allowed_models == ["gpt-5.6-luna"]
        assert profile.last_model is None
        assert materialized.model == "gpt-5.6-luna"
        assert materialized.subagent_model == "gpt-5.6-luna"

    def test_cli_model_override_rejects_model_outside_profile_policy(self):
        with pytest.raises(ValueError, match="not allowed for profile 'codex'"):
            Settings(active_profile="codex").merge_cli_overrides(model="gpt-4o")

    def test_cli_subagent_model_override_rejects_model_outside_profile_policy(self):
        with pytest.raises(ValueError, match="not allowed for profile 'codex'"):
            Settings(active_profile="codex").merge_cli_overrides(subagent_model="gpt-4o")

    @pytest.mark.parametrize("profile_name", ["p-gpt", "codex"])
    def test_gpt55_is_rejected_by_gpt56_only_profiles(self, profile_name):
        with pytest.raises(ValueError, match=f"not allowed for profile '{profile_name}'"):
            Settings(active_profile=profile_name).merge_cli_overrides(model="gpt-5.5")

    def test_codex_saved_builtin_profile_receives_new_allowed_models(self):
        from myharness.config.settings import ProviderProfile

        settings = Settings(
            profiles={
                "codex": ProviderProfile(
                    label="Codex Subscription",
                    provider="openai_codex",
                    api_format="openai",
                    auth_source="codex_subscription",
                    default_model="gpt-5.4",
                    last_model="gpt-5.4",
                    allowed_models=["gpt-5.4"],
                )
            }
        )

        profile = settings.merged_profiles()["codex"]

        assert profile.allowed_models == [
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
        ]
        assert profile.last_model is None

    def test_pgpt_saved_builtin_profile_receives_new_allowed_models(self):
        from myharness.config.settings import ProviderProfile

        settings = Settings(
            profiles={
                "p-gpt": ProviderProfile(
                    label="P-GPT",
                    provider="openai",
                    api_format="openai",
                    auth_source="pgpt_api_key",
                    default_model="gpt-5.4",
                    base_url="http://pgpt.posco.com/s0la01-gpt/v1",
                    last_model="gpt-5.4",
                    allowed_models=["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
                )
            }
        )

        profile = settings.merged_profiles()["p-gpt"]

        assert profile.allowed_models == [
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
        ]
        assert profile.last_model is None

    def test_pgpt_saved_removed_model_falls_back_to_builtin_default(self):
        from myharness.config.settings import ProviderProfile

        settings = Settings(
            profiles={
                "p-gpt": ProviderProfile(
                    label="P-GPT",
                    provider="openai",
                    api_format="openai",
                    auth_source="pgpt_api_key",
                    default_model="gpt-5.5",
                    base_url="http://pgpt.posco.com/s0la01-gpt/v1",
                    last_model="gpt-5.5",
                    allowed_models=["gpt-5.5", "gpt-5.4"],
                )
            }
        )

        profile = settings.merged_profiles()["p-gpt"]
        materialized = settings.materialize_active_profile()

        assert profile.default_model == "gpt-5.6-luna"
        assert profile.last_model is None
        assert materialized.model == "gpt-5.6-luna"

    def test_pgpt_saved_builtin_default_moves_to_gpt56_luna_when_no_last_model(self):
        from myharness.config.settings import ProviderProfile

        settings = Settings(
            profiles={
                "p-gpt": ProviderProfile(
                    label="P-GPT",
                    provider="openai",
                    api_format="openai",
                    auth_source="pgpt_api_key",
                    default_model="gpt-5.5",
                    base_url="http://pgpt.posco.com/s0la01-gpt/v1",
                    last_model=None,
                    allowed_models=["gpt-5.5", "gpt-5.4"],
                )
            }
        )

        profile = settings.merged_profiles()["p-gpt"]
        materialized = settings.materialize_active_profile()

        assert profile.default_model == "gpt-5.6-luna"
        assert profile.last_model is None
        assert materialized.model == "gpt-5.6-luna"

    def test_default_profile_is_pgpt(self):
        materialized = Settings().materialize_active_profile()

        assert materialized.active_profile == "p-gpt"
        assert materialized.provider == "openai"
        assert materialized.api_format == "openai"
        assert materialized.model == "gpt-5.6-luna"
        assert materialized.effort == "low"

    def test_auth_source_provider_name_pgpt(self):
        from myharness.config.settings import auth_source_provider_name

        assert auth_source_provider_name("pgpt_api_key") == "pgpt"

    def test_resolve_auth_reads_pgpt_api_key_env(self, monkeypatch):
        monkeypatch.setenv("PGPT_API_KEY", "pgpt-test-key")
        settings = Settings(active_profile="p-gpt")

        resolved = settings.resolve_auth()

        assert resolved.provider == "openai"
        assert resolved.value == "pgpt-test-key"
        assert "PGPT_API_KEY" in resolved.source

    def test_resolve_auth_reads_pgpt_api_key_from_credentials_file(self, tmp_path, monkeypatch):
        from myharness.auth.storage import store_credential

        monkeypatch.delenv("PGPT_API_KEY", raising=False)
        monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path))
        store_credential("pgpt", "api_key", "pgpt-file-key", use_keyring=False)
        settings = Settings(active_profile="p-gpt")

        resolved = settings.resolve_auth()

        assert resolved.provider == "openai"
        assert resolved.value == "pgpt-file-key"
        assert resolved.source == "file:pgpt"

    def test_resolve_auth_prefers_pgpt_env_over_credentials_file(self, tmp_path, monkeypatch):
        from myharness.auth.storage import store_credential

        monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path))
        monkeypatch.setenv("PGPT_API_KEY", "pgpt-env-key")
        store_credential("pgpt", "api_key", "pgpt-file-key", use_keyring=False)
        settings = Settings(active_profile="p-gpt")

        resolved = settings.resolve_auth()

        assert resolved.value == "pgpt-env-key"
        assert resolved.source == "env:PGPT_API_KEY"

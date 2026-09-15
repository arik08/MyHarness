"""Lightweight provider/model metadata, available before engine imports."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from myharness.api.provider import detect_provider
from myharness.auth.manager import AuthManager
from myharness.config.settings import CLAUDE_MODEL_ALIAS_OPTIONS, Settings, load_settings, resolve_model_setting
from myharness.project_preferences import apply_project_preferences_to_settings


def _provider_select_options(settings: Settings) -> list[dict[str, object]]:
    statuses = AuthManager(settings).get_profile_statuses()
    hidden_profiles = {"copilot", "moonshot", "minimax"}
    hidden_providers = {"copilot", "moonshot", "minimax"}
    return [
        {
            "value": name,
            "label": info["label"],
            "description": f"{info['provider']} / {info['auth_source']}" + (" [missing auth]" if not info["configured"] else ""),
            "active": info["active"],
        }
        for name, info in statuses.items()
        if name not in hidden_profiles and info["provider"] not in hidden_providers
    ]



def _effort_select_options(settings: Settings) -> list[dict[str, object]]:
    return [
        {"value": "none", "label": "Auto", "description": "Use the model's default reasoning effort", "active": settings.effort in {"none", "auto", ""}},
        {"value": "low", "label": "Low", "description": "Fastest responses", "active": settings.effort == "low"},
        {"value": "medium", "label": "Medium", "description": "Balanced reasoning", "active": settings.effort == "medium"},
        {"value": "high", "label": "High", "description": "Deepest reasoning", "active": settings.effort == "high"},
    ]



def _model_select_options(current_model: str, provider: str, allowed_models: list[str] | None = None) -> list[dict[str, object]]:
    provider_name = provider.lower()
    if allowed_models:
        return [
            {
                "value": value,
                "label": value,
                "description": _model_option_description(provider_name, value),
                "active": value == current_model,
            }
            for value in allowed_models
        ]
    if provider_name in {"anthropic", "anthropic_claude"}:
        resolved_current = resolve_model_setting(current_model, provider_name)
        return [
            {
                "value": value,
                "label": label,
                "description": description,
                "active": value == current_model
                or resolve_model_setting(value, provider_name) == resolved_current,
            }
            for value, label, description in CLAUDE_MODEL_ALIAS_OPTIONS
        ]
    families: list[tuple[str, str]] = []
    if provider_name == "pgpt":
        families.extend(
            [
                ("gpt-5.6-luna", _model_option_description(provider_name, "gpt-5.6-luna")),
                ("gpt-5.6-terra", _model_option_description(provider_name, "gpt-5.6-terra")),
                ("gpt-5.6-sol", _model_option_description(provider_name, "gpt-5.6-sol")),
                ("gpt-5.5", _model_option_description(provider_name, "gpt-5.5")),
                ("gpt-5.4", _model_option_description(provider_name, "gpt-5.4")),
                ("gpt-5.4-mini", _model_option_description(provider_name, "gpt-5.4-mini")),
                ("gpt-5.4-nano", _model_option_description(provider_name, "gpt-5.4-nano")),
            ]
        )
    elif provider_name in {"openai_codex", "openai-codex", "openai", "openai-compatible", "openrouter", "github_copilot"}:
        families.extend(
            [
                ("gpt-5.5", "OpenAI flagship"),
                ("gpt-5.4", "Previous GPT-5.4"),
                ("gpt-5.4-mini", _model_option_description(provider_name, "gpt-5.4-mini")),
                ("gpt-5.4-nano", _model_option_description(provider_name, "gpt-5.4-nano")),
                ("gpt-5", "General GPT-5"),
                ("gpt-4.1", "Stable GPT-4.1"),
                ("o4-mini", "Fast reasoning"),
            ]
        )
    elif provider_name in {"moonshot", "moonshot-compatible"}:
        families.extend(
            [
                ("kimi-k2.5", "Moonshot K2.5"),
                ("kimi-k2-turbo-preview", "Faster Moonshot"),
            ]
        )
    elif provider_name == "dashscope":
        families.extend(
            [
                ("qwen3.5-flash", "Fast Qwen"),
                ("qwen3-max", "Strong Qwen"),
                ("deepseek-r1", "Reasoning model"),
            ]
        )
    elif provider_name == "gemini":
        families.extend(
            [
                ("gemini-3.5-flash", "Gemini 3.5 Flash stable"),
                ("gemini-3.1-pro-preview", "Gemini 3.1 Pro preview"),
                ("gemini-3-flash-preview", "Gemini 3 Flash preview"),
                ("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite stable"),
            ]
        )
    elif provider_name == "minimax":
        families.extend(
            [
                ("MiniMax-M2.7", "MiniMax flagship"),
                ("MiniMax-M2.7-highspeed", "MiniMax fast"),
            ]
        )
    seen: set[str] = set()
    options: list[dict[str, object]] = []
    for value, description in [*families, (current_model, "Current model")]:
        if not value or value in seen:
            continue
        seen.add(value)
        options.append(
            {
                "value": value,
                "label": value,
                "description": description,
                "active": value == current_model,
            }
        )
    return options



def _model_option_description(provider_name: str, model: str) -> str:
    normalized = model.strip().lower()
    if normalized == "gpt-5.6-luna":
        return "Fast and affordable GPT-5.6"
    if normalized == "gpt-5.6-terra":
        return "Balanced GPT-5.6"
    if normalized == "gpt-5.6-sol":
        return "Frontier GPT-5.6"
    if normalized == "gpt-5.5":
        return "Strongest coding and reasoning"
    if normalized == "gpt-5.4":
        return "Balanced default model"
    if normalized == "gpt-5.4-mini":
        return "Faster and lighter"
    if normalized == "gpt-5.4-nano":
        return "Lowest latency"
    if provider_name == "gemini" or normalized.startswith("gemini-"):
        return {
            "gemini-3.5-flash": "Gemini 3.5 Flash stable",
            "gemini-3.1-pro-preview": "Gemini 3.1 Pro preview",
            "gemini-3-flash-preview": "Gemini 3 Flash preview",
            "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite stable",
        }.get(normalized, "Gemini model")
    if provider_name == "pgpt":
        return "P-GPT model"
    return "Available model"



def _runtime_picker_options(settings: Settings) -> dict[str, object]:
    """Build the provider/model choices shared by startup and live refreshes."""
    from myharness.context_policy import get_context_window, get_long_context_policy_threshold
    from myharness.api.pricing import LONG_CONTEXT_INPUT_TOKEN_THRESHOLD

    window = get_context_window(settings.model, context_window_tokens=settings.context_window_tokens or settings.memory.context_window_tokens)
    standard = get_long_context_policy_threshold(settings.model, "cost-saver", context_window_tokens=window)
    provider_options = _provider_select_options(settings)
    profiles = AuthManager(settings).list_profiles()
    catalog = {
        str(option["value"]): _model_select_options(
            settings.model, profiles[str(option["value"])].provider,
            profiles[str(option["value"])].allowed_models,
        )
        for option in provider_options if str(option["value"]) in profiles
    }
    for profile, models in catalog.items():
        enabled = settings.enabled_models_by_profile.get(profile)
        for model in models:
            model["enabled"] = enabled is None or model["value"] in enabled
    return {
        "providers": provider_options,
        "context_window": window,
        "standard_context_window": min(window, LONG_CONTEXT_INPUT_TOKEN_THRESHOLD) if standard else window,
        "context_mode_available": standard is not None and window > standard,
        "all_models_by_provider": catalog,
        "models_by_provider": {profile: [model for model in models if model["enabled"]] for profile, models in catalog.items()},
        "subagent_model": settings.subagent_model,
        "subagent_effort": settings.subagent_effort,
        "efforts": _effort_select_options(settings),
    }



def _initial_runtime_state_snapshot(config: Any) -> dict[str, object]:
    """Return the runtime fields that are cheap to know before full startup."""
    settings_overrides: dict[str, Any] = {
        "model": config.model,
        "subagent_model": config.subagent_model,
        "subagent_effort": config.subagent_effort,
        "max_turns": config.max_turns,
        "base_url": config.base_url,
        "system_prompt": config.system_prompt,
        "api_key": config.api_key,
        "api_format": config.api_format,
        "active_profile": config.active_profile,
        "effort": config.effort,
        "permission_mode": config.permission_mode,
    }
    cwd = str(Path(config.cwd).expanduser().resolve()) if config.cwd else str(Path.cwd())
    settings = load_settings().merge_cli_overrides(**settings_overrides)
    settings = apply_project_preferences_to_settings(settings, cwd)
    provider = detect_provider(settings)
    active_profile_name, active_profile = settings.resolve_profile()
    return {
        "model": settings.model,
        "subagent_model": settings.subagent_model,
        "subagent_effort": settings.subagent_effort,
        "cwd": cwd,
        "provider": provider.name,
        "active_profile": active_profile_name,
        "provider_label": active_profile.label,
        "base_url": settings.base_url or "",
        "permission_mode": settings.permission.mode.value,
        "theme": settings.theme,
        "vim_enabled": settings.vim_mode,
        "voice_enabled": settings.voice_mode,
        "fast_mode": settings.fast_mode,
        "effort": settings.effort,
        "passes": settings.passes,
        "output_style": settings.output_style,
        "runtime_options": _runtime_picker_options(settings),
    }

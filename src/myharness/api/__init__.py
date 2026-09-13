"""API exports."""

from importlib import import_module

_EXPORT_MODULES = {
    "AnthropicApiClient": "client",
    "CodexApiClient": "codex_client",
    "CopilotClient": "copilot_client",
    "OpenAICompatibleClient": "openai_client",
    "MyHarnessApiError": "errors",
    "ProviderInfo": "provider",
    "auth_status": "provider",
    "detect_provider": "provider",
    "UsageSnapshot": "usage",
}


def __getattr__(name):
    """Keep metadata imports independent of provider SDK initialization."""
    module = _EXPORT_MODULES.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f"{__name__}.{module}"), name)
    globals()[name] = value
    return value

__all__ = [
    "AnthropicApiClient",
    "CodexApiClient",
    "CopilotClient",
    "OpenAICompatibleClient",
    "MyHarnessApiError",
    "ProviderInfo",
    "UsageSnapshot",
    "auth_status",
    "detect_provider",
]

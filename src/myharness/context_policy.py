"""Input budgets shared by local and provider-managed context compaction."""

from myharness.api.pricing import LONG_CONTEXT_INPUT_TOKEN_THRESHOLD
from myharness.config.settings import model_output_profile


def get_long_context_policy_threshold(
    model: str, mode: str | None, *, context_window_tokens: int | None = None,
    auto_compact_threshold_tokens: int | None = None,
) -> int | None:
    """Use Lumina's cost headroom and preserve MyHarness's full-mode policy."""
    normalized = str(model or "").strip().lower().rsplit("/", 1)[-1]
    if not any(normalized == family or normalized.startswith(f"{family}-")
               for family in ("gpt-5.4", "gpt-5.5", "gpt-5.6")):
        return None
    if normalized.startswith(("gpt-5.4-mini", "gpt-5.4-nano")):
        return None
    profile = model_output_profile(normalized)
    model_window = profile.context_window_tokens or 1_050_000
    window = context_window_tokens or model_window
    reserved_output = profile.model_max_output_tokens or 128_000
    input_budget = max(1, window - reserved_output)
    if str(mode or "").strip().lower() == "full-context":
        # Preserve the existing explicit MyHarness full-context threshold.
        threshold = 1_000_000 if window >= model_window else max(1, input_budget * 85 // 100)
    else:
        threshold = max(1, min(input_budget, LONG_CONTEXT_INPUT_TOKEN_THRESHOLD) * 85 // 100)
    if auto_compact_threshold_tokens is not None and auto_compact_threshold_tokens > 0:
        threshold = min(threshold, auto_compact_threshold_tokens)
    return threshold


# Default context windows per model family
_DEFAULT_CONTEXT_WINDOW = 200_000
_OPENAI_CONTEXT_WINDOWS: tuple[tuple[str, int], ...] = (
    ("gpt-5.6-luna", 1_050_000),
    ("gpt-5.6-terra", 1_050_000),
    ("gpt-5.6-sol", 1_050_000),
    ("gpt-5.5", 1_050_000),
    ("gpt-5.4-mini", 400_000),
    ("gpt-5.4-nano", 400_000),
    ("gpt-5.4", 1_050_000),
    ("gpt-5.3-codex-spark", 128_000),
    ("gpt-5.3-codex", 400_000),
    ("gpt-5.2-codex", 400_000),
    ("gpt-5.2", 400_000),
    ("gpt-5-codex", 400_000),
    ("gpt-5-mini", 400_000),
    ("gpt-5-nano", 400_000),
    ("gpt-5", 400_000),
    ("gpt-4.1", 1_047_576),
    ("o3", 200_000),
    ("o4-mini", 200_000),
)


def get_context_window(model: str, *, context_window_tokens: int | None = None) -> int:
    """Return the context window size for a model (conservative defaults)."""
    if context_window_tokens is not None and context_window_tokens > 0:
        return int(context_window_tokens)
    m = model.lower()
    for prefix, window in _OPENAI_CONTEXT_WINDOWS:
        if m == prefix or m.startswith(f"{prefix}-"):
            return window
    if "opus" in m:
        return 200_000
    if "sonnet" in m:
        return 200_000
    if "haiku" in m:
        return 200_000
    # Kimi / other providers — be conservative
    return _DEFAULT_CONTEXT_WINDOW

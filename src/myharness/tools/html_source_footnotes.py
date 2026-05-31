"""Reusable source footnote styling for standalone HTML artifacts."""

from __future__ import annotations

import html
import re
from typing import Any

from myharness.tools.source_evidence import source_domain, source_evidence_for_url

SOURCE_FOOTNOTE_CSS_MARKER = "<!-- myharness:source-footnotes-css -->"
SOURCE_TOOLTIP_PLACEHOLDERS = {
    "",
    "verbatim source excerpt",
    "original source sentence",
    "원문에서 직접 가져온 발췌",
}

SOURCE_FOOTNOTE_CSS = """<style id="myharness-source-footnotes">
.source-ref{font-size:.72em;line-height:0;vertical-align:super;white-space:nowrap}
.source-ref a{position:relative;color:#0b65c2;font-weight:750;text-decoration:none}
.source-ref a:hover,.source-ref a:focus-visible{text-decoration:underline;text-underline-offset:2px}
.source-ref a[data-tooltip]::after{position:absolute;left:50%;bottom:calc(100% + 8px);z-index:80;width:min(420px,calc(100vw - 32px));padding:8px 10px;border-radius:7px;background:#111827;color:#fff;box-shadow:0 10px 24px rgba(15,23,42,.22);content:attr(data-tooltip);font-size:11px;font-weight:650;line-height:1.38;opacity:0;pointer-events:none;transform:translate(-50%,4px);transition:opacity .12s ease,transform .12s ease;white-space:pre-line}
.source-ref a[data-tooltip]:hover::after,.source-ref a[data-tooltip]:focus-visible::after{opacity:1;transform:translate(-50%,0)}
.sources{font-size:12px;line-height:1.55;color:#475569}
.sources a{color:#0b65c2;text-decoration:none}
.sources a:hover,.sources a:focus-visible{text-decoration:underline;text-underline-offset:2px}
@media print{.source-ref a[data-tooltip]::after{display:none}}
</style>"""


def source_evidence_tokens(value: str) -> set[str]:
    return set(re.findall(r"[가-힣a-z0-9][가-힣a-z0-9,.·%-]{1,}", value.lower()))


def source_evidence_chunks(value: str) -> list[str]:
    chunks = re.split(r"(?<=[.!?。！？]|[다요음임됨함])\s+|\n+", value)
    cleaned: list[str] = []
    for chunk in chunks:
        text = re.sub(r"\s+", " ", chunk).strip()
        if len(text) < 18 or re.match(r"^(?:URL|상태|Content-Type):", text, re.I):
            continue
        cleaned.append(f"{text[:177].strip()}..." if len(text) > 180 else text)
        if len(cleaned) >= 80:
            break
    return cleaned


def best_source_excerpt(evidence: str, context: str) -> str:
    chunks = source_evidence_chunks(evidence)
    if not chunks:
        return ""
    context_tokens = source_evidence_tokens(context[-260:])
    best = ""
    best_score = 0
    for chunk in chunks:
        chunk_tokens = source_evidence_tokens(chunk)
        score = sum(3 if any(char.isdigit() for char in token) else 1 for token in context_tokens if token in chunk_tokens)
        if score > best_score:
            best_score = score
            best = chunk
    return best if best_score > 0 else chunks[0]


def quoted_source_excerpt(value: str) -> str:
    text = str(value or "").strip()
    return f'"{text}"' if text else ""


def html_text_context(value: str) -> str:
    text = re.sub(r"(?is)<script\b.*?</script>|<style\b.*?</style>", " ", value)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _attr_value(attrs: str, name: str) -> str:
    match = re.search(rf"\b{re.escape(name)}=(['\"])(.*?)\1", attrs, flags=re.I | re.S)
    return html.unescape(match.group(2)) if match else ""


def _set_or_add_attr(attrs: str, name: str, value: str) -> str:
    escaped = html.escape(value, quote=True)
    pattern = re.compile(rf"\b{re.escape(name)}=(['\"])(.*?)\1", flags=re.I | re.S)
    if pattern.search(attrs):
        return pattern.sub(f'{name}="{escaped}"', attrs, count=1)
    return f'{attrs.rstrip()} {name}="{escaped}"'


def _should_replace_tooltip(value: str) -> bool:
    normalized = re.sub(r"\s+", " ", html.unescape(value or "")).strip()
    if normalized in SOURCE_TOOLTIP_PLACEHOLDERS:
        return True
    return any(normalized.endswith(f"\n{placeholder}") for placeholder in SOURCE_TOOLTIP_PLACEHOLDERS if placeholder)


def populate_source_footnote_tooltips(content: str, metadata: dict[str, Any] | None) -> str:
    """Populate HTML source-ref tooltip excerpts from stored web evidence."""

    pattern = re.compile(
        r"(?P<before><sup\b(?=[^>]*\bclass=(['\"])[^'\"]*\bsource-ref\b[^'\"]*\2)[^>]*>.*?<a\b)(?P<attrs>[^>]*)(?P<after>>.*?</a>.*?</sup>)",
        flags=re.I | re.S,
    )

    def replace(match: re.Match[str]) -> str:
        attrs = match.group("attrs")
        href = _attr_value(attrs, "href")
        if not href:
            return match.group(0)
        existing = _attr_value(attrs, "data-tooltip")
        if existing and not _should_replace_tooltip(existing):
            return match.group(0)
        evidence = source_evidence_for_url(metadata, href)
        if not evidence:
            return match.group(0)
        context = html_text_context(content[:match.start()])
        excerpt = best_source_excerpt(evidence, context)
        if not excerpt:
            return match.group(0)
        domain = source_domain(href) or href
        tooltip = f"{domain}\n{quoted_source_excerpt(excerpt)}"
        return f'{match.group("before")}{_set_or_add_attr(attrs, "data-tooltip", tooltip)}{match.group("after")}'

    return pattern.sub(replace, content)


def prepare_source_footnotes_html(content: str, suffix: str, metadata: dict[str, Any] | None) -> str:
    """Expand the fixed CSS marker and populate source-footnote tooltips."""

    if suffix.lower() not in {".html", ".htm"}:
        return content
    content = populate_source_footnote_tooltips(content, metadata)
    if SOURCE_FOOTNOTE_CSS_MARKER not in content:
        return content
    return content.replace(SOURCE_FOOTNOTE_CSS_MARKER, SOURCE_FOOTNOTE_CSS)


def expand_source_footnote_css_marker(content: str, suffix: str) -> str:
    """Replace the fixed source-footnote marker in HTML writes."""

    return prepare_source_footnotes_html(content, suffix, None)

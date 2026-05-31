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
.source-ref{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;line-height:1;margin-left:4px;white-space:nowrap;transform:translateY(-1px)}
.source-ref a{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:1px solid #bfdbfe;border-radius:50%;background:#eff6ff;color:#075985;font:750 10px/1 Arial,'Noto Sans KR',sans-serif;text-decoration:none;border-bottom:0}
.sources,.source-list{font-size:14px;line-height:1.7;color:#475569}
.sources a,.source-list a{color:#0b65c2;text-decoration:none!important;border-bottom:0!important}
.sources a:hover,.sources a:focus-visible,.source-list a:hover,.source-list a:focus-visible,.source-ref a:hover,.source-ref a:focus-visible{text-decoration:none}
.myharness-source-tooltip{position:fixed;z-index:2147483647;max-width:min(460px,calc(100vw - 24px));padding:9px 11px;border-radius:7px;background:#111827;color:#fff;box-shadow:0 10px 24px rgba(15,23,42,.22);font:650 13px/1.45 Arial,'Noto Sans KR',sans-serif;white-space:pre-line;pointer-events:none}
@media print{.myharness-source-tooltip{display:none}}
</style>
<script id="myharness-source-footnotes-script">
(() => {
  if (window.__myharnessSourceFootnotesReady) return;
  window.__myharnessSourceFootnotesReady = true;
  const tooltip = document.createElement("div");
  tooltip.className = "myharness-source-tooltip";
  tooltip.hidden = true;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const domain = (href) => {
    try { return new URL(href, document.baseURI).hostname.replace(/^www\\./, ""); } catch { return href || ""; }
  };
  const quoted = (value) => {
    const text = String(value || "").replace(/\\s+/g, " ").trim();
    return text ? '"' + text + '"' : "";
  };
  const sourceLinks = () => Array.from(document.querySelectorAll(".sources a[href], .source-list a[href]"));
  const normalizeLinks = () => {
    const links = sourceLinks();
    document.querySelectorAll(".source-ref a").forEach((anchor) => {
      const index = Number((anchor.textContent || "").replace(/\\D+/g, ""));
      const source = Number.isFinite(index) && index > 0 ? links[index - 1] : null;
      const href = anchor.getAttribute("href") || "";
      if (source && (!href || href.startsWith("#"))) {
        anchor.href = source.href;
      }
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      const host = anchor.closest(".source-ref");
      if (host && host.firstElementChild !== anchor) {
        host.replaceChildren(anchor);
      }
      if (!anchor.dataset.tooltip) {
        const label = source ? source.textContent : "";
        anchor.dataset.tooltip = [domain(anchor.href), quoted(label)].filter(Boolean).join("\\n");
      }
    });
  };
  const hide = () => { tooltip.hidden = true; };
  const show = (anchor) => {
    const text = anchor?.dataset?.tooltip || anchor?.href || "";
    if (!text) return;
    tooltip.textContent = text;
    if (!tooltip.parentNode) document.body.appendChild(tooltip);
    tooltip.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    const top = rect.top - tip.height - 8 >= 8 ? rect.top - tip.height - 8 : rect.bottom + 8;
    tooltip.style.top = Math.round(clamp(top, 8, window.innerHeight - tip.height - 8)) + "px";
    tooltip.style.left = Math.round(clamp(rect.left + rect.width / 2 - tip.width / 2, 8, window.innerWidth - tip.width - 8)) + "px";
  };
  const scheduleNormalize = () => {
    normalizeLinks();
    setTimeout(normalizeLinks, 120);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleNormalize, { once: true });
  } else {
    scheduleNormalize();
  }
  window.addEventListener("load", scheduleNormalize);
  new MutationObserver(scheduleNormalize).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("mouseover", (event) => {
    const anchor = event.target?.closest?.(".source-ref a[data-tooltip]");
    if (anchor) show(anchor);
  }, true);
  document.addEventListener("focusin", (event) => {
    const anchor = event.target?.closest?.(".source-ref a[data-tooltip]");
    if (anchor) show(anchor);
  }, true);
  document.addEventListener("mouseout", (event) => {
    if (event.target?.closest?.(".source-ref a[data-tooltip]")) hide();
  }, true);
  document.addEventListener("focusout", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
})();
</script>"""


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


def _has_http_url(value: str) -> bool:
    return bool(re.match(r"https?://", value or "", flags=re.I))


def _source_list_links(content: str) -> list[tuple[str, str]]:
    list_pattern = re.compile(
        r"<(?P<tag>ol|ul)\b(?=[^>]*\bclass=(['\"])[^'\"]*\b(?:sources|source-list)\b[^'\"]*\2)[^>]*>(?P<body>.*?)</(?P=tag)>",
        flags=re.I | re.S,
    )
    link_pattern = re.compile(r"<a\b(?P<attrs>[^>]*)>(?P<label>.*?)</a>", flags=re.I | re.S)
    links: list[tuple[str, str]] = []
    for list_match in list_pattern.finditer(content):
        for link_match in link_pattern.finditer(list_match.group("body")):
            href = _attr_value(link_match.group("attrs"), "href")
            if href:
                links.append((href, html_text_context(link_match.group("label"))))
    return links


def _source_ref_number(value: str) -> int | None:
    text = html_text_context(value)
    match = re.search(r"\d+", text)
    if not match:
        return None
    return int(match.group(0))


def normalize_source_ref_markers(content: str) -> str:
    pattern = re.compile(
        r"(?P<open><sup\b(?=[^>]*\bclass=(['\"])[^'\"]*\bsource-ref\b[^'\"]*\2)[^>]*>)\s*\(\s*(?P<link><a\b[^>]*>.*?</a>)\s*\)\s*(?P<close></sup>)",
        flags=re.I | re.S,
    )
    return pattern.sub(lambda match: f'{match.group("open")}{match.group("link")}{match.group("close")}', content)


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

    source_links = _source_list_links(content)
    pattern = re.compile(
        r"(?P<before><sup\b(?=[^>]*\bclass=(['\"])[^'\"]*\bsource-ref\b[^'\"]*\2)[^>]*>.*?<a\b)(?P<attrs>[^>]*)(?P<after>>.*?</a>.*?</sup>)",
        flags=re.I | re.S,
    )

    def replace(match: re.Match[str]) -> str:
        attrs = match.group("attrs")
        href = _attr_value(attrs, "href")
        number = _source_ref_number(match.group(0))
        source_link = source_links[number - 1] if number and 0 < number <= len(source_links) else None
        if (not href or not _has_http_url(href)) and source_link:
            href = source_link[0]
            attrs = _set_or_add_attr(attrs, "href", href)
        if not href:
            return match.group(0)
        attrs = _set_or_add_attr(attrs, "target", "_blank")
        attrs = _set_or_add_attr(attrs, "rel", "noreferrer")
        existing = _attr_value(attrs, "data-tooltip")
        if existing and not _should_replace_tooltip(existing):
            return f'{match.group("before")}{attrs}{match.group("after")}'
        evidence = source_evidence_for_url(metadata, href)
        context = html_text_context(content[:match.start()])
        excerpt = best_source_excerpt(evidence, context) if evidence else ""
        if not excerpt and source_link:
            excerpt = source_link[1]
        if not excerpt:
            return f'{match.group("before")}{attrs}{match.group("after")}'
        domain = source_domain(href) or href
        tooltip = f"{domain}\n{quoted_source_excerpt(excerpt)}"
        return f'{match.group("before")}{_set_or_add_attr(attrs, "data-tooltip", tooltip)}{match.group("after")}'

    return pattern.sub(replace, content)


def _needs_source_footnote_assets(content: str) -> bool:
    return bool(
        re.search(r"\bclass=(['\"])[^'\"]*\bsource-ref\b[^'\"]*\1", content, flags=re.I)
        or re.search(r"\bclass=(['\"])[^'\"]*\bsources\b[^'\"]*\1", content, flags=re.I)
        or re.search(r"\bclass=(['\"])[^'\"]*\bsource-list\b[^'\"]*\1", content, flags=re.I)
    )


def _strip_source_footnote_assets(content: str) -> str:
    content = re.sub(
        r"<style\b(?=[^>]*\bid=(['\"])myharness-source-footnotes\1)[^>]*>.*?</style>\s*",
        "",
        content,
        flags=re.I | re.S,
    )
    return re.sub(
        r"<script\b(?=[^>]*\bid=(['\"])myharness-source-footnotes-script\1)[^>]*>.*?</script>\s*",
        "",
        content,
        flags=re.I | re.S,
    )


def _insert_source_footnote_assets(content: str) -> str:
    if SOURCE_FOOTNOTE_CSS_MARKER in content:
        return _strip_source_footnote_assets(content).replace(SOURCE_FOOTNOTE_CSS_MARKER, SOURCE_FOOTNOTE_CSS)
    content = _strip_source_footnote_assets(content)
    if re.search(r"</head\s*>", content, flags=re.I):
        return re.sub(r"</head\s*>", lambda _match: f"{SOURCE_FOOTNOTE_CSS}\n</head>", content, count=1, flags=re.I)
    return f"{SOURCE_FOOTNOTE_CSS}\n{content}"


def prepare_source_footnotes_html(content: str, suffix: str, metadata: dict[str, Any] | None) -> str:
    """Expand the fixed CSS marker and populate source-footnote tooltips."""

    if suffix.lower() not in {".html", ".htm"}:
        return content
    content = normalize_source_ref_markers(content)
    content = populate_source_footnote_tooltips(content, metadata)
    if SOURCE_FOOTNOTE_CSS_MARKER not in content and not _needs_source_footnote_assets(content):
        return content
    return _insert_source_footnote_assets(content)


def expand_source_footnote_css_marker(content: str, suffix: str) -> str:
    """Replace the fixed source-footnote marker in HTML writes."""

    return prepare_source_footnotes_html(content, suffix, None)

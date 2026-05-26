import { useEffect, useRef } from "react";
import hljs from "highlight.js/lib/common";
import type { ArtifactSummary } from "../types/backend";
import type { ArtifactAiEditComment, ArtifactPayload } from "../types/ui";
import { artifactDisplayName, isSourceCodeArtifact, sourceLanguageForArtifact } from "../utils/artifacts";
import { Icon } from "./ArtifactIcons";
import { MarkdownMessage } from "./MarkdownMessage";

export const artifactFrameBackMessage = "myharness:artifact-panel-back";
export const artifactHtmlEditMessage = "myharness:artifact-html-edit";
export const artifactAiSelectionMessage = "myharness:artifact-ai-selection";
export const artifactAiCommentsMessage = "myharness:artifact-ai-comments";
export const artifactFrameScrollMessage = "myharness:artifact-frame-scroll";
export const artifactHtmlEditModeMessage = "myharness:artifact-html-edit-mode";

function iframeMermaidZoomBridge(content: string) {
  const value = String(content || "");
  if (!/\bmermaid\b/i.test(value)) {
    return value;
  }
  const bridge = `
<style data-myharness-mermaid-zoom-style="true">
.myharness-mermaid-zoom-host {
  position: relative !important;
}
.myharness-mermaid-expand-button {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 50;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(17, 24, 39, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.94);
  color: #17212f;
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.14);
  cursor: pointer;
}
.myharness-mermaid-expand-button:hover,
.myharness-mermaid-expand-button:focus-visible {
  border-color: rgba(37, 99, 235, 0.48);
  color: #1d4ed8;
  outline: none;
}
.myharness-mermaid-expand-button svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.myharness-mermaid-zoom-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  background: rgba(248, 250, 252, 0.98);
  color: #17212f;
}
.myharness-mermaid-zoom-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(17, 24, 39, 0.12);
  background: #ffffff;
  font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.myharness-mermaid-zoom-title {
  font-weight: 700;
}
.myharness-mermaid-zoom-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.myharness-mermaid-zoom-value {
  min-width: 48px;
  text-align: center;
  color: #5d6877;
}
.myharness-mermaid-zoom-control {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: 1px solid rgba(17, 24, 39, 0.14);
  border-radius: 6px;
  background: #ffffff;
  color: #17212f;
  font: 700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  cursor: pointer;
}
.myharness-mermaid-zoom-control svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.myharness-mermaid-zoom-control:hover,
.myharness-mermaid-zoom-control:focus-visible {
  border-color: rgba(37, 99, 235, 0.48);
  color: #1d4ed8;
  outline: none;
}
.myharness-mermaid-zoom-control[data-tooltip]::after {
  position: absolute;
  top: calc(100% + 7px);
  left: 50%;
  z-index: 10000;
  max-width: 220px;
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(17, 24, 39, 0.94);
  color: #ffffff;
  content: attr(data-tooltip);
  font: 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 2px);
  transition: opacity 120ms ease, transform 120ms ease;
  white-space: nowrap;
}
.myharness-mermaid-zoom-control:hover::after,
.myharness-mermaid-zoom-control:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
}
.myharness-mermaid-zoom-viewport {
  flex: 1;
  overflow: hidden;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle, rgba(100, 116, 139, 0.24) 0 1px, transparent 1.2px),
    #eef0f2;
  background-size: 18px 18px, auto;
  cursor: grab;
}
.myharness-mermaid-zoom-viewport.dragging {
  cursor: grabbing;
}
.myharness-mermaid-zoom-canvas {
  transform-origin: 0 0;
  transition: transform 120ms ease;
}
.myharness-mermaid-zoom-canvas svg {
  display: block;
  max-width: none;
  height: auto;
}
</style>
<script data-myharness-mermaid-zoom-script="true">
(() => {
  const attachedAttribute = "data-myharness-mermaid-zoom-attached";
  let activeViewer = null;

  const icon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 3H3v5"></path><path d="M3 3l7 7"></path><path d="M16 3h5v5"></path><path d="m21 3-7 7"></path><path d="M8 21H3v-5"></path><path d="m3 21 7-7"></path><path d="M16 21h5v-5"></path><path d="m21 21-7-7"></path></svg>';
  const controlIcons = {
    close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
    reset: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7v5h5"></path><path d="M5.7 12A7 7 0 0 1 17 6.5"></path><path d="M18.3 12A7 7 0 0 1 7 17.5"></path></svg>',
    zoomIn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',
    zoomOut: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h14"></path></svg>'
  };

  const classText = (element) => {
    const value = element?.className;
    if (typeof value === "string") return value;
    return String(value?.baseVal || "");
  };

  const hasMermaidClass = (element) => /(^|\\s)mermaid(?:-|\\s|$)/i.test(classText(element));

  const findHost = (svg) => {
    let fallback = svg.closest?.(".mermaid, .mermaid-chart") || svg.parentElement;
    for (let node = svg.parentElement; node && node !== document.body; node = node.parentElement) {
      if (hasMermaidClass(node)) {
        fallback = node;
      }
      const style = getComputedStyle(node);
      const overflow = [style.overflow, style.overflowX, style.overflowY].join(" ");
      if (/(auto|scroll)/i.test(overflow) && (node.scrollWidth > node.clientWidth + 8 || node.scrollHeight > node.clientHeight + 8)) {
        return node;
      }
    }
    return fallback;
  };

  const closeViewer = () => {
    if (!activeViewer) return;
    activeViewer.remove();
    activeViewer = null;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") closeViewer();
  };

  let viewport = null;
  let canvas = null;
  let zoomValue = null;
  let zoom = 1;
  let fitScale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let pointerId = -1;
  let lastX = 0;
  let lastY = 0;

  const updateTransform = () => {
    if (!canvas || !zoomValue) return;
    canvas.style.transform = "translate(" + offsetX + "px, " + offsetY + "px) scale(" + (fitScale * zoom) + ")";
    zoomValue.textContent = Math.round(zoom * 100) + "%";
  };

  const svgNaturalSize = () => {
    const svg = canvas?.querySelector("svg");
    if (!svg) return { width: 0, height: 0 };
    const viewBox = String(svg.getAttribute("viewBox") || "");
    const parts = viewBox.split(/[\\s,]+/).map((part) => Number(part));
    const attrNumber = (name) => {
      const raw = String(svg.getAttribute(name) || "");
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      width: parts.length >= 4 && Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : attrNumber("width"),
      height: parts.length >= 4 && Number.isFinite(parts[3]) && parts[3] > 0 ? parts[3] : attrNumber("height"),
    };
  };

  const normalizeSvgSize = () => {
    const svg = canvas?.querySelector("svg");
    const size = svgNaturalSize();
    if (!svg || !size.width || !size.height) return size;
    svg.style.width = Math.ceil(size.width) + "px";
    svg.style.height = Math.ceil(size.height) + "px";
    svg.style.maxWidth = "none";
    return size;
  };

  const fitView = () => {
    if (!viewport || !canvas) return;
    const size = normalizeSvgSize();
    const rect = viewport.getBoundingClientRect();
    const width = size.width || canvas.scrollWidth || 1;
    const height = size.height || canvas.scrollHeight || 1;
    const padding = 56;
    const availableWidth = Math.max(1, rect.width - padding);
    const availableHeight = Math.max(1, rect.height - padding);
    fitScale = Math.min(4, Math.max(0.05, Math.min(availableWidth / width, availableHeight / height)));
    zoom = 1;
    offsetX = (rect.width - width * fitScale) / 2;
    offsetY = (rect.height - height * fitScale) / 2;
    updateTransform();
  };

  const zoomAt = (nextZoom, clientX, clientY) => {
    if (!viewport) return;
    const clampedZoom = Math.min(4, Math.max(0.25, nextZoom));
    const rect = viewport.getBoundingClientRect();
    const centerX = Number.isFinite(clientX) ? clientX - rect.left : rect.width / 2;
    const centerY = Number.isFinite(clientY) ? clientY - rect.top : rect.height / 2;
    const currentScale = fitScale * zoom;
    const nextScale = fitScale * clampedZoom;
    const diagramX = (centerX - offsetX) / currentScale;
    const diagramY = (centerY - offsetY) / currentScale;
    zoom = clampedZoom;
    offsetX = centerX - diagramX * nextScale;
    offsetY = centerY - diagramY * nextScale;
    updateTransform();
  };

  const resetView = fitView;

  const onPointerMove = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    offsetX += event.clientX - lastX;
    offsetY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    updateTransform();
  };

  const onPointerUp = (event) => {
    if (event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = -1;
    viewport?.classList.remove("dragging");
  };

  const control = (label, tooltip, iconName, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "myharness-mermaid-zoom-control";
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = tooltip;
    button.innerHTML = controlIcons[iconName] || "";
    button.addEventListener("click", onClick);
    return button;
  };

  const openViewer = (svg) => {
    closeViewer();
    const backdrop = document.createElement("div");
    backdrop.className = "myharness-mermaid-zoom-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", "Mermaid 다이어그램 확대 보기");

    const header = document.createElement("div");
    header.className = "myharness-mermaid-zoom-header";
    const title = document.createElement("strong");
    title.className = "myharness-mermaid-zoom-title";
    title.textContent = "Mermaid";
    const controls = document.createElement("div");
    controls.className = "myharness-mermaid-zoom-controls";
    zoomValue = document.createElement("span");
    zoomValue.className = "myharness-mermaid-zoom-value";
    zoomValue.textContent = "100%";
    controls.append(
      control("축소", "축소", "zoomOut", () => zoomAt(zoom / 1.2)),
      zoomValue,
      control("확대", "확대", "zoomIn", () => zoomAt(zoom * 1.2)),
      control("이동 초기화", "Reset", "reset", resetView),
      control("닫기", "닫기", "close", closeViewer)
    );
    header.append(title, controls);

    viewport = document.createElement("div");
    viewport.className = "myharness-mermaid-zoom-viewport";
    canvas = document.createElement("div");
    canvas.className = "myharness-mermaid-zoom-canvas";
    canvas.append(svg.cloneNode(true));
    viewport.append(canvas);
    backdrop.append(header, viewport);
    document.body.append(backdrop);

    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomAt(zoom * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX, event.clientY);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      if (typeof event.button === "number" && event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.classList.add("dragging");
      viewport.setPointerCapture?.(event.pointerId);
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeViewer();
    });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    activeViewer = backdrop;
    requestAnimationFrame(fitView);
  };

  const attachButton = (svg) => {
    if (!svg || svg.closest(".myharness-mermaid-zoom-backdrop")) return;
    const host = findHost(svg);
    if (!host || host.hasAttribute(attachedAttribute)) return;
    host.setAttribute(attachedAttribute, "true");
    host.classList.add("myharness-mermaid-zoom-host");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "myharness-mermaid-expand-button";
    button.setAttribute("aria-label", "Mermaid 다이어그램 크게 보기");
    button.innerHTML = icon;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openViewer(svg);
    });
    host.prepend(button);
  };

  const enhance = () => {
    const selectors = ".mermaid svg, .mermaid-chart svg, svg[id^='mermaid-']";
    document.querySelectorAll(selectors).forEach(attachButton);
  };

  const schedule = () => {
    requestAnimationFrame(() => {
      enhance();
      setTimeout(enhance, 120);
      setTimeout(enhance, 500);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedule, { once: true });
  } else {
    schedule();
  }
  window.addEventListener("load", schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>`;
  if (/<\/body\s*>/i.test(value)) {
    return value.replace(/<\/body\s*>/i, `${bridge}</body>`);
  }
  return `${value}${bridge}`;
}

function iframeBackBridge(content: string) {
  const bridge = `
<script>
(() => {
  let pending = false;
  const sendBack = (event) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    event.stopPropagation();
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; }, 900);
    parent.postMessage({ type: "${artifactFrameBackMessage}" }, "*");
  };
  window.addEventListener("mousedown", sendBack, true);
  window.addEventListener("mouseup", sendBack, true);
  window.addEventListener("auxclick", sendBack, true);
})();
</script>`;
  if (/<\/body\s*>/i.test(content)) {
    return content.replace(/<\/body\s*>/i, `${bridge}</body>`);
  }
  return `${content}${bridge}`;
}

function escapeAttribute(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function iframeAssetBase(content: string, assetBaseUrl: string) {
  const baseUrl = String(assetBaseUrl || "").trim();
  if (!baseUrl) {
    return content;
  }
  const withAssetUrls = iframeRelativeAssetUrls(content, baseUrl);
  const base = `<base href="${escapeAttribute(baseUrl)}">`;
  if (/<base(?:\s[^>]*)?>/i.test(withAssetUrls)) {
    return withAssetUrls;
  }
  if (/<head(?:\s[^>]*)?>/i.test(withAssetUrls)) {
    return withAssetUrls.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${base}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(withAssetUrls)) {
    return withAssetUrls.replace(/<html(?:\s[^>]*)?>/i, (match) => `${match}<head>${base}</head>`);
  }
  return `${base}${withAssetUrls}`;
}

function iframeScrollBridge(content: string, artifactPath: string, restoreScroll?: { x: number; y: number }) {
  const scroll = {
    x: Number.isFinite(restoreScroll?.x) ? Math.max(0, Math.round(restoreScroll?.x || 0)) : 0,
    y: Number.isFinite(restoreScroll?.y) ? Math.max(0, Math.round(restoreScroll?.y || 0)) : 0,
  };
  const bridge = `
<script data-myharness-scroll-script="true">
(() => {
  const messageType = ${JSON.stringify(artifactFrameScrollMessage)};
  const artifactPath = ${JSON.stringify(artifactPath)};
  const restoreScroll = ${JSON.stringify(scroll)};
  let sendTimer = 0;

  const readScroll = () => ({
    x: Math.max(0, Math.round(window.scrollX || document.documentElement?.scrollLeft || document.body?.scrollLeft || 0)),
    y: Math.max(0, Math.round(window.scrollY || document.documentElement?.scrollTop || document.body?.scrollTop || 0)),
  });

  const sendScroll = () => {
    const current = readScroll();
    parent.postMessage({ type: messageType, path: artifactPath, x: current.x, y: current.y }, "*");
  };

  const scheduleScrollSend = () => {
    window.clearTimeout(sendTimer);
    sendTimer = window.setTimeout(sendScroll, 80);
  };

  const applyRestore = () => {
    if (restoreScroll.x <= 0 && restoreScroll.y <= 0) {
      scheduleScrollSend();
      return;
    }
    const scrollToSavedPosition = () => {
      window.scrollTo(restoreScroll.x, restoreScroll.y);
      scheduleScrollSend();
    };
    requestAnimationFrame(scrollToSavedPosition);
    window.setTimeout(scrollToSavedPosition, 40);
    window.setTimeout(scrollToSavedPosition, 180);
  };

  window.addEventListener("scroll", scheduleScrollSend, { passive: true });
  window.addEventListener("pagehide", sendScroll);
  window.addEventListener("beforeunload", sendScroll);
  window.addEventListener("load", applyRestore, { once: true });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyRestore, { once: true });
  } else {
    applyRestore();
  }
})();
</script>`;
  if (/<\/body\s*>/i.test(content)) {
    return content.replace(/<\/body\s*>/i, `${bridge}</body>`);
  }
  return `${content}${bridge}`;
}

function iframeEditorAssetBase(content: string, assetBaseUrl: string) {
  const hadBase = /<base(?:\s[^>]*)?>/i.test(content);
  const withAssetBase = iframeAssetBase(content, assetBaseUrl);
  if (hadBase) {
    return withAssetBase;
  }
  return withAssetBase.replace(/<base\b/i, '<base data-myharness-editor-base="true"');
}

function iframeHtmlEditorBridge(content: string, artifactPath: string) {
  const isFullDocument = /<(?:!doctype|html|head|body)\b/i.test(content);
  const bridge = `
<style data-myharness-editor-style="true">
[data-myharness-editable-text] {
  border-radius: 3px;
  -webkit-user-select: text;
  user-select: text;
}
[data-myharness-editable-text]:focus {
  background: rgba(37, 99, 235, 0.08);
  outline: 1px solid rgba(37, 99, 235, 0.85);
  outline-offset: 2px;
}
</style>
<script data-myharness-editor-script="true">
(() => {
  const messageType = ${JSON.stringify(artifactHtmlEditMessage)};
  const modeMessageType = ${JSON.stringify(artifactHtmlEditModeMessage)};
  const artifactPath = ${JSON.stringify(artifactPath)};
  const fullDocument = ${JSON.stringify(isFullDocument)};
  const excludedSelector = "script,style,noscript,svg,canvas,iframe,input,textarea,select,option,button";
  let sendTimer = 0;

  const editableText = "[data-myharness-editable-text]";
  const targetEditable = (target) => target?.closest?.(editableText);
  let activeEditable = null;
  let pointerStart = null;
  let pointerMoved = false;
  let editorEnabled = false;
  let editableTargetsMarked = false;

  const normalizeEditableLineBreaks = (root) => {
    root.querySelectorAll(editableText).forEach((node) => {
      const text = node.textContent || "";
      if (!/[\\r\\n]/.test(text)) return;
      const parts = text.split(/\\r\\n?|\\n/);
      node.replaceChildren(...parts.flatMap((part, index) => {
        const items = [];
        if (index > 0) items.push(root.createElement("br"));
        if (part) items.push(root.createTextNode(part));
        return items;
      }));
    });
  };

  const cleanClone = () => {
    const clone = document.cloneNode(true);
    clone.querySelectorAll(".myharness-ai-comment-highlight,.myharness-ai-pending-highlight").forEach((node) => {
      node.replaceWith(clone.createTextNode(node.textContent || ""));
    });
    clone.querySelectorAll("[data-myharness-ai-style],[data-myharness-ai-script],.myharness-ai-comment-popover,.myharness-ai-comment-anchor").forEach((node) => node.remove());
    clone.querySelectorAll("[data-myharness-ai-comment-id],[data-myharness-ai-comment-anchor]").forEach((node) => {
      node.removeAttribute("data-myharness-ai-comment-id");
      node.removeAttribute("data-myharness-ai-comment-anchor");
    });
    clone.querySelectorAll("[data-myharness-editor-style],[data-myharness-editor-script],[data-myharness-editor-base],[data-myharness-mermaid-zoom-style],[data-myharness-mermaid-zoom-script],.myharness-mermaid-expand-button,.myharness-mermaid-zoom-backdrop").forEach((node) => node.remove());
    clone.querySelectorAll("[data-myharness-mermaid-zoom-attached]").forEach((node) => {
      node.removeAttribute("data-myharness-mermaid-zoom-attached");
      node.classList.remove("myharness-mermaid-zoom-host");
    });
    normalizeEditableLineBreaks(clone);
    clone.querySelectorAll("[data-myharness-edit-wrapper]").forEach((node) => {
      const fragment = clone.createDocumentFragment();
      while (node.firstChild) fragment.appendChild(node.firstChild);
      node.replaceWith(fragment);
    });
    clone.querySelectorAll(editableText).forEach((node) => {
      node.removeAttribute("data-myharness-editable-text");
      node.removeAttribute("data-myharness-edit-target");
      node.removeAttribute("data-myharness-text-index");
      node.removeAttribute("contenteditable");
      node.removeAttribute("spellcheck");
      node.removeAttribute("tabindex");
    });
    if (!fullDocument) {
      return clone.body ? clone.body.innerHTML : "";
    }
    const docType = document.doctype
      ? "<!DOCTYPE " + document.doctype.name
        + (document.doctype.publicId ? " PUBLIC \\"" + document.doctype.publicId + "\\"" : "")
        + (!document.doctype.publicId && document.doctype.systemId ? " SYSTEM" : "")
        + (document.doctype.systemId ? " \\"" + document.doctype.systemId + "\\"" : "")
        + ">"
      : "";
    return (docType ? docType + "\\n" : "") + clone.documentElement.outerHTML;
  };

  const postDraft = () => {
    parent.postMessage({ type: messageType, path: artifactPath, html: cleanClone() }, "*");
  };

  const sendDraft = () => {
    window.clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => {
      postDraft();
    }, 80);
  };

  const isPlainTextElement = (element) => {
    if (!element || element.closest(excludedSelector) || element.closest(editableText)) return false;
    let hasText = false;
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.nodeValue || "").trim()) hasText = true;
        continue;
      }
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "br") {
        continue;
      }
      return false;
    }
    return hasText;
  };

  const makeEditable = (element, index, targetType) => {
    element.dataset.myharnessEditableText = "true";
    element.dataset.myharnessTextIndex = String(index);
    if (targetType) element.dataset[targetType] = "true";
    element.tabIndex = 0;
  };

  const deactivateEditable = () => {
    if (!activeEditable) return;
    normalizeEditableLineBreaks(document);
    activeEditable.removeAttribute("contenteditable");
    activeEditable.removeAttribute("spellcheck");
    activeEditable = null;
  };

  const commitActiveEditable = () => {
    if (!activeEditable) return;
    window.clearTimeout(sendTimer);
    normalizeEditableLineBreaks(document);
    const editable = activeEditable;
    postDraft();
    deactivateEditable();
    editable.blur?.();
    window.getSelection()?.removeAllRanges?.();
  };

  const setCaretFromPoint = (x, y) => {
    const selection = window.getSelection();
    if (!selection) return;
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
      }
    }
    if (!range) return;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const activateEditable = (element, event) => {
    if (!element) return;
    if (activeEditable && activeEditable !== element) {
      deactivateEditable();
    }
    activeEditable = element;
    element.contentEditable = "plaintext-only";
    element.spellcheck = false;
    element.focus({ preventScroll: true });
    if (event) {
      setCaretFromPoint(event.clientX, event.clientY);
    }
  };

  const markEditableTextTargets = () => {
    if (editableTargetsMarked) return;
    editableTargetsMarked = true;
    let index = 0;
    document.body.querySelectorAll("*").forEach((element) => {
      if (!isPlainTextElement(element)) return;
      makeEditable(element, index, "myharnessEditTarget");
      index += 1;
    });

    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(excludedSelector)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(editableText)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const span = document.createElement("span");
      makeEditable(span, index, "myharnessEditWrapper");
      index += 1;
      node.parentNode.insertBefore(span, node);
      span.appendChild(node);
    });
  };

  const clearEditableTextTargets = () => {
    deactivateEditable();
    document.querySelectorAll("[data-myharness-edit-wrapper]").forEach((node) => {
      const fragment = document.createDocumentFragment();
      while (node.firstChild) fragment.appendChild(node.firstChild);
      node.replaceWith(fragment);
    });
    document.querySelectorAll(editableText).forEach((node) => {
      node.removeAttribute("data-myharness-editable-text");
      node.removeAttribute("data-myharness-edit-target");
      node.removeAttribute("data-myharness-text-index");
      node.removeAttribute("contenteditable");
      node.removeAttribute("spellcheck");
      node.removeAttribute("tabindex");
    });
    editableTargetsMarked = false;
  };

  const setEditorEnabled = (value) => {
    const enabled = Boolean(value);
    if (editorEnabled === enabled) return;
    editorEnabled = enabled;
    if (editorEnabled) {
      markEditableTextTargets();
    } else {
      clearEditableTextTargets();
    }
  };

  document.addEventListener("beforeinput", (event) => {
    if (!editorEnabled) return;
    if (!targetEditable(event.target)) return;
    if (/^(format|insertOrderedList|insertUnorderedList|insertHorizontalRule)$/i.test(event.inputType || "")) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener("paste", (event) => {
    if (!editorEnabled) return;
    if (!targetEditable(event.target)) return;
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") || "");
    sendDraft();
  }, true);

  document.addEventListener("drop", (event) => {
    if (!editorEnabled) return;
    if (targetEditable(event.target)) event.preventDefault();
  }, true);

  document.addEventListener("input", (event) => {
    if (!editorEnabled) return;
    if (targetEditable(event.target)) sendDraft();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!editorEnabled) return;
    if (!targetEditable(event.target) || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    commitActiveEditable();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!editorEnabled) return;
    if (event.button !== 0) return;
    const editable = targetEditable(event.target);
    if (!editable) return;
    pointerStart = { x: event.clientX, y: event.clientY, editable };
    pointerMoved = false;
    if (editable !== activeEditable) {
      deactivateEditable();
    }
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!editorEnabled) return;
    if (!pointerStart || event.buttons !== 1) return;
    if (Math.abs(event.clientX - pointerStart.x) > 5 || Math.abs(event.clientY - pointerStart.y) > 5) {
      pointerMoved = true;
    }
  }, true);

  document.addEventListener("pointerup", () => {
    if (!editorEnabled) return;
    window.setTimeout(() => {
      pointerStart = null;
      pointerMoved = false;
    }, 0);
  }, true);

  document.addEventListener("click", (event) => {
    if (!editorEnabled) return;
    const editable = targetEditable(event.target);
    if (!editable || pointerMoved) return;
    event.preventDefault();
    activateEditable(editable, event);
  }, true);

  document.addEventListener("focusout", (event) => {
    if (!editorEnabled) return;
    const editable = targetEditable(event.target);
    if (!editable || editable !== activeEditable) return;
    window.setTimeout(() => {
      if (document.activeElement !== editable) {
        deactivateEditable();
      }
    }, 0);
  }, true);

  window.addEventListener("message", (event) => {
    if (event.data?.type !== modeMessageType || event.data.path !== artifactPath) return;
    setEditorEnabled(event.data.edit);
  });
})();
</script>`;
  if (/<\/body\s*>/i.test(content)) {
    return content.replace(/<\/body\s*>/i, `${bridge}</body>`);
  }
  return `${content}${bridge}`;
}

function iframeHtmlAiSelectionBridge(content: string, artifactPath: string, comments: ArtifactAiEditComment[]) {
  const isFullDocument = /<(?:!doctype|html|head|body)\b/i.test(content);
  const bridge = `
<style data-myharness-ai-style="true">
.myharness-ai-comment-highlight {
  border-bottom: 2px solid rgba(245, 158, 11, 0.82);
  background: rgba(245, 158, 11, 0.22);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.1);
}
.myharness-ai-comment-highlight:hover {
  background: rgba(245, 158, 11, 0.32);
}
.myharness-ai-pending-highlight {
  border-bottom: 2px solid rgba(245, 158, 11, 0.86);
  background: rgba(245, 158, 11, 0.34);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12);
}
.myharness-ai-comment-anchor {
  position: absolute;
  z-index: 2147483644;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 22px;
  height: 22px;
  min-width: 22px;
  max-width: 22px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: #0a84ff;
  color: #fff;
  box-shadow: 0 3px 9px rgba(10, 132, 255, 0.34), 0 1px 2px rgba(0, 0, 0, 0.22);
  cursor: help;
  font: 800 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1;
}
.myharness-ai-comment-anchor::before {
  content: attr(data-label);
}
.myharness-ai-comment-anchor::after {
  position: absolute;
  top: calc(100% + 7px);
  left: 50%;
  z-index: 2147483645;
  display: none;
  width: max-content;
  max-width: min(320px, calc(100vw - 18px));
  padding: 7px 9px;
  transform: translateX(-50%);
  background: rgba(23, 32, 51, 0.96);
  border-radius: 7px;
  color: #fff;
  content: attr(data-tooltip);
  font: 650 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-wrap: anywhere;
  text-align: left;
  white-space: normal;
}
.myharness-ai-comment-anchor[data-tooltip-align="left"]::after {
  left: 0;
  transform: translateX(0);
}
.myharness-ai-comment-anchor[data-tooltip-align="right"]::after {
  right: 0;
  left: auto;
  transform: translateX(0);
}
.myharness-ai-comment-anchor:hover::after,
.myharness-ai-comment-anchor:focus-visible::after {
  display: block;
}
::selection {
  background: rgba(245, 158, 11, 0.34);
  color: inherit;
}
::-moz-selection {
  background: rgba(245, 158, 11, 0.34);
  color: inherit;
}
::highlight(myharness-ai-pending-selection) {
  background: rgba(245, 158, 11, 0.34);
  color: inherit;
}
.myharness-ai-comment-popover {
  position: fixed;
  z-index: 2147483645;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 31px;
  align-items: center;
  gap: 7px;
  width: min(286px, calc(100vw - 18px));
  min-height: 44px;
  padding: 7px 8px 7px 15px;
  background: rgba(38, 38, 38, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.34), 0 2px 7px rgba(0, 0, 0, 0.2);
  color: #fff;
}
.myharness-ai-comment-popover.myharness-ai-comment-multiline {
  grid-template-columns: minmax(0, 1fr) 31px;
  grid-template-rows: auto 30px;
  align-items: end;
  padding: 10px;
}
.myharness-ai-comment-popover textarea {
  min-width: 0;
  width: 100%;
  height: 25px;
  min-height: 25px;
  max-height: 118px;
  padding: 4px 0 0;
  resize: none;
  background: transparent;
  border: 0;
  color: #fff;
  overflow: hidden;
  font: 14px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  outline: none;
}
.myharness-ai-comment-popover.myharness-ai-comment-multiline textarea {
  grid-column: 1 / -1;
  height: auto;
  min-height: 58px;
  padding: 0 2px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.4;
}
.myharness-ai-comment-popover textarea::placeholder {
  color: rgba(255, 255, 255, 0.5);
}
.myharness-ai-comment-popover button {
  display: inline-grid;
  place-items: center;
  align-self: end;
  min-width: 28px;
  height: 28px;
  padding: 0;
  background: rgba(255, 255, 255, 0.92);
  border: 0;
  border-radius: 999px;
  color: #1f1f1f;
  cursor: pointer;
  font: 800 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.myharness-ai-comment-popover .myharness-ai-comment-cancel {
  display: none;
  justify-self: start;
  min-width: 45px;
  height: 28px;
  padding: 0 10px;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.86);
  font-size: 12px;
  font-weight: 700;
}
.myharness-ai-comment-popover.myharness-ai-comment-multiline .myharness-ai-comment-cancel {
  display: inline-grid;
}
.myharness-ai-comment-popover .myharness-ai-comment-submit {
  align-self: center;
  color: #222;
}
.myharness-ai-comment-popover.myharness-ai-comment-multiline .myharness-ai-comment-submit {
  align-self: end;
}
.myharness-ai-comment-popover button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}
</style>
<script data-myharness-ai-script="true">
(() => {
  const messageType = ${JSON.stringify(artifactAiSelectionMessage)};
  const commentsMessageType = ${JSON.stringify(artifactAiCommentsMessage)};
  const modeMessageType = ${JSON.stringify(artifactHtmlEditModeMessage)};
  const artifactPath = ${JSON.stringify(artifactPath)};
  const fullDocument = ${JSON.stringify(isFullDocument)};
  let comments = ${JSON.stringify(comments.map((comment, index) => ({
    id: comment.id,
    index: index + 1,
    start: comment.start,
    end: comment.end,
    text: comment.text,
    before: comment.before,
    after: comment.after,
    scope: comment.scope || "selection",
    instruction: comment.instruction,
    html: comment.html || "",
  })))};
  const excludedSelector = "script,style,noscript,svg,canvas,iframe,input,textarea,select,option,button";
  const pendingHighlightName = "myharness-ai-pending-selection";
  let activePopover = null;
  let aiSelectionEnabled = false;
  let commentsRendered = false;

  const normalizeComments = (items) => {
    if (!Array.isArray(items)) return [];
    return items.map((comment, index) => ({
      id: String(comment?.id || "comment-" + (index + 1)),
      index: index + 1,
      start: Number(comment?.start),
      end: Number(comment?.end),
      text: String(comment?.text || ""),
      before: String(comment?.before || ""),
      after: String(comment?.after || ""),
      scope: comment?.scope === "document" ? "document" : "selection",
      instruction: String(comment?.instruction || ""),
      html: String(comment?.html || ""),
    }));
  };

  const removePopover = () => {
    activePopover?.remove();
    activePopover = null;
  };

  const clearPendingHighlight = () => {
    window.CSS?.highlights?.delete?.(pendingHighlightName);
    document.querySelectorAll(".myharness-ai-pending-highlight").forEach((highlight) => {
      const parent = highlight.parentNode;
      if (!parent) {
        highlight.remove();
        return;
      }
      while (highlight.firstChild) parent.insertBefore(highlight.firstChild, highlight);
      parent.removeChild(highlight);
      parent.normalize?.();
    });
  };

  const clearUi = () => {
    removePopover();
    clearPendingHighlight();
  };

  const clearCommentAnnotations = () => {
    document.querySelectorAll(".myharness-ai-comment-anchor").forEach((anchor) => anchor.remove());
    document.querySelectorAll(".myharness-ai-comment-highlight").forEach((highlight) => {
      const parent = highlight.parentNode;
      if (!parent) {
        highlight.remove();
        return;
      }
      while (highlight.firstChild) parent.insertBefore(highlight.firstChild, highlight);
      parent.removeChild(highlight);
      parent.normalize?.();
    });
    commentsRendered = false;
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const escapeSelector = (value) => {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\\\]/g, (match) => "\\\\" + match);
  };

  const textNodes = () => {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(excludedSelector)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let offset = 0;
    let documentText = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const length = node.nodeValue.length;
      documentText += node.nodeValue || "";
      if ((node.nodeValue || "").trim()) {
        nodes.push({ node, start: offset, end: offset + length });
      }
      offset += length;
    }
    nodes.documentText = documentText;
    return nodes;
  };

  const documentTextFromNodes = (nodes) => nodes.documentText || nodes.map((item) => item.node.nodeValue || "").join("");

  const compareBoundary = (leftNode, leftOffset, rightNode, rightOffset) => {
    const left = document.createRange();
    const right = document.createRange();
    left.setStart(leftNode, leftOffset);
    left.collapse(true);
    right.setStart(rightNode, rightOffset);
    right.collapse(true);
    return left.compareBoundaryPoints(Range.START_TO_START, right);
  };

  const textOffsetsFromRange = (range) => {
    const nodes = textNodes();
    const parts = [];

    for (const item of nodes) {
      const length = (item.node.nodeValue || "").length;
      const nodeStart = { node: item.node, offset: 0 };
      const nodeEnd = { node: item.node, offset: length };
      const rangeStart = { node: range.startContainer, offset: range.startOffset };
      const rangeEnd = { node: range.endContainer, offset: range.endOffset };
      const overlapStart = compareBoundary(nodeStart.node, nodeStart.offset, rangeStart.node, rangeStart.offset) >= 0 ? nodeStart : rangeStart;
      const overlapEnd = compareBoundary(nodeEnd.node, nodeEnd.offset, rangeEnd.node, rangeEnd.offset) <= 0 ? nodeEnd : rangeEnd;

      if (compareBoundary(overlapStart.node, overlapStart.offset, overlapEnd.node, overlapEnd.offset) < 0) {
        const localStart = overlapStart.node === item.node ? overlapStart.offset : 0;
        const localEnd = overlapEnd.node === item.node ? overlapEnd.offset : length;
        parts.push({
          start: item.start + localStart,
          end: item.start + localEnd,
          text: (item.node.nodeValue || "").slice(localStart, localEnd),
        });
      }
    }

    const rawText = parts.map((part) => part.text).join("");
    const leadingTrim = rawText.length - rawText.trimStart().length;
    const trailingTrim = rawText.length - rawText.trimEnd().length;
    const trimmedText = rawText.slice(leadingTrim, rawText.length - trailingTrim);
    if (!trimmedText) {
      return { start: 0, end: 0, text: "", rawText, nodes };
    }

    let start = null;
    let end = null;
    let cursor = 0;
    for (const part of parts) {
      const partStart = cursor;
      const partEnd = cursor + part.text.length;
      const overlapStart = Math.max(partStart, leadingTrim);
      const overlapEnd = Math.min(partEnd, rawText.length - trailingTrim);
      if (overlapStart < overlapEnd) {
        if (start === null) start = part.start + (overlapStart - partStart);
        end = part.start + (overlapEnd - partStart);
      }
      cursor = partEnd;
    }

    return { start: start ?? 0, end: end ?? start ?? 0, text: trimmedText, rawText, nodes };
  };

  const rangeFromTextOffsets = (start, end, nodes = textNodes()) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const range = document.createRange();
    let started = false;
    for (const item of nodes) {
      if (!started && start >= item.start && start <= item.end) {
        range.setStart(item.node, Math.max(0, Math.min((item.node.nodeValue || "").length, start - item.start)));
        started = true;
      }
      if (started && end >= item.start && end <= item.end) {
        range.setEnd(item.node, Math.max(0, Math.min((item.node.nodeValue || "").length, end - item.start)));
        return range;
      }
    }
    return null;
  };

  const resolveCommentRange = (comment, nodes) => {
    if (comment.scope === "document") return null;
    const documentText = documentTextFromNodes(nodes);
    const text = String(comment.text || "").trim();
    if (!text || !Number.isFinite(comment.start) || !Number.isFinite(comment.end) || comment.end <= comment.start) return null;
    const exact = documentText.slice(comment.start, comment.end);
    if (exact === text) {
      return { ...comment, start: comment.start, end: comment.end };
    }
    if (exact.trim() === text) {
      const leadingTrim = exact.length - exact.trimStart().length;
      const trailingTrim = exact.length - exact.trimEnd().length;
      return { ...comment, start: comment.start + leadingTrim, end: comment.end - trailingTrim };
    }

    let best = null;
    let index = documentText.indexOf(text);
    while (index !== -1) {
      const before = String(comment.before || "").slice(-180);
      const after = String(comment.after || "").slice(0, 180);
      const beforeWindow = documentText.slice(Math.max(0, index - before.length), index);
      const afterWindow = documentText.slice(index + text.length, index + text.length + after.length);
      let score = 0;
      if (before && beforeWindow === before) score += 4;
      else if (before && beforeWindow.trimEnd().endsWith(before.trim())) score += 2;
      if (after && afterWindow === after) score += 4;
      else if (after && afterWindow.trimStart().startsWith(after.trim())) score += 2;
      score -= Math.abs(index - comment.start) / 100000;
      if (!best || score > best.score) {
        best = { score, start: index, end: index + text.length };
      }
      index = documentText.indexOf(text, index + Math.max(1, text.length));
    }
    return best ? { ...comment, start: best.start, end: best.end } : null;
  };

  const wrapCommentRanges = () => {
    if (!comments.length || !document.body) return;
    const nodes = textNodes();
    const resolvedComments = comments.map((comment) => resolveCommentRange(comment, nodes)).filter(Boolean);
    for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
      const item = nodes[nodeIndex];
      const text = item.node.nodeValue || "";
      const ranges = resolvedComments
        .filter((comment) => comment.scope !== "document" && Number.isFinite(comment.start) && Number.isFinite(comment.end) && comment.start < item.end && comment.end > item.start)
        .map((comment) => ({
          comment,
          start: Math.max(0, comment.start - item.start),
          end: Math.min(text.length, comment.end - item.start),
        }))
        .filter((range) => range.start < range.end);
      if (!ranges.length || !item.node.parentNode) continue;
      const boundaries = new Set([0, text.length]);
      ranges.forEach((range) => {
        boundaries.add(range.start);
        boundaries.add(range.end);
      });
      const points = [...boundaries].sort((left, right) => left - right);
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        const value = text.slice(start, end);
        if (!value) continue;
        const owner = ranges.find((range) => range.start <= start && range.end >= end)?.comment;
        if (!owner) {
          fragment.appendChild(document.createTextNode(value));
          continue;
        }
        const span = document.createElement("span");
        span.className = "myharness-ai-comment-highlight";
        span.dataset.myharnessAiCommentId = owner.id;
        span.setAttribute("aria-label", "AI 수정 의견 " + owner.index);
        span.textContent = value;
        fragment.appendChild(span);
      }
      item.node.parentNode.replaceChild(fragment, item.node);
    }
  };

  const renderCommentAnchors = () => {
    comments.forEach((comment) => {
      const firstHighlight = document.querySelector('.myharness-ai-comment-highlight[data-myharness-ai-comment-id="' + escapeSelector(comment.id) + '"]');
      if (!firstHighlight) return;
      const anchor = document.createElement("span");
      anchor.className = "myharness-ai-comment-anchor";
      anchor.dataset.myharnessAiCommentAnchor = comment.id;
      anchor.dataset.label = String(comment.index);
      anchor.dataset.tooltip = comment.instruction || "";
      anchor.tabIndex = 0;
      anchor.setAttribute("aria-label", "AI 수정 의견 " + comment.index + " 위치");
      document.body.appendChild(anchor);
    });
  };

  const renderComments = () => {
    if (commentsRendered) return;
    wrapCommentRanges();
    renderCommentAnchors();
    positionCommentAnchors();
    window.setTimeout(positionCommentAnchors, 0);
    window.setTimeout(positionCommentAnchors, 160);
    commentsRendered = true;
  };

  const replaceLiveComments = (items) => {
    comments = normalizeComments(items);
    clearCommentAnnotations();
    if (aiSelectionEnabled) renderComments();
  };

  const positionCommentAnchors = () => {
    comments.forEach((comment) => {
      const firstHighlight = document.querySelector('.myharness-ai-comment-highlight[data-myharness-ai-comment-id="' + escapeSelector(comment.id) + '"]');
      const anchor = document.querySelector('.myharness-ai-comment-anchor[data-myharness-ai-comment-anchor="' + escapeSelector(comment.id) + '"]');
      if (!firstHighlight || !anchor) return;
      const rect = firstHighlight.getBoundingClientRect();
      const left = window.scrollX + rect.left - 8;
      const top = window.scrollY + rect.top - 10;
      anchor.style.left = Math.max(0, Math.round(left)) + "px";
      anchor.style.top = Math.max(0, Math.round(top)) + "px";
      const tooltipWidth = Math.min(320, Math.max(0, window.innerWidth - 18));
      const anchorLeft = Math.max(0, rect.left - 8);
      const anchorRight = anchorLeft + 22;
      if (anchorLeft + 11 - tooltipWidth / 2 < 9) {
        anchor.dataset.tooltipAlign = "left";
      } else if (anchorRight + tooltipWidth / 2 > window.innerWidth - 9) {
        anchor.dataset.tooltipAlign = "right";
      } else {
        delete anchor.dataset.tooltipAlign;
      }
    });
  };

  const rectFromRange = (range) => {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length) {
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return { left, top, width: right - left, height: bottom - top };
    }
    const rect = range.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };

  const cleanClone = (node) => {
    const clone = node.cloneNode(true);
    const wrapper = document.createElement("div");
    wrapper.appendChild(clone);
    wrapper.querySelectorAll?.(".myharness-ai-comment-highlight,.myharness-ai-pending-highlight").forEach((item) => {
      if (item.classList?.contains("myharness-ai-comment-highlight") || item.classList?.contains("myharness-ai-pending-highlight")) {
        item.replaceWith(document.createTextNode(item.textContent || ""));
      } else {
        item.remove();
      }
    });
    wrapper.querySelectorAll?.("[data-myharness-ai-style],[data-myharness-ai-script],.myharness-ai-comment-popover,.myharness-ai-comment-anchor").forEach((item) => item.remove());
    wrapper.querySelectorAll?.("[data-myharness-ai-comment-id],[data-myharness-ai-comment-anchor],[aria-label]").forEach((item) => {
      item.removeAttribute("data-myharness-ai-comment-id");
      item.removeAttribute("data-myharness-ai-comment-anchor");
      if ((item.getAttribute("aria-label") || "").startsWith("AI 수정 의견 ")) item.removeAttribute("aria-label");
    });
    wrapper.querySelectorAll?.("[data-myharness-editor-style],[data-myharness-editor-script],[data-myharness-editor-base]").forEach((item) => item.remove());
    wrapper.querySelectorAll?.("[data-myharness-edit-wrapper]").forEach((item) => {
      item.replaceWith(document.createTextNode(item.textContent || ""));
    });
    wrapper.querySelectorAll?.("[data-myharness-editable-text]").forEach((item) => {
      item.removeAttribute("data-myharness-editable-text");
      item.removeAttribute("data-myharness-edit-target");
      item.removeAttribute("data-myharness-text-index");
      item.removeAttribute("contenteditable");
      item.removeAttribute("spellcheck");
      item.removeAttribute("tabindex");
    });
    return wrapper.innerHTML.trim();
  };

  const cleanDocumentHtml = () => {
    const clone = document.cloneNode(true);
    const root = clone.documentElement;
    if (!root) return "";
    root.querySelectorAll?.(".myharness-ai-comment-highlight,.myharness-ai-pending-highlight").forEach((item) => {
      item.replaceWith(clone.createTextNode(item.textContent || ""));
    });
    root.querySelectorAll?.("[data-myharness-ai-style],[data-myharness-ai-script],.myharness-ai-comment-popover,.myharness-ai-comment-anchor").forEach((item) => item.remove());
    root.querySelectorAll?.("[data-myharness-ai-comment-id],[data-myharness-ai-comment-anchor],[aria-label]").forEach((item) => {
      item.removeAttribute("data-myharness-ai-comment-id");
      item.removeAttribute("data-myharness-ai-comment-anchor");
      if ((item.getAttribute("aria-label") || "").startsWith("AI 수정 의견 ")) item.removeAttribute("aria-label");
    });
    root.querySelectorAll?.("[data-myharness-editor-style],[data-myharness-editor-script],[data-myharness-editor-base]").forEach((item) => item.remove());
    root.querySelectorAll?.("[data-myharness-edit-wrapper]").forEach((item) => {
      while (item.firstChild) item.parentNode?.insertBefore(item.firstChild, item);
      item.remove();
    });
    root.querySelectorAll?.("[data-myharness-editable-text]").forEach((item) => {
      item.removeAttribute("data-myharness-editable-text");
      item.removeAttribute("data-myharness-edit-target");
      item.removeAttribute("data-myharness-text-index");
      item.removeAttribute("contenteditable");
      item.removeAttribute("spellcheck");
      item.removeAttribute("tabindex");
    });
    if (!fullDocument) return clone.body?.innerHTML || "";
    const doctype = clone.doctype ? "<!DOCTYPE " + clone.doctype.name + ">" : "";
    return doctype + root.outerHTML;
  };

  const htmlFromRange = (range) => cleanClone(range.cloneContents()).slice(0, 6000);

  const showPendingHighlight = (range) => {
    clearPendingHighlight();
    if (window.CSS?.highlights && window.Highlight) {
      try {
        window.CSS.highlights.set(pendingHighlightName, new window.Highlight(range.cloneRange()));
        return;
      } catch {
        window.CSS.highlights.delete(pendingHighlightName);
      }
    }
    const highlight = document.createElement("span");
    highlight.className = "myharness-ai-pending-highlight";
    try {
      highlight.appendChild(range.extractContents());
      range.insertNode(highlight);
      highlight.normalize?.();
    } catch {
      highlight.remove();
    }
  };

  const selectionPayloadFromRange = (range, fallbackText = "") => {
    if (!document.body.contains(range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)) {
      return null;
    }
    const offsets = textOffsetsFromRange(range);
    if (!offsets.text || offsets.end <= offsets.start) return null;
    const payloadRange = rangeFromTextOffsets(offsets.start, offsets.end, offsets.nodes) || range;
    const bodyText = documentTextFromNodes(offsets.nodes);
    const html = htmlFromRange(payloadRange);
    return {
      payload: {
        text: offsets.text,
        html,
        htmlSnapshot: cleanDocumentHtml(),
        start: offsets.start,
        end: offsets.end,
        before: bodyText.slice(Math.max(0, offsets.start - 180), offsets.start),
        after: bodyText.slice(offsets.end, Math.min(bodyText.length, offsets.end + 180)),
        scope: "selection",
      },
      pendingRange: payloadRange,
    };
  };

  const documentPayload = () => ({
    text: "전체 문서",
    html: "",
    htmlSnapshot: cleanDocumentHtml(),
    start: 0,
    end: 0,
    before: "",
    after: "",
    scope: "document",
  });

  const showPopover = (selection, point) => {
    removePopover();
    const safeLeft = clamp(point.x + 8, 8, window.innerWidth - 294);
    const safeTop = clamp(point.y + 8, 8, window.innerHeight - 122);
    const popover = document.createElement("div");
    popover.className = "myharness-ai-comment-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "AI 수정 의견 작성");
    popover.style.left = safeLeft + "px";
    popover.style.top = safeTop + "px";

    const textarea = document.createElement("textarea");
    textarea.rows = 1;
    textarea.setAttribute("aria-label", "수정 의견");
    textarea.placeholder = selection.scope === "document" ? "전체 수정 요청..." : "댓글 추가...";

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "myharness-ai-comment-submit";
    submit.setAttribute("aria-label", selection.scope === "document" ? "전체 수정 의견 추가" : "수정 부분으로 표시");
    submit.textContent = "✓";
    submit.disabled = true;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "myharness-ai-comment-cancel";
    close.setAttribute("aria-label", "닫기");
    close.textContent = "취소";

    const stopPopoverEvent = (event) => {
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };

    const syncFormShape = () => {
      submit.disabled = !textarea.value.trim();
      textarea.style.height = "25px";
      const multiline = textarea.value.includes("\\n") || textarea.scrollHeight > 38;
      popover.classList.toggle("myharness-ai-comment-multiline", multiline);
      if (multiline) {
        textarea.style.height = Math.min(textarea.scrollHeight, 118) + "px";
      }
    };

    textarea.addEventListener("input", () => {
      syncFormShape();
    });
    close.addEventListener("click", clearUi);
    const submitComment = () => {
      const instruction = textarea.value.trim();
      if (!instruction) return;
      const optimisticComments = selection.scope === "document" ? null : [
        ...comments,
        { ...selection, id: "pending-" + Date.now(), instruction },
      ];
      parent.postMessage({
        type: messageType,
        path: artifactPath,
        selection: { ...selection, instruction },
      }, "*");
      const selected = window.getSelection();
      selected?.removeAllRanges();
      if (optimisticComments) {
        removePopover();
        clearPendingHighlight();
        replaceLiveComments(optimisticComments);
      } else {
        clearUi();
      }
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        stopPopoverEvent(event);
        submitComment();
      }
    });
    submit.addEventListener("click", submitComment);
    ["keydown", "keyup", "keypress", "mousedown", "mouseup", "pointerdown", "pointerup", "click", "dblclick", "contextmenu"].forEach((type) => {
      popover.addEventListener(type, stopPopoverEvent);
    });
    popover.append(textarea, close, submit);
    document.body.appendChild(popover);
    activePopover = popover;
    syncFormShape();
    window.setTimeout(() => {
      textarea.focus();
      syncFormShape();
    }, 0);
  };

  const openSelectionPopover = (point) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    const selectionResult = selectionPayloadFromRange(range, selection.toString());
    if (!selectionResult) return false;
    const rect = rectFromRange(selectionResult.pendingRange);
    const fallbackPoint = {
      x: rect.left + Math.min(rect.width, 18),
      y: rect.top + rect.height + 7,
    };
    showPendingHighlight(selectionResult.pendingRange.cloneRange());
    showPopover(selectionResult.payload, point || fallbackPoint);
    return true;
  };

  document.addEventListener("contextmenu", (event) => {
    if (!aiSelectionEnabled) return;
    if (event.target?.closest?.(".myharness-ai-comment-popover")) return;
    const openedSelection = openSelectionPopover({ x: event.clientX, y: event.clientY });
    if (!openedSelection) {
      window.getSelection()?.removeAllRanges?.();
      showPopover(documentPayload(), { x: event.clientX, y: event.clientY });
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!aiSelectionEnabled) return;
    if (event.button !== 0 || event.target?.closest?.(".myharness-ai-comment-popover")) return;
    clearUi();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!aiSelectionEnabled) return;
    if (event.key === "Escape") clearUi();
  }, true);

  window.addEventListener("scroll", (event) => {
    if (!aiSelectionEnabled) return;
    if (event.target?.closest?.(".myharness-ai-comment-popover")) return;
    clearUi();
  }, true);
  window.addEventListener("resize", () => {
    if (aiSelectionEnabled) clearUi();
  });
  window.addEventListener("resize", () => {
    if (commentsRendered) positionCommentAnchors();
  });
  window.addEventListener("load", () => {
    if (commentsRendered) positionCommentAnchors();
  }, { once: true });
  window.addEventListener("message", (event) => {
    if (event.data?.path !== artifactPath) return;
    if (event.data?.type === commentsMessageType) {
      replaceLiveComments(event.data.comments);
      return;
    }
    if (event.data?.type === modeMessageType) {
      aiSelectionEnabled = Boolean(event.data.ai);
      if (aiSelectionEnabled) {
        renderComments();
      } else {
        clearUi();
        clearCommentAnnotations();
      }
    }
  });
})();
</script>`;
  if (/<\/body\s*>/i.test(content)) {
    return content.replace(/<\/body\s*>/i, `${bridge}</body>`);
  }
  return `${content}${bridge}`;
}

function iframeRelativeAssetUrls(content: string, assetBaseUrl: string) {
  const toAssetUrl = (value: string) => {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(raw)) {
      return value;
    }
    try {
      return new URL(raw, `${globalThis.location?.origin || "http://localhost"}${assetBaseUrl}`).pathname;
    } catch {
      return `${assetBaseUrl}${raw}`;
    }
  };
  return content
    .replace(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (_match, attr, quote, value) => {
      return `${attr}=${quote}${escapeAttribute(toAssetUrl(value))}${quote}`;
    })
    .replace(/<link\b([^>]*?)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi, (_match, before, quote, value, after) => {
      return `<link${before}href=${quote}${escapeAttribute(toAssetUrl(value))}${quote}${after}>`;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote, value) => {
      return `url(${quote}${escapeAttribute(toAssetUrl(value))}${quote})`;
    });
}

export function isEditablePayload(artifact: ArtifactSummary, payload: ArtifactPayload) {
  const kind = String(payload.kind || artifact.kind || "");
  return kind === "html" || kind === "text" || kind === "markdown" || kind === "json";
}

function isMarkdownArtifact(artifact: ArtifactSummary, payload: ArtifactPayload) {
  const kind = String(payload.kind || artifact.kind || "").toLowerCase();
  const path = String(artifact.path || "").toLowerCase();
  return kind === "markdown" || path.endsWith(".md") || path.endsWith(".markdown");
}

function isIncompleteHtmlDocument(content: string) {
  const lower = String(content || "").toLowerCase();
  if (!lower) {
    return false;
  }
  const lastStyleOpen = lower.lastIndexOf("<style");
  const lastStyleClose = lower.lastIndexOf("</style>");
  if (lastStyleOpen > lastStyleClose) {
    return true;
  }
  const lastScriptOpen = lower.lastIndexOf("<script");
  const lastScriptClose = lower.lastIndexOf("</script>");
  if (lastScriptOpen > lastScriptClose) {
    return true;
  }
  return lower.includes("<head") && !lower.includes("</head>") && !lower.includes("<body");
}

export function ArtifactPreview({
  artifact,
  payload,
  draftContent,
  draftDirty,
  sourceMode,
  downloadUrl,
  rawUrl,
  htmlEditMode,
  aiSelectionEnabled,
  aiEditComments = [],
  onDraftContentChange,
}: {
  artifact: ArtifactSummary;
  payload: ArtifactPayload;
  draftContent: string;
  draftDirty?: boolean;
  sourceMode: boolean;
  downloadUrl: string;
  rawUrl?: string;
  htmlEditMode?: boolean;
  aiSelectionEnabled?: boolean;
  aiEditComments?: ArtifactAiEditComment[];
  onDraftContentChange: (value: string) => void;
}) {
  const kind = String(payload.kind || artifact.kind || "");
  const payloadHasContent = typeof payload.content === "string";
  const content = String(payload.content ?? "");
  const displayName = artifactDisplayName(artifact);
  const sourceContent = sourceMode || draftDirty ? draftContent : content;
  const htmlDraftContent = draftDirty || sourceMode ? draftContent : content;
  const dataUrl = String(payload.dataUrl || "");
  const htmlEditFrameRef = useRef<{ key: string; srcDoc: string } | null>(null);
  const htmlFrameElementRef = useRef<HTMLIFrameElement | null>(null);
  const htmlEditSessionContentRef = useRef<string | null>(null);
  const htmlEditSessionAssetBaseUrlRef = useRef("");
  const htmlEditWasDraftDirtyRef = useRef(false);
  const htmlScrollPositionsRef = useRef(new Map<string, { x: number; y: number }>());
  useEffect(() => {
    function handleFrameScrollMessage(event: MessageEvent) {
      if (
        event.data?.type !== artifactFrameScrollMessage
        || event.data.path !== artifact.path
        || typeof event.data.x !== "number"
        || typeof event.data.y !== "number"
      ) {
        return;
      }
      htmlScrollPositionsRef.current.set(artifact.path, {
        x: Math.max(0, Math.round(event.data.x)),
        y: Math.max(0, Math.round(event.data.y)),
      });
    }
    window.addEventListener("message", handleFrameScrollMessage);
    return () => window.removeEventListener("message", handleFrameScrollMessage);
  }, [artifact.path]);
  useEffect(() => {
    if (kind !== "html" || sourceMode) return undefined;
    const frame = htmlFrameElementRef.current;
    if (!frame) return undefined;
    const postMode = () => {
      frame.contentWindow?.postMessage({
        type: artifactHtmlEditModeMessage,
        path: artifact.path,
        edit: Boolean(htmlEditMode),
        ai: Boolean(aiSelectionEnabled),
      }, "*");
    };
    postMode();
    frame.addEventListener("load", postMode);
    return () => frame.removeEventListener("load", postMode);
  }, [aiSelectionEnabled, artifact.path, htmlEditMode, kind, sourceMode]);
  useEffect(() => {
    if (kind !== "html" || sourceMode) return;
    const frame = htmlFrameElementRef.current;
    if (!frame) return;
    frame.contentWindow?.postMessage({
      type: artifactAiCommentsMessage,
      path: artifact.path,
      comments: aiEditComments,
    }, "*");
  }, [aiEditComments, artifact.path, kind, sourceMode]);
  useEffect(() => {
    htmlEditWasDraftDirtyRef.current = Boolean(draftDirty);
  }, [draftDirty]);
  if (sourceMode && payloadHasContent && (kind === "html" || isSourceCodeArtifact(artifact))) {
    return <HighlightedArtifactSource artifact={artifact} content={kind === "html" ? htmlDraftContent : sourceContent} />;
  }
  if (sourceMode && payloadHasContent) {
    return (
      <textarea
        className="artifact-text artifact-source-editor"
        value={sourceContent}
        aria-label={`${displayName} 원문`}
        onChange={(event) => onDraftContentChange(event.currentTarget.value)}
      />
    );
  }
  if (kind === "html") {
    if (isIncompleteHtmlDocument(htmlDraftContent)) {
      return <HighlightedArtifactSource artifact={artifact} content={htmlDraftContent} />;
    }
    const assetBaseUrl = String(payload.assetBaseUrl || "");
    const frameBaseContent = htmlDraftContent;
    const preserveCommittedDraftFrame = htmlEditMode
      && !draftDirty
      && htmlEditWasDraftDirtyRef.current
      && htmlEditSessionContentRef.current !== null;
    if (htmlEditMode && (htmlEditSessionContentRef.current === null || (!draftDirty && !preserveCommittedDraftFrame))) {
      htmlEditSessionContentRef.current = frameBaseContent;
      htmlEditSessionAssetBaseUrlRef.current = assetBaseUrl;
    } else if (!htmlEditMode) {
      htmlEditSessionContentRef.current = null;
      htmlEditSessionAssetBaseUrlRef.current = "";
    }
    const frameContent = htmlEditSessionContentRef.current ?? frameBaseContent;
    const frameAssetBaseUrl = htmlEditSessionContentRef.current !== null ? htmlEditSessionAssetBaseUrlRef.current : assetBaseUrl;
    const editFrameKey = `${artifact.path}\u0000${frameAssetBaseUrl}\u0000${frameContent}`;
    if (htmlEditFrameRef.current?.key !== editFrameKey || !htmlFrameElementRef.current) {
      const editableContent = iframeHtmlEditorBridge(iframeEditorAssetBase(frameContent, frameAssetBaseUrl), artifact.path);
      const previewContent = iframeHtmlAiSelectionBridge(editableContent, artifact.path, aiEditComments);
      const restoredScroll = htmlScrollPositionsRef.current.get(artifact.path);
      htmlEditFrameRef.current = {
        key: editFrameKey,
        srcDoc: iframeBackBridge(iframeScrollBridge(iframeMermaidZoomBridge(previewContent), artifact.path, restoredScroll)),
      };
    }
    return <iframe ref={htmlFrameElementRef} className="artifact-frame artifact-html-frame" title={displayName} sandbox="allow-scripts" srcDoc={htmlEditFrameRef.current.srcDoc} />;
  }
  if (kind === "image") {
    return <img className="artifact-image" src={dataUrl} alt={displayName} />;
  }
  if (kind === "pdf") {
    return (
      <iframe
        className="artifact-frame artifact-pdf-frame"
        title={displayName}
        src={String(rawUrl || dataUrl || downloadUrl)}
      />
    );
  }
  if (isMarkdownArtifact(artifact, payload)) {
    return (
      <div className="artifact-markdown">
        <MarkdownMessage text={content || "(내용 없음)"} />
      </div>
    );
  }
  if (content && isSourceCodeArtifact(artifact)) {
    return <HighlightedArtifactSource artifact={artifact} content={sourceContent} />;
  }
  if (kind === "file") {
    return (
      <div className="artifact-file">
        <p className="artifact-empty">이 파일 형식은 미리보기 대신 다운로드로 열 수 있습니다.</p>
        <a className="artifact-file-download" href={downloadUrl} download={displayName} aria-label={`${displayName} 다운로드`}>
          <Icon name="download" />
          <span>다운로드</span>
        </a>
      </div>
    );
  }
  return (
    <textarea
      className="artifact-text artifact-source-editor"
      value={sourceContent}
      aria-label={`${displayName} 내용`}
      onChange={(event) => onDraftContentChange(event.currentTarget.value)}
    />
  );
}

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isEditableKeyTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || element.isContentEditable;
}

function nodeIsInside(root: HTMLElement, node: Node | null) {
  if (!node) {
    return false;
  }
  return root.contains(node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
}

function selectElementText(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function HighlightedArtifactSource({ artifact, content }: { artifact: ArtifactSummary; content: string }) {
  const sourceRef = useRef<HTMLPreElement | null>(null);
  const displayName = artifactDisplayName(artifact);
  const language = sourceLanguageForArtifact(artifact.path);
  const highlighted = hljs.getLanguage(language)
    ? hljs.highlight(content, { language, ignoreIllegals: true }).value
    : escapeHtml(content);

  useEffect(() => {
    function handleSelectAll(event: KeyboardEvent) {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "a") {
        return;
      }
      if (isEditableKeyTarget(event.target)) {
        return;
      }
      const source = sourceRef.current;
      if (!source?.isConnected) {
        return;
      }
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const selection = window.getSelection();
      const selectionIsInSource = nodeIsInside(source, selection?.anchorNode || null);
      const focusIsInArtifactPanel = Boolean(activeElement?.closest(".artifact-panel"));
      const focusIsDocumentBody = activeElement === document.body;
      if (!selectionIsInSource && !focusIsInArtifactPanel && !focusIsDocumentBody) {
        return;
      }
      event.preventDefault();
      selectElementText(source.querySelector("code") || source);
    }

    document.addEventListener("keydown", handleSelectAll, true);
    return () => {
      document.removeEventListener("keydown", handleSelectAll, true);
    };
  }, []);

  return (
    <pre
      ref={sourceRef}
      className="artifact-text artifact-source"
      tabIndex={0}
      aria-label={`${displayName} 코드 원문`}
      onMouseDown={(event) => {
        event.currentTarget.focus();
      }}
    >
      <code
        className={`hljs language-${language}`}
        data-highlighted="yes"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}

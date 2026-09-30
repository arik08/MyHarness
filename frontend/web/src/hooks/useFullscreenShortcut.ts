import { useEffect } from "react";

export const fullscreenMessage = "myharness:toggle-fullscreen";
export const artifactFullscreenScrollMessage = "myharness:artifact-fullscreen-scroll";

export function useFullscreenShortcut() {
  useEffect(() => {
    let pending = false;
    let scrollGeneration = 0;
    let savedScroll: { target: HTMLElement; x: number; y: number; frame: HTMLIFrameElement | null; path: string | undefined } | null = null;
    function restoreArtifactScroll() {
      if (!savedScroll) return;
      const saved = savedScroll;
      const generation = scrollGeneration;
      savedScroll = null;
      window.requestAnimationFrame(() => {
        if (generation !== scrollGeneration || !saved.target.isConnected || document.fullscreenElement === saved.target) return;
        saved.target.scrollLeft = saved.x;
        saved.target.scrollTop = saved.y;
        saved.frame?.contentWindow?.postMessage({ type: artifactFullscreenScrollMessage, path: saved.path, action: "restore" }, "*");
      });
    }
    async function toggleFullscreen(target: HTMLElement, scroll?: { x: number; y: number }) {
      if (pending) return;
      pending = true;
      try {
        if (document.fullscreenElement === target) {
          await document.exitFullscreen();
        } else {
          if (target.classList.contains("artifact-viewer")) {
            scrollGeneration += 1;
            const frame = target.querySelector<HTMLIFrameElement>("iframe.artifact-html-frame");
            savedScroll = { target, x: target.scrollLeft, y: target.scrollTop, frame, path: target.dataset.artifactPath };
            frame?.contentWindow?.postMessage({ type: artifactFullscreenScrollMessage, path: savedScroll.path, action: "save", scroll }, "*");
          }
          await target.requestFullscreen();
        }
      } catch (error) {
        restoreArtifactScroll();
        console.warn("전체화면 전환에 실패했습니다.", error);
      } finally {
        pending = false;
      }
    }
    function artifactFullscreenTarget(panel: Element) {
      const viewer = panel.querySelector<HTMLElement>(".artifact-viewer");
      if (viewer?.dataset.fullscreenDisabled === "true" || viewer?.querySelector("textarea.artifact-source-editor:not([readonly])")) return null;
      return viewer;
    }
    function onContextMenu(event: MouseEvent) {
      const element = event.target instanceof Element ? event.target : null;
      const panel = element?.closest(".artifact-panel");
      if (panel && element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
      const target = panel ? artifactFullscreenTarget(panel) : document.documentElement;
      if (!target) return;
      event.preventDefault();
      void toggleFullscreen(target);
    }
    function onMessage(event: MessageEvent) {
      if (event.data?.type !== fullscreenMessage) return;
      const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe.artifact-html-frame"))
        .find((item) => item.contentWindow === event.source);
      const panel = frame?.closest(".artifact-panel");
      const target = panel ? artifactFullscreenTarget(panel) : null;
      if (target && event.data.path === target.dataset.artifactPath) {
        const scroll = event.data.scroll;
        void toggleFullscreen(target, Number.isFinite(scroll?.x) && Number.isFinite(scroll?.y) ? scroll : undefined);
      }
    }
    function onFullscreenChange() {
      if (savedScroll && document.fullscreenElement !== savedScroll.target) restoreArtifactScroll();
    }
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("message", onMessage);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      scrollGeneration += 1;
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);
}

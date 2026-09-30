import { useEffect } from "react";

export const fullscreenMessage = "myharness:toggle-fullscreen";

export function useFullscreenShortcut() {
  useEffect(() => {
    let pending = false;
    async function toggleFullscreen() {
      if (pending) return;
      pending = true;
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await document.documentElement.requestFullscreen();
        }
      } catch (error) {
        console.warn("전체화면 전환에 실패했습니다.", error);
      } finally {
        pending = false;
      }
    }
    function onContextMenu(event: MouseEvent) {
      event.preventDefault();
      void toggleFullscreen();
    }
    function onMessage(event: MessageEvent) {
      if (event.data?.type !== fullscreenMessage) return;
      const isPreview = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe.artifact-html-frame"))
        .some((frame) => frame.contentWindow === event.source);
      if (isPreview) void toggleFullscreen();
    }
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}

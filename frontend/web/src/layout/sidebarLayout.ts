export const sidebarDefaultWidthPx = 268;
export const sidebarMaxWidthPx = 520;
export const sidebarVisibleContentMinWidthPx = 300;
export const sidebarAutoCollapseChatWidthPx = 400;
export const sidebarCollapsedTrackWidthPx = 32;
export const sidebarAutoCollapseTolerancePx = 0.5;

export function clampSidebarWidth(value: number, windowWidth: number) {
  const viewportMax = Math.max(sidebarDefaultWidthPx, windowWidth - sidebarVisibleContentMinWidthPx);
  return Math.max(sidebarDefaultWidthPx, Math.min(sidebarMaxWidthPx, viewportMax, value));
}

export function shouldAutoCollapseSidebarForChatWidth(widthPx: number) {
  return widthPx <= sidebarAutoCollapseChatWidthPx + sidebarAutoCollapseTolerancePx;
}

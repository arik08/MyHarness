export const sidebarDefaultWidthPx = 268;
export const sidebarAutoCollapseChatWidthPx = 400;
export const sidebarCollapsedTrackWidthPx = 32;
export const sidebarAutoCollapseTolerancePx = 0.5;

export function shouldAutoCollapseSidebarForChatWidth(widthPx: number) {
  return widthPx <= sidebarAutoCollapseChatWidthPx + sidebarAutoCollapseTolerancePx;
}

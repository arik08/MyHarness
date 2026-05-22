export async function copyTextToClipboard(text: string) {
  if (window.isSecureContext !== false && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-1000px";
  textArea.style.top = "-1000px";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  textArea.remove();
  if (!copied) {
    throw new Error("복사에 실패했습니다.");
  }
}

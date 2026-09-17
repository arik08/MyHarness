// Some IME finalization events report keyCode 229 after isComposing becomes false.
export function isImeKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

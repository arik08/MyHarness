const terminalControlSequencePattern = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function normalizeBackendLogLine(line) {
  return String(line || "")
    .replace(terminalControlSequencePattern, "")
    .replace(/\r/g, "")
    .trim();
}

export function isNoisyBackendLogLine(line) {
  const text = normalizeBackendLogLine(line).replace(/\s+/g, " ");
  if (/\b(?:WARN(?:ING)?|ERROR|CRITICAL)\b/.test(text)) {
    return false;
  }
  return (
    /\bProcessing request of type\b/.test(text)
    || /^(?:(?:[A-Za-z][A-Za-z0-9]*Request)|INFO|server\.py:\d+)(?:\s+(?:(?:[A-Za-z][A-Za-z0-9]*Request)|INFO|server\.py:\d+))*$/.test(text)
  );
}

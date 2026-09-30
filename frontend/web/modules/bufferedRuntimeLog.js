import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Amortize file operations while preserving synchronous, ordered exit flush. */
export function createBufferedRuntimeLog(path, { maxBufferBytes = 64 * 1024 } = {}) {
  let lines = [];
  let bytes = 0;
  let scheduled = null;
  let directoryReady = false;
  const flush = () => {
    if (scheduled) clearImmediate(scheduled);
    scheduled = null;
    if (!lines.length) return;
    const batch = lines.join("");
    lines = [];
    bytes = 0;
    try {
      if (!directoryReady) {
        mkdirSync(dirname(path), { recursive: true });
        directoryReady = true;
      }
      appendFileSync(path, batch, "utf8");
    } catch {
      // Diagnostic logging must not interrupt serving requests or shutdown.
    }
  };
  return {
    write(line) {
      lines.push(line);
      bytes += Buffer.byteLength(line);
      if (bytes >= maxBufferBytes) flush();
      else if (!scheduled) {
        scheduled = setImmediate(flush);
        scheduled.unref?.();
      }
    },
    flush,
  };
}

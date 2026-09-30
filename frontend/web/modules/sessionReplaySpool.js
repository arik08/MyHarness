import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { replayEntriesForState } from "./sessionReplay.js";

// Only evicted stable entries go to disk. Streams and the recent activity tail
// retain their existing memory bounds; disk reads stream one entry at a time.
export function createSessionReplaySpool({ directory = tmpdir(), onBufferedBytes } = {}) {
  let generation;
  let bufferedBytes = 0;
  const generations = new Set();
  function current() {
    if (!generation) {
      const folder = mkdtemp(join(directory, "myharness-replay-"));
      // Attach the rejection immediately: a reset may precede the first read.
      folder.catch(() => {});
      generation = { folder, pending: Promise.resolve(), error: null, readers: 0 };
      generations.add(generation);
    }
    return generation;
  }
  function remove(old) {
    if (!old) return Promise.resolve();
    if (old.removal) return old.removal;
    old.removal = old.pending.then(() => old.readersDone).then(() => old.folder).then((folder) => rm(folder, { recursive: true, force: true }))
      .finally(() => generations.delete(old));
    return old.removal;
  }
  function release(snapshot) {
    if (!snapshot.target || snapshot.released) return;
    snapshot.released = true;
    snapshot.target.readers -= 1;
    if (!snapshot.target.readers) snapshot.target.resolveReaders?.();
  }
  return {
    append(entry) {
      const target = current();
      if (target.error) return;
      const serialized = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.byteLength(serialized, "utf8");
      bufferedBytes += bytes;
      onBufferedBytes?.(bufferedBytes);
      target.pending = target.pending.then(async () => {
        if (target.error) return;
        await appendFile(join(await target.folder, "prefix.jsonl"), serialized, "utf8");
      }).catch((error) => { target.error = error; }).finally(() => {
        bufferedBytes -= bytes;
        onBufferedBytes?.(bufferedBytes);
      });
    },
    reset() {
      const old = generation;
      generation = null;
      void remove(old).catch(() => {});
    },
    snapshot() {
      const target = generation;
      if (target && target.readers++ === 0) {
        target.readersDone = new Promise((resolve) => { target.resolveReaders = resolve; });
      }
      return { target, pending: target?.pending };
    },
    async ready(snapshot) {
      if (!snapshot.target) return;
      await snapshot.pending;
      if (snapshot.target.error) throw snapshot.target.error;
    },
    async *readBefore(snapshot, cutoff) {
      if (!snapshot.target) return;
      let reader;
      let input;
      try {
        await snapshot.pending;
        if (snapshot.target.error) throw snapshot.target.error;
        input = createReadStream(join(await snapshot.target.folder, "prefix.jsonl"), { encoding: "utf8" });
        reader = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of reader) {
          const entry = JSON.parse(line);
          if (entry.order >= cutoff) break;
          yield entry;
        }
      } finally {
        reader?.close();
        input?.destroy();
        release(snapshot);
      }
    },
    release,
    async dispose() {
      generation = null;
      await Promise.all([...generations].map(remove));
    },
  };
}

export function snapshotSessionReplay(state, spool) {
  return {
    entries: replayEntriesForState(state),
    cutoff: state.stableEvents[0]?.order ?? Infinity,
    spool: spool.snapshot(),
  };
}

export async function* replaySessionSnapshot(snapshot, spool) {
  let index = 0;
  for await (const entry of spool.readBefore(snapshot.spool, snapshot.cutoff)) {
    while (index < snapshot.entries.length && snapshot.entries[index].order < entry.order) {
      yield snapshot.entries[index++].event;
    }
    yield entry.event;
  }
  while (index < snapshot.entries.length) yield snapshot.entries[index++].event;
}

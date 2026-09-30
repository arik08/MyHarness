export const SSE_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
const writers = new WeakMap();

export function encodeSseEvent(event, id = null) {
  return `${id === null || id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`;
}

/** write(false) accepts the current frame; only later frames wait for drain. */
export function createSseWriter(response, { maxQueuedBytes = SSE_QUEUE_MAX_BYTES } = {}) {
  let blocked = false;
  let closed = false;
  let queuedBytes = 0;
  let queue = [];
  let queueHead = 0;
  const waiters = new Set();
  const settle = (success) => {
    for (const resolve of waiters) resolve(success);
    waiters.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    queue = [];
    queueHead = 0;
    queuedBytes = 0;
    response.off("drain", drain);
    response.off("close", close);
    response.off("error", close);
    settle(false);
  };
  const send = (frame) => {
    try {
      blocked = !response.write(frame);
      response.flush?.();
      return true;
    } catch {
      close();
      response.destroy();
      return false;
    }
  };
  const drain = () => {
    blocked = false;
    while (queueHead < queue.length && !blocked && !closed) {
      const frame = queue[queueHead];
      queue[queueHead++] = null;
      queuedBytes -= Buffer.byteLength(frame);
      send(frame);
    }
    if (queueHead === queue.length) {
      queue = [];
      queueHead = 0;
    } else if (queueHead >= 1024 && queueHead * 2 >= queue.length) {
      queue = queue.slice(queueHead);
      queueHead = 0;
    }
    if (!blocked && !queue.length && !closed) settle(true);
  };
  response.on("drain", drain);
  response.once("close", close);
  response.once("error", close);
  return {
    write(frame) {
      if (closed || response.destroyed || response.writableEnded) return false;
      if (!blocked) return send(frame);
      const bytes = Buffer.byteLength(frame);
      if (queuedBytes + bytes > maxQueuedBytes) {
        close();
        response.destroy(); // EventSource resumes through the existing replay cursor.
        return false;
      }
      queue.push(frame);
      queuedBytes += bytes;
      return true;
    },
    waitForIdle() {
      if (closed || response.destroyed || response.writableEnded) return Promise.resolve(false);
      if (!blocked && !queue.length) return Promise.resolve(true);
      return new Promise((resolve) => waiters.add(resolve));
    },
    close,
    get queuedBytes() { return queuedBytes; },
  };
}

export function sseWriterFor(response) {
  let writer = writers.get(response);
  if (!writer) {
    response.socket?.setNoDelay?.(true);
    writer = createSseWriter(response);
    writers.set(response, writer);
  }
  return writer;
}

export function writeSseEvent(response, event, id = null) {
  return sseWriterFor(response).write(encodeSseEvent(event, id));
}

export async function writeSseReplayEvent(response, event, id = null) {
  if (!writeSseEvent(response, event, id)) return false;
  return sseWriterFor(response).waitForIdle();
}

// Cache discovery only. Availability policy is read and applied on every request.
export function createModelCatalogCache(load, { ttlMs = 60_000, now = Date.now } = {}) {
  let current;
  return async function read(key) {
    if (!current || current.key !== key) current = { key };
    const entry = current;
    if (!entry.pending && (!entry.value || now() - entry.loadedAt >= ttlMs)) {
      entry.pending = Promise.resolve().then(load).then((value) => {
        entry.value = value;
        entry.loadedAt = now();
        return value;
      }).finally(() => { entry.pending = null; });
    }
    if (entry.value) {
      // Refresh expired metadata without making an open menu wait for Python.
      entry.pending?.catch(() => {});
      return entry.value;
    }
    return entry.pending;
  };
}

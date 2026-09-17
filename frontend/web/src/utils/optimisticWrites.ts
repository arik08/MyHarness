// Serialize writes to each field while reflecting the latest intent immediately.
// Different rows/fields remain independent, and failed writes restore only that field.
export function createOptimisticWrites() {
  const jobs = new Map<string, { desired: unknown; confirmed: unknown; version: number }>();
  return async function write<T>(options: {
    key: string;
    previous: T;
    value: T;
    apply: (value: T) => void;
    persist: (value: T) => Promise<T>;
    onError: (error: unknown) => void;
    onSettled?: () => void;
  }) {
    const existing = jobs.get(options.key);
    options.apply(options.value);
    if (existing) {
      existing.desired = options.value;
      existing.version += 1;
      return;
    }
    const job = { desired: options.value as unknown, confirmed: options.previous as unknown, version: 0 };
    jobs.set(options.key, job);
    try {
      while (true) {
        const version = job.version;
        try {
          job.confirmed = await options.persist(job.desired as T);
        } catch (error) {
          options.onError(error);
        }
        if (version === job.version) {
          options.apply(job.confirmed as T);
          break;
        }
      }
    } finally {
      jobs.delete(options.key);
      options.onSettled?.();
    }
  };
}

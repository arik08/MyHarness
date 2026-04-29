export function historyOrderTimestamp(data = {}, info = {}, fallbackNow = Date.now()) {
  const createdAt = Number(data?.created_at || 0);
  if (Number.isFinite(createdAt) && createdAt > 0) {
    return createdAt;
  }
  for (const field of ["birthtimeMs", "ctimeMs", "mtimeMs"]) {
    const value = Number(info?.[field] || 0);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  const fallback = Number(fallbackNow);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : Date.now();
}

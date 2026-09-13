// One recent response per category keeps storage bounded. Tab storage survives
// refresh without sharing another tab's workspace or execution state.
export function readRecentData<T>(category: string, scope: string, valid: (value: unknown) => value is T): T | null {
  try {
    const cached = JSON.parse(sessionStorage.getItem(`myharness:recent:${category}:v1`) || "null");
    return cached?.scope === scope && valid(cached.data) ? cached.data : null;
  } catch {
    return null;
  }
}

export function writeRecentData(category: string, scope: string, data: unknown) {
  try {
    sessionStorage.setItem(`myharness:recent:${category}:v1`, JSON.stringify({ scope, data }));
  } catch {
    // Storage being full or unavailable must not affect server loading.
  }
}

async function readError(response: Response): Promise<Error> {
  const body = await response.text();
  let message = body || `HTTP ${response.status}`;
  try {
    const data = body ? JSON.parse(body) : null;
    if (data?.error) {
      message = String(data.error);
    }
  } catch {
    // Keep raw text when the server returns non-JSON.
  }
  const error = new Error(message) as Error & { status?: number };
  error.status = response.status;
  return error;
}

function adminModeHeaders(): Record<string, string> {
  try {
    return localStorage.getItem("myharness:adminMode") === "1" ? { "X-MyHarness-Admin-Mode": "1" } : {};
  } catch {
    return {};
  }
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...adminModeHeaders() };
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

export async function putJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

export async function deleteJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

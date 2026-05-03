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
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

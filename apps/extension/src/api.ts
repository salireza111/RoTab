import { readPreferences } from "./storage";
export async function api<T>(
  path: string,
  body?: unknown,
  token?: string,
  serverUrl?: string,
): Promise<T> {
  const url = serverUrl ?? readPreferences().apiUrl;
  if (!url)
    throw new Error(
      "No hosted research service is configured. Browser calculations work without a server.",
    );
  let response: Response;
  try {
    response = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new Error(
      timedOut
        ? `The research server at ${url} did not respond within 10 seconds. Try again shortly.`
        : `Cannot reach the research server at ${url}. Check your connection and the server address in Settings, then try again.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const data = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw Object.assign(new Error(data.error ?? "Request failed."), {
      status: response.status,
    });
  }
  return response.json();
}

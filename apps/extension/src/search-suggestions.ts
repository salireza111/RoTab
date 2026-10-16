export const SUGGESTION_PROVIDERS = [
  {
    id: "google",
    name: "Google",
    origin: "https://suggestqueries.google.com/*",
    endpoint: "https://suggestqueries.google.com/complete/search",
    parameter: "q",
    extra: { client: "firefox" },
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    origin: "https://duckduckgo.com/*",
    endpoint: "https://duckduckgo.com/ac/",
    parameter: "q",
    extra: { type: "list" },
  },
  {
    id: "brave",
    name: "Brave",
    origin: "https://search.brave.com/*",
    endpoint: "https://search.brave.com/api/suggest",
    parameter: "q",
    extra: { rich: "false" },
  },
  {
    id: "bing",
    name: "Bing",
    origin: "https://www.bing.com/*",
    endpoint: "https://www.bing.com/osjson.aspx",
    parameter: "query",
    extra: {},
  },
] as const;

export type SuggestionProviderId = (typeof SUGGESTION_PROVIDERS)[number]["id"];
export type SearchProvider = SuggestionProviderId | "default";

export function selectedSearchUrl(
  id: SuggestionProviderId,
  query: string,
): string {
  const origins = {
    google: "https://www.google.com/search",
    duckduckgo: "https://duckduckgo.com/",
    brave: "https://search.brave.com/search",
    bing: "https://www.bing.com/search",
  };
  const url = new URL(origins[id]);
  url.searchParams.set("q", query.trim());
  return url.href;
}

export function suggestionProvider(id: SuggestionProviderId) {
  return SUGGESTION_PROVIDERS.find((provider) => provider.id === id)!;
}

export function suggestionUrl(id: SuggestionProviderId, query: string): string {
  const provider = suggestionProvider(id),
    url = new URL(provider.endpoint);
  url.searchParams.set(provider.parameter, query.trim().slice(0, 500));
  for (const [key, value] of Object.entries(provider.extra))
    url.searchParams.set(key, value);
  return url.href;
}

export function parseSuggestions(value: unknown, query: string): string[] {
  if (!Array.isArray(value) || !Array.isArray(value[1])) return [];
  const seen = new Set([query.trim().toLocaleLowerCase()]),
    result: string[] = [];
  for (const item of value[1].slice(0, 40)) {
    if (typeof item !== "string") continue;
    const text = item.trim(),
      key = text.toLocaleLowerCase();
    if (
      !text ||
      text.length > 180 ||
      /[\u0000-\u001f\u007f]/.test(text) ||
      seen.has(key)
    )
      continue;
    seen.add(key);
    result.push(text);
    if (result.length === 8) break;
  }
  return result;
}

export async function hasSuggestionAccess(
  id: SuggestionProviderId,
): Promise<boolean> {
  return (
    !!globalThis.chrome?.permissions?.contains &&
    chrome.permissions.contains({ origins: [suggestionProvider(id).origin] })
  );
}

export async function requestSuggestionAccess(
  id: SuggestionProviderId,
): Promise<boolean> {
  return (
    !!globalThis.chrome?.permissions?.request &&
    chrome.permissions.request({ origins: [suggestionProvider(id).origin] })
  );
}

export class SuggestionRequestError extends Error {
  constructor(
    public status: number,
    public retryAfterMs = 0,
  ) {
    super("Suggestions unavailable");
  }
}

export async function fetchSuggestions(
  id: SuggestionProviderId,
  query: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (query.trim().length < 2) return [];
  const response = await fetch(suggestionUrl(id, query), {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const retry = response.headers.get("retry-after");
    const delay = retry
      ? /^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now()
      : 60000;
    throw new SuggestionRequestError(
      response.status,
      response.status === 429
        ? Math.max(
            1000,
            Math.min(300000, Number.isFinite(delay) ? delay : 60000),
          )
        : 0,
    );
  }
  if (!response.body) throw new Error("Suggestions unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new Error("Suggestion response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseSuggestions(JSON.parse(new TextDecoder().decode(body)), query);
}

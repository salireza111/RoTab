import { afterEach, expect, it, vi } from "vitest";
import {
  SUGGESTION_PROVIDERS,
  SuggestionRequestError,
  fetchSuggestions,
  hasSuggestionAccess,
  parseSuggestions,
  requestSuggestionAccess,
  selectedSearchUrl,
  suggestionUrl,
} from "./search-suggestions";
import { readPreferences } from "./storage";

afterEach(() => vi.unstubAllGlobals());

it("reports rate limits with a bounded cooldown and no response-body retention", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response("limited", { status: 429, headers: { "Retry-After": "2" } }),
    );
  vi.stubGlobal("fetch", fetch);
  const failure = await fetchSuggestions(
    "brave",
    "protein",
    new AbortController().signal,
  ).catch((error) => error);
  expect(failure).toBeInstanceOf(SuggestionRequestError);
  expect(failure).toMatchObject({ status: 429, retryAfterMs: 2000 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("uses only the four selected providers and encodes text as one query parameter", () => {
  expect(SUGGESTION_PROVIDERS.map((provider) => provider.id)).toEqual([
    "google",
    "duckduckgo",
    "brave",
    "bing",
  ]);
  for (const provider of SUGGESTION_PROVIDERS) {
    const text = "پروتئین & q=other #fragment";
    const suggest = new URL(suggestionUrl(provider.id, text));
    const search = new URL(selectedSearchUrl(provider.id, text));
    expect(suggest.protocol).toBe("https:");
    expect(suggest.searchParams.get(provider.parameter)).toBe(text);
    expect(search.searchParams.get("q")).toBe(text);
    expect(search.hash).toBe("");
    expect(search.username).toBe("");
  }
});

it("discards saved engine choices so they cannot override the browser default on new tabs", () => {
  for (const data of [
    {},
    { googleSuggestions: true },
    { searchProvider: "zarebin", searchSuggestionsEnabled: true },
    { searchProvider: "default", searchSuggestionsEnabled: true },
  ]) {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(data) });
    expect(readPreferences()).not.toHaveProperty("searchProvider");
    expect(readPreferences()).not.toHaveProperty("googleSuggestions");
  }
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        searchProvider: "brave",
        searchSuggestionsEnabled: true,
      }),
  });
  expect(readPreferences()).not.toHaveProperty("searchProvider");
  expect(readPreferences().searchSuggestionsEnabled).toBe(true);
});

it("cleans and bounds remote suggestions without interpreting their text", () => {
  expect(
    parseSuggestions(
      [
        "protein",
        [
          null,
          {},
          " protein ",
          "protein folding",
          "PROTEIN FOLDING",
          "",
          "x\nlog",
          "x".repeat(181),
          "<script>alert(1)</script>",
        ],
      ],
      "protein",
    ),
  ).toEqual(["protein folding", "<script>alert(1)</script>"]);
  expect(
    parseSuggestions(
      ["p", Array.from({ length: 50 }, (_, i) => `protein ${i}`)],
      "p",
    ),
  ).toHaveLength(8);
  for (const value of [null, {}, ["query", {}], "not json"])
    expect(parseSuggestions(value, "p")).toEqual([]);
});

it("requests permission for exactly the selected provider", async () => {
  const contains = vi.fn().mockResolvedValue(false),
    request = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("chrome", { permissions: { contains, request } });
  expect(await hasSuggestionAccess("brave")).toBe(false);
  expect(await requestSuggestionAccess("brave")).toBe(true);
  expect(contains).toHaveBeenCalledExactlyOnceWith({
    origins: ["https://search.brave.com/*"],
  });
  expect(request).toHaveBeenCalledExactlyOnceWith({
    origins: ["https://search.brave.com/*"],
  });
});

it("fetches JSON without cookies, referrer, caching, redirects or a script loader", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(["protein", ["protein folding"]])),
    );
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(await fetchSuggestions("bing", "protein", signal)).toEqual([
    "protein folding",
  ]);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    suggestionUrl("bing", "protein"),
    {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      headers: { Accept: "application/json" },
    },
  );
  expect(await fetchSuggestions("bing", "p", signal)).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects failed, malformed and oversized responses instead of switching providers", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const response of [
    new Response("unavailable", { status: 503 }),
    new Response("<html>failure</html>"),
    new Response("x".repeat(65537)),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(
      fetchSuggestions("google", "protein", new AbortController().signal),
    ).rejects.toThrow();
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    fetch.mock.calls.every(
      ([url]) => new URL(url).hostname === "suggestqueries.google.com",
    ),
  ).toBe(true);
});

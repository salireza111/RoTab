import { afterEach, expect, it, vi } from "vitest";
import { searchWithDefaultProvider } from "./SearchBox";
import { readPreferences } from "./storage";

afterEach(() => vi.unstubAllGlobals());

it("passes the complete query to the browser without choosing a provider", async () => {
  const query = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { search: { query } });
  await expect(searchWithDefaultProvider("  protein folding & dynamics  ")).resolves.toBe(true);
  expect(query).toHaveBeenCalledExactlyOnceWith({ text: "protein folding & dynamics", disposition: "CURRENT_TAB" });
});

it("does not submit an empty query", async () => {
  const query = vi.fn();
  vi.stubGlobal("chrome", { search: { query } });
  await expect(searchWithDefaultProvider(" \n\t ")).resolves.toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it("does not fall back to a remote provider when the browser API is missing or fails", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("chrome", {});
  await expect(searchWithDefaultProvider("protein")).rejects.toThrow("browser's address bar");
  vi.stubGlobal("chrome", { search: { query: vi.fn().mockRejectedValue(new Error("Browser search failed")) } });
  await expect(searchWithDefaultProvider("protein")).rejects.toThrow("Browser search failed");
  expect(fetch).not.toHaveBeenCalled();
});

it("discards the legacy Google suggestions preference on upgrade", () => {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ googleSuggestions: true, view: "home" }) });
  expect(readPreferences()).not.toHaveProperty("googleSuggestions");
});

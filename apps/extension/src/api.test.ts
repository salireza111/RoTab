import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

const settings = vi.hoisted(() => ({ apiUrl: "https://research.example.org" }));
vi.mock("./storage", () => ({
  readPreferences: () => settings,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  settings.apiUrl = "https://research.example.org";
});

it("makes no network request when a hosted service is not configured", async () => {
  settings.apiUrl = "";
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(api("/v1/stats")).rejects.toThrow(
    "Browser calculations work without a server",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("sends a checkpoint to its original service after preferences change", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  await api(
    "/v1/leases/task/complete",
    {},
    undefined,
    "https://original.example.org",
  );
  expect(fetch.mock.calls[0][0]).toBe(
    "https://original.example.org/v1/leases/task/complete",
  );
});

it("identifies the unreachable research server without suggesting volunteer software installation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
  );
  await expect(api("/v1/leases/claim", {})).rejects.toThrow(
    "Cannot reach the research server at https://research.example.org. Check your connection and the server address in Settings, then try again.",
  );
});

it("distinguishes a request timeout from an unreachable server", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError")),
  );
  await expect(api("/v1/capabilities")).rejects.toThrow(
    "did not respond within 10 seconds",
  );
});

it.each([409, 503])(
  "preserves HTTP %s for lease fencing and upload retries",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: "Scientific service response" }),
            { status },
          ),
        ),
    );
    await expect(api("/v1/leases/task/renew", {})).rejects.toMatchObject({
      message: "Scientific service response",
      status,
    });
  },
);

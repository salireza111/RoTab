import { afterEach, expect, it, vi } from "vitest";
import { faviconUrl } from "./SiteIcon";
import { packagedSiteIcon } from "./bundled-sites";

afterEach(() => vi.unstubAllGlobals());
it("distinguishes documentation and personal sites on the same Pages domain", () => {
  expect(packagedSiteIcon("https://salireza111.github.io/RoTab_Doc")).toBe(
    "./status-32.png",
  );
  expect(
    packagedSiteIcon("https://salireza111.github.io/RoTab_Doc/help/index.html"),
  ).toBe("./status-32.png");
  expect(packagedSiteIcon("https://salireza111.github.io/")).toBe(
    "./favorites/alireza.png",
  );
  expect(
    packagedSiteIcon("https://salireza111.github.io/another-project/"),
  ).toBeUndefined();
  expect(
    packagedSiteIcon("https://name:password@salireza111.github.io/RoTab_Doc/"),
  ).toBeUndefined();
});
it("encodes a site's URL in the extension's favicon service without a public proxy", () => {
  vi.stubGlobal("chrome", {
    runtime: {
      id: "rotab",
      getURL: (path: string) => `chrome-extension://rotab${path}`,
    },
  });
  const result = new URL(faviconUrl("https://example.org/a?x=1&y=2")!);
  expect(result.origin).not.toContain("google");
  expect(result.protocol).toBe("chrome-extension:");
  expect(result.pathname).toBe("/_favicon/");
  expect(result.searchParams.get("pageUrl")).toBe(
    "https://example.org/a?x=1&y=2",
  );
  expect(result.searchParams.get("size")).toBe("32");
});
it("keeps initials available in the web preview and rejects credential or non-web URLs", () => {
  expect(faviconUrl("https://example.org")).toBeUndefined();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "rotab",
      getURL: (path: string) => `chrome-extension://rotab${path}`,
    },
  });
  for (const value of [
    "javascript:alert(1)",
    "file:///tmp/private",
    "https://name:password@example.org",
    "invalid",
  ])
    expect(faviconUrl(value)).toBeUndefined();
});

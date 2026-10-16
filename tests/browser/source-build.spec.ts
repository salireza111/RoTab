import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route(/^https:\/\//, route => route.abort());
  await context.routeWebSocket(/^wss?:\/\//, socket => socket.close());
});

test("source preview keeps browser-default search and resets explicit alternatives on reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as any).__searchCalls = calls;
    (window as any).chrome = {
      search: { query: async (query: unknown) => { calls.push(query); } },
    };
  });
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Search the web" });
  await expect(search).toHaveAttribute("placeholder", "Search");
  await search.fill("protein structure");
  await search.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__searchCalls)).toEqual([
    { text: "protein structure", disposition: "CURRENT_TAB" },
  ]);
  await page.getByRole("button", { name: "Search engine: Browser default", exact: true }).click();
  const options = page.getByRole("menuitemradio");
  await expect(options).toHaveText(["Browser default", "Google", "DuckDuckGo", "Brave", "Bing"]);
  await expect(options.first()).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Google", exact: true }).click();
  await expect(page.getByRole("button", { name: "Search engine: Google", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Search engine: Browser default", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("source metadata disables calculation and Settings retains its documentation footer", async ({ page, request }) => {
  const response = await request.get("/engine/engine-metadata.json");
  expect(response.ok()).toBe(true);
  expect((await response.json()).verified).toBe(false);
  await page.goto("/");
  await page.getByRole("button", { name: "Computation settings", exact: true }).click();
  const footer = page.getByRole("navigation", { name: "Documentation and policies" });
  await expect(footer.getByRole("link", { name: "Help" })).toHaveAttribute("href", "https://salireza111.github.io/RoTab_Doc/help/index.html");
  await expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "https://salireza111.github.io/RoTab_Doc/policies/privacy.html");
  expect(await footer.evaluate(node => ({
    previous: node.previousElementSibling?.textContent,
    nextIsConfirmation: node.nextElementSibling?.classList.contains("modal-confirm"),
  }))).toEqual({ previous: "Restore widgets", nextIsConfirmation: true });
});

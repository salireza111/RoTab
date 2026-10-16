// Scientific computation is owned by a new-tab document, never this transient service worker.
chrome.runtime.onInstalled.addListener(() =>
  chrome.storage.local.get("installedAt", (data) => {
    if (!data.installedAt)
      chrome.storage.local.set({ installedAt: Date.now() });
  }),
);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "capabilities")
    reply({ engine: "packaged-wasm", computationInServiceWorker: false });
  if (message?.type === "computing-tab" && Number.isInteger(message.tabId)) {
    void (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      if (!tab.url?.startsWith(chrome.runtime.getURL("index.html"))) return;
      if (message.owner)
        await chrome.storage.session.set({ mainTabId: tab.id });
      else if (
        (await chrome.storage.session.get("mainTabId")).mainTabId === tab.id
      )
        await chrome.storage.session.remove("mainTabId");
      reply({ ok: true });
    })().catch(() => reply({ ok: false }));
    return true;
  }
  if (message?.type === "focus-computing-tab") {
    void (async () => {
      const { mainTabId } = await chrome.storage.session.get("mainTabId");
      if (!Number.isInteger(mainTabId)) throw new Error("No main tab");
      const tab = await chrome.tabs.get(mainTabId);
      if (!tab.url?.startsWith(chrome.runtime.getURL("index.html")))
        throw new Error("Not a RoTab");
      await chrome.tabs.update(mainTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      reply({ ok: true });
    })().catch(() => reply({ ok: false }));
    return true;
  }
});
// Permission revocation also discards the local Calendar session.
chrome.permissions.onRemoved.addListener(() => {
  void chrome.permissions
    .contains({
      permissions: ["identity"],
      origins: ["https://www.googleapis.com/*"],
    })
    .then((allowed) => {
      if (!allowed)
        return chrome.storage.session.remove("rotab:google-calendar-session");
    });
});

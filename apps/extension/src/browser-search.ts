export async function searchWithDefaultProvider(
  text: string,
): Promise<boolean> {
  const query = text.trim();
  if (!query) return false;
  if (!globalThis.chrome?.search?.query)
    throw new Error(
      "Web search is unavailable here. Use your browser's address bar.",
    );
  await chrome.search.query({ text: query, disposition: "CURRENT_TAB" });
  return true;
}

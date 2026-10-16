// Compile the packaged binary once per concurrent pool. Single-worker runs
// compile inside their disposable worker instead. Structured cloning a compiled
// module shares immutable engine code; every worker still owns its instance,
// linear memory, database, and random state. Do not retain a global cache after
// the pool stops, or load executable bytes from a task/network message.
export async function compileScientificModule(): Promise<WebAssembly.Module> {
  const response = await fetch(
    new URL("../engine/rosetta.wasm", import.meta.url),
  );
  if (!response.ok)
    throw new Error(`Engine binary unavailable (${response.status}).`);
  return WebAssembly.compileStreaming(response);
}

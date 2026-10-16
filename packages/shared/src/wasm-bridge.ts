/** Host-side ABI shared by the extension and standalone SDK. */
export interface RosettaWasmModule {
  HEAPU8: Uint8Array;
  ccall(
    name: string,
    result: string,
    args: string[],
    values: unknown[],
    options: { async: true },
  ): Promise<string>;
}

export interface WasmAllocator {
  malloc(bytes: number): number;
  free(pointer: number): void;
}

/** The pinned binary exports these functions, even though Module does not. */
export function wasmAllocator(exports: WebAssembly.Exports): WasmAllocator {
  const { malloc, free } = exports;
  if (typeof malloc !== "function" || typeof free !== "function")
    throw new Error("The Rosetta engine is missing its heap allocator.");
  return {
    malloc: malloc as WasmAllocator["malloc"],
    free: free as WasmAllocator["free"],
  };
}

export async function runRosettaProtocol(
  engine: RosettaWasmModule,
  allocator: WasmAllocator,
  pdb: string,
  protocol: string,
  seed: number,
  dutyCycle: number,
): Promise<string> {
  // ccall's string conversion uses the C stack (1 MiB in this build).
  // Large structures must instead live on the heap throughout Asyncify yields.
  const bytes = new TextEncoder().encode(pdb);
  const pointer = allocator.malloc(bytes.byteLength + 1);
  if (!pointer)
    throw new Error("WASM memory allocation failed for the protein input.");
  try {
    // malloc may grow linear memory and replace HEAPU8. Read the current view.
    engine.HEAPU8.set(bytes, pointer);
    engine.HEAPU8[pointer + bytes.byteLength] = 0;
    return await engine.ccall(
      "rosettatab_run_protocol",
      "string",
      ["number", "string", "number", "number"],
      [pointer, protocol, seed, dutyCycle],
      { async: true },
    );
  } finally {
    allocator.free(pointer);
  }
}

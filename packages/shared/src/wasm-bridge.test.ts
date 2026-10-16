import { describe, expect, it, vi } from "vitest";
import {
  runRosettaProtocol,
  wasmAllocator,
  type RosettaWasmModule,
} from "./wasm-bridge";

describe("WASM input buffer lifetime", () => {
  it("passes an input larger than the C stack intact on the heap, including UTF-8", async () => {
    const pdb = "REMARK café\n" + "ATOM  ".repeat(200_000);
    const bytes = new TextEncoder().encode(pdb);
    let finish!: (value: string) => void;
    const completion = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const pointer = 64;
    const engine: RosettaWasmModule = {
      HEAPU8: new Uint8Array(64),
      ccall: vi.fn(() => completion),
    };
    const allocator = {
      malloc: vi.fn((size: number) => {
        // Simulate memory growth invalidating the old HEAPU8 during malloc.
        engine.HEAPU8 = new Uint8Array(pointer + size);
        return pointer;
      }),
      free: vi.fn(),
    };
    const result = runRosettaProtocol(engine, allocator, pdb, "score", 17, 75);
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
    expect(allocator.malloc).toHaveBeenCalledWith(bytes.byteLength + 1);
    expect(
      new TextDecoder().decode(
        engine.HEAPU8.subarray(pointer, pointer + bytes.length),
      ),
    ).toBe(pdb);
    expect(engine.HEAPU8[pointer + bytes.length]).toBe(0);
    expect(engine.ccall).toHaveBeenCalledWith(
      "rosettatab_run_protocol",
      "string",
      ["number", "string", "number", "number"],
      [pointer, "score", 17, 75],
      { async: true },
    );
    expect(allocator.free).not.toHaveBeenCalled();
    finish('{"energy":1}');
    await expect(result).resolves.toBe('{"energy":1}');
    expect(allocator.free).toHaveBeenCalledExactlyOnceWith(pointer);
  });

  it("releases the input on a rejected calculation", async () => {
    const error = new Error("Scientific failure");
    const engine: RosettaWasmModule = {
      HEAPU8: new Uint8Array(128),
      ccall: vi.fn().mockRejectedValue(error),
    };
    const allocator = { malloc: vi.fn(() => 64), free: vi.fn() };
    await expect(
      runRosettaProtocol(engine, allocator, "protein", "score", 17, 75),
    ).rejects.toBe(error);
    expect(allocator.free).toHaveBeenCalledExactlyOnceWith(64);
  });

  it("does not enter Rosetta or overwrite address zero if allocation fails", async () => {
    const engine: RosettaWasmModule = {
      HEAPU8: new Uint8Array(128),
      ccall: vi.fn(),
    };
    const allocator = { malloc: vi.fn(() => 0), free: vi.fn() };
    await expect(
      runRosettaProtocol(engine, allocator, "protein", "score", 17, 75),
    ).rejects.toThrow(/memory allocation/);
    expect(engine.ccall).not.toHaveBeenCalled();
    expect(allocator.free).not.toHaveBeenCalled();
  });

  it("requires the pinned engine's real allocator exports", () => {
    expect(() => wasmAllocator({})).toThrow(/heap allocator/);
  });
});

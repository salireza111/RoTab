import { validatePdb } from "./input.js";
import { validateResultIdentity } from "../../shared/src/protocols";
import {
  runRosettaProtocol,
  wasmAllocator,
  type RosettaWasmModule,
  type WasmAllocator,
} from "../../shared/src/wasm-bridge";
import { sha256, validateManifest, validateRequest } from "./validation.js";
import {
  ENGINE_HASHES,
  ENGINE_ID,
  SOURCE_SHA,
  type Phase,
  type Protocol,
  type SnapshotSource,
} from "./types.js";

const scope = globalThis as any;
let module: RosettaWasmModule | undefined;
let allocator: WasmAllocator | undefined;
let loadedUrl: string | undefined;
let busy = false;
let requestId = 0;
let diagnostics = false;
const send = (type: string, data: object) =>
  scope.postMessage({ type, id: requestId, ...data });
const phase = (value: Phase) => send("phase", { phase: value });

async function initialize(engineUrl: string): Promise<RosettaWasmModule> {
  if (module) {
    if (loadedUrl !== engineUrl)
      throw new Error("Cannot change the engine directory of a loaded worker.");
    return module;
  }
  phase("verifying-assets");
  const manifestResponse = await fetch(new URL("manifest.json", engineUrl));
  if (!manifestResponse.ok)
    throw new Error(
      `Engine manifest unavailable (${manifestResponse.status}).`,
    );
  validateManifest(await manifestResponse.json());
  const buffers = new Map<string, ArrayBuffer>();
  // Verify scientific bytes before instantiation. Fetch one at a time to bound transient buffers.
  for (const [name, expected] of Object.entries(ENGINE_HASHES)) {
    const response = await fetch(new URL(name, engineUrl), {
      cache: "force-cache",
    });
    if (!response.ok)
      throw new Error(
        `Engine asset unavailable: ${name} (${response.status}).`,
      );
    const bytes = await response.arrayBuffer();
    if ((await sha256(bytes)) !== expected)
      throw new Error(`Engine SHA-256 mismatch: ${name}`);
    if (name !== "rosetta.mjs") buffers.set(name, bytes);
  }
  phase("loading-module");
  // This exact Emscripten build excludes Module.wasmBinary. Its supported
  // instantiateWasm hook can instantiate a module compiled from verified bytes.
  const compiled = await WebAssembly.compile(buffers.get("rosetta.wasm")!);
  buffers.delete("rosetta.wasm");
  // The JS URL is trusted local/static hosting. Pinning does not attest a hostile host/browser.
  const factory = (
    await import(/* @vite-ignore */ new URL("rosetta.mjs", engineUrl).href)
  ).default;
  const instance = await factory({
    locateFile: (name: string) => new URL(name, engineUrl).href,
    instantiateWasm: (
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance) => void,
    ) => {
      const instance = new WebAssembly.Instance(compiled, imports);
      allocator = wasmAllocator(instance.exports);
      receive(instance);
      return instance.exports;
    },
    getPreloadedPackage: () => buffers.get("rosetta.data"),
    print: (message: string) => {
      if (diagnostics) send("log", { message });
    },
    printErr: (message: string) => {
      if (diagnostics) send("log", { message });
    },
  });
  buffers.clear();
  if (!allocator) throw new Error("Engine heap allocator unavailable.");
  module = instance;
  loadedUrl = engineUrl;
  return instance;
}

scope.rosettatabSnapshot = (
  pdb: string,
  energy: number,
  progress: number,
  source: SnapshotSource,
  sequence: number,
  iteration: number,
) => {
  send("snapshot", {
    snapshot: {
      pdb,
      energy,
      progress,
      source,
      sequence,
      iteration,
      timestamp: Date.now(),
      heapBytes: module?.HEAPU8.byteLength ?? 0,
    },
  });
};
scope.onmessage = async (event: MessageEvent) => {
  const request = event.data as {
    type: string;
    id: number;
    engineUrl: string;
    protocol: Protocol;
    pdb: string;
    seed: number;
    dutyCycle: number;
    diagnostics: boolean;
  };
  if (request.type !== "run") return;
  if (busy) {
    scope.postMessage({
      type: "error",
      id: request.id,
      message: "Worker already running a protocol.",
    });
    return;
  }
  busy = true;
  requestId = request.id;
  diagnostics = request.diagnostics;
  const started = performance.now(),
    cold = !module;
  try {
    validateRequest(request.protocol, request.seed, request.dutyCycle);
    validatePdb(request.pdb);
    const engine = await initialize(request.engineUrl);
    const initialized = performance.now();
    phase("calculating");
    const encoded = await runRosettaProtocol(
      engine,
      allocator!,
      request.pdb,
      request.protocol,
      request.seed,
      request.dutyCycle,
    );
    const finished = performance.now();
    const result = JSON.parse(encoded);
    if (result.error) throw new Error(result.error);
    if (
      result.protocol !== request.protocol ||
      result.scoreFunction !== "ref2015" ||
      !Number.isFinite(result.energy) ||
      !Number.isFinite(result.objectiveEnergy) ||
      result.objectiveScoreFunction !==
        (request.protocol.startsWith("cartesian_") ? "ref2015_cart" : "ref2015")
    )
      throw new Error("Invalid Rosetta result contract.");
    validatePdb(result.pdb);
    validateResultIdentity(request.pdb, result.pdb, request.protocol);
    const encoder = new TextEncoder();
    send("result", {
      result: {
        ...result,
        heapBytes: engine.HEAPU8.byteLength,
        provenance: {
          engineId: ENGINE_ID,
          sourceSha: SOURCE_SHA,
          hashes: ENGINE_HASHES,
          inputSha256: await sha256(encoder.encode(request.pdb)),
          outputSha256: await sha256(encoder.encode(result.pdb)),
          seed: request.seed,
          dutyCycle: request.dutyCycle,
        },
        timing: {
          initializationMs: cold ? initialized - started : 0,
          calculationMs: finished - initialized,
          totalMs: performance.now() - started,
        },
      },
    });
  } catch (error) {
    send("error", {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busy = false;
    diagnostics = false;
  }
};

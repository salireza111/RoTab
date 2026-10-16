/// <reference lib="webworker" />
import {
  ENGINE_ID,
  SOURCE_SHA,
  protocolSchema,
  validatePdb,
  type Task,
} from "@rosettatab/shared";
import {
  runRosettaProtocol,
  wasmAllocator,
  type RosettaWasmModule,
  type WasmAllocator,
} from "../../../packages/shared/src/wasm-bridge";
const scope = self as unknown as DedicatedWorkerGlobalScope;
let modulePromise:
  | Promise<{
      module: RosettaWasmModule;
      allocator: WasmAllocator;
    }>
  | undefined;
let busy = false;
scope.onmessage = async (event) => {
  if (event.data.type !== "run") return;
  if (busy) {
    scope.postMessage({
      type: "error",
      message: "This scientific worker already has an active calculation.",
    });
    return;
  }
  busy = true;
  const { task, dutyCycle, compiledModule } = event.data as {
    task: Task;
    dutyCycle: number;
    compiledModule?: WebAssembly.Module;
  };
  let telemetryTimer: ReturnType<typeof setInterval> | undefined;
  try {
    protocolSchema.parse(task.protocol);
    validatePdb(task.pdb);
    if (task.engineId !== ENGINE_ID || task.sourceSha !== SOURCE_SHA)
      throw new Error("This task targets a different engine version.");
    scope.postMessage({ type: "phase", phase: "Checking packaged engine" });
    const manifest = await fetch(
      new URL("../engine/engine-metadata.json", scope.location.href),
    ).then((r) => r.json());
    if (
      !manifest.verified ||
      manifest.sourceSha !== SOURCE_SHA ||
      manifest.id !== ENGINE_ID
    )
      throw new Error("The Rosetta WASM engine is not verified.");
    if (!manifest.supportedProtocols?.includes(task.protocol))
      throw new Error(
        "This protocol has not passed the packaged engine's scientific and browser gates.",
      );
    // This fixed URL resolves to extension-packaged code, never the task server.
    const moduleUrl = new URL("../engine/rosetta.mjs", scope.location.href)
      .href;
    const factory = (await import(/* @vite-ignore */ moduleUrl)).default;
    scope.postMessage({ type: "phase", phase: "Loading engine and database" });
    let announcedReady = false;
    (scope as any).rosettatabSnapshot = (
      pdb: string,
      energy: number,
      progress: number,
      source: string,
      sequence: number,
      iteration: number,
    ) => {
      // Rosetta initializes lazily inside the scientific entry point. Its first
      // real snapshot proves the expensive initialization completed; only then
      // may the pool cold-start another instance to limit transient allocation.
      if (!announcedReady) {
        announcedReady = true;
        scope.postMessage({ type: "ready" });
      }
      scope.postMessage({
        type: "snapshot",
        pdb,
        energy,
        progress,
        source,
        sequence,
        iteration,
        timestamp: Date.now(),
        heapBytes: module.HEAPU8?.byteLength,
      });
    };
    const { module, allocator } = await (modulePromise ??= (async () => {
      // Concurrent pools send a shared, compiled packaged engine. Single-worker
      // runs compile here so the long-lived page never owns that native code.
      let compiled = compiledModule;
      if (!compiled) {
        const response = await fetch(
          new URL("../engine/rosetta.wasm", scope.location.href),
        );
        if (!response.ok)
          throw new Error(`Engine binary unavailable (${response.status}).`);
        compiled = await WebAssembly.compileStreaming(response);
      }
      let allocator: WasmAllocator | undefined;
      const module: RosettaWasmModule = await factory({
        locateFile: (name: string) =>
          new URL("../engine/" + name, scope.location.href).href,
        instantiateWasm: (
          imports: WebAssembly.Imports,
          receive: (instance: WebAssembly.Instance) => void,
        ) => {
          const instance = new WebAssembly.Instance(compiled, imports);
          allocator = wasmAllocator(instance.exports);
          receive(instance);
          return instance.exports;
        },
        print: (message: string) => {
          if (event.data.diagnostics)
            scope.postMessage({ type: "diagnostic", message });
        },
        printErr: (message: string) => {
          if (event.data.diagnostics)
            scope.postMessage({ type: "diagnostic", message });
        },
      });
      if (!allocator) throw new Error("Engine heap allocator unavailable.");
      return { module, allocator };
    })().catch((error: unknown) => {
      modulePromise = undefined;
      throw error;
    }));
    // Reading the allocated linear-memory length does not invoke Rosetta or
    // rescore a structure. Timers run only when the cooperative engine yields.
    const publishMemory = () =>
      scope.postMessage({
        type: "telemetry",
        heapBytes: module.HEAPU8?.byteLength,
      });
    publishMemory();
    telemetryTimer = setInterval(publishMemory, 2_000);
    scope.postMessage({ type: "phase", phase: "Running Rosetta" });
    const result = JSON.parse(
      await runRosettaProtocol(
        module,
        allocator,
        task.pdb,
        task.protocol,
        task.seed,
        dutyCycle,
      ),
    );
    if (result.error) throw new Error(result.error);
    scope.postMessage({
      type: "result",
      ...result,
      heapBytes: module.HEAPU8?.byteLength,
    });
  } catch (error) {
    if (event.data.diagnostics && error instanceof Error)
      scope.postMessage({
        type: "diagnostic",
        message: error.stack ?? error.message,
      });
    scope.postMessage({
      type: "error",
      message:
        /out of memory|\boom\b|bad_alloc|cannot enlarge memory|memory allocation/i.test(
          String(error),
        )
          ? "This calculation exhausted the WASM engine's 512 MiB memory budget. The input is retained. Try a less memory-intensive protocol."
          : error instanceof Error
            ? error.message
            : String(error),
    });
  } finally {
    if (telemetryTimer) clearInterval(telemetryTimer);
    busy = false;
  }
};

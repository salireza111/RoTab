import { validatePdb } from "./input.js";
import { validateRequest } from "./validation.js";
import type {
  ClientOptions,
  Protocol,
  ProtocolRunner,
  Result,
  RunOptions,
} from "./types.js";

/** One reusable, isolated Emscripten instance in a dedicated browser worker. */
export class RosettaClient implements ProtocolRunner {
  private worker?: Worker;
  private closed = false;
  private nextId = 0;
  private pending?: {
    id: number;
    options: RunOptions;
    resolve: (result: Result) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  };
  private readonly engineUrl: string;
  private readonly workerUrl: URL;

  constructor(options: ClientOptions) {
    const base =
      typeof location === "undefined" ? import.meta.url : location.href;
    const engine = new URL(options.engineUrl.toString(), base);
    if (
      engine.search ||
      engine.hash ||
      !["https:", "http:", "chrome-extension:"].includes(engine.protocol)
    )
      throw new Error(
        "engineUrl must be an HTTP(S) or extension asset directory without query or fragment.",
      );
    if (!engine.pathname.endsWith("/")) engine.pathname += "/";
    this.engineUrl = engine.href;
    this.workerUrl = options.workerUrl
      ? new URL(options.workerUrl.toString(), base)
      : new URL("./worker.js", import.meta.url);
  }

  async run(
    protocol: Protocol,
    pdb: string,
    options: RunOptions = {},
  ): Promise<Result> {
    if (this.closed) throw new Error("RosettaClient is closed.");
    if (this.pending)
      throw new Error(
        "RosettaClient is busy. Await the current run or use a separate client.",
      );
    const seed = options.seed ?? 17,
      dutyCycle = options.dutyCycle ?? 25;
    validateRequest(protocol, seed, dutyCycle);
    validatePdb(pdb);
    if (options.signal?.aborted)
      throw new DOMException("Calculation aborted.", "AbortError");
    if (!this.worker) {
      this.worker = new Worker(this.workerUrl, {
        type: "module",
        name: "rotab-rosetta-wasm",
      });
      this.worker.onmessage = (event) => this.message(event.data);
      this.worker.onerror = (event) =>
        this.fail(new Error(event.message || "Rosetta worker failed."));
      this.worker.onmessageerror = () =>
        this.fail(new Error("Rosetta worker message could not be decoded."));
    }
    return new Promise<Result>((resolve, reject) => {
      const id = ++this.nextId;
      const abort = () =>
        this.fail(
          new DOMException(
            "Calculation aborted; unfinished work must replay from its seed.",
            "AbortError",
          ),
        );
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      this.pending = { id, options, resolve, reject, cleanup };
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.worker!.postMessage({
          type: "run",
          id,
          engineUrl: this.engineUrl,
          protocol,
          pdb,
          seed,
          dutyCycle,
          diagnostics: !!options.onLog,
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private message(event: any) {
    const pending = this.pending;
    if (!pending || pending.id !== event.id) return;
    if (event.type === "error") {
      this.fail(new Error(event.message));
      return;
    }
    if (event.type === "result") {
      this.pending = undefined;
      pending.cleanup();
      pending.resolve(event.result);
      return;
    }
    // A consumer's drawing/logging error must not strand the scientific promise.
    try {
      if (event.type === "snapshot")
        pending.options.onSnapshot?.(event.snapshot);
      if (event.type === "phase") pending.options.onPhase?.(event.phase);
      if (event.type === "log") pending.options.onLog?.(event.message);
    } catch (error) {
      console.error("RoTab SDK observer failed:", error);
    }
  }
  private fail(error: Error) {
    this.worker?.terminate();
    this.worker = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      pending.cleanup();
      pending.reject(error);
    }
  }
  /** Releases the heap and aborts active work. Construct a new client to run again. */
  close() {
    this.closed = true;
    this.fail(new DOMException("RosettaClient closed.", "AbortError"));
  }
  score(pdb: string, options?: RunOptions) {
    return this.run("score", pdb, options);
  }
  relax(pdb: string, options?: RunOptions) {
    return this.run("relax", pdb, options);
  }
  minimize(pdb: string, options?: RunOptions) {
    return this.run("minimize", pdb, options);
  }
  repack(pdb: string, options?: RunOptions) {
    return this.run("repack", pdb, options);
  }
  fixedBackboneDesign(pdb: string, options?: RunOptions) {
    return this.run("fixed_backbone_design", pdb, options);
  }
  fastDesign(pdb: string, options?: RunOptions) {
    return this.run("fastdesign", pdb, options);
  }
  cartesianMinimize(pdb: string, options?: RunOptions) {
    return this.run("cartesian_minimize", pdb, options);
  }
  cartesianRelax(pdb: string, options?: RunOptions) {
    return this.run("cartesian_relax", pdb, options);
  }
}
export function createRosetta(options: ClientOptions): RosettaClient {
  return new RosettaClient(options);
}

# @rotab/rosetta-wasm

Standalone browser API for eight bounded Rosetta methods. A dedicated module worker runs the same **C++ → Emscripten → WASM** engine used by RoTab. The adapter has no extension, React, Nostr, task-server or native runtime dependency. Package name/version are prepared locally; this package has not been published to npm.

```js
import { createRosetta, preparePdb } from "@rotab/rosetta-wasm";
import { minimize } from "@rotab/rosetta-wasm/minimize";

const rosetta = createRosetta({
  engineUrl: new URL("/science/engine/", location.href),
  // When your bundler relocates workers, copy dist/ and use an explicit URL:
  // workerUrl: new URL("/science/sdk/worker.js", location.href),
});
const original = await (await fetch("/input.pdb")).text();
const prepared = preparePdb(original); // explicit, recorded protein-only preparation
try {
  const result = await minimize(rosetta, prepared.pdb, {
    seed: 17, dutyCycle: 25,
    onPhase: console.log,
    onSnapshot: frame => {
      console.log(frame.source, frame.energy); // REU; may rise as well as fall
      // Feed frame.pdb into the molecular viewer of your choice.
    },
  });
  console.log(result.pdb, result.energy, result.provenance);
} finally { rosetta.close(); }
```

The named methods are also instance methods: `rosetta.score(pdb)`, `rosetta.relax(pdb)`, etc. One client permits one run at a time and retains its warm worker. Additional clients run independent models in parallel; each owns a separate heap. Closing or aborting frees the worker and loses unfinished work. The SDK does not implement RoTab's shared-tab ownership, IndexedDB recovery or network scheduler.

| Import subpath | Named / instance method | Scientific protocol |
| --- | --- | --- |
| `/score` | `score` | Fixed-coordinate REF2015 |
| `/relax` | `relax` | One torsion FastRelax repeat |
| `/minimize` | `minimize` | Torsion L-BFGS, ≤200 iterations |
| `/repack` | `repack` | One fixed-sequence rotamer packing round |
| `/fixed-backbone-design` | `fixedBackboneDesign` | Canonical sequence design, fixed backbone |
| `/fastdesign` | `fastDesign` | One FastDesign repeat |
| `/cartesian-minimize` | `cartesianMinimize` | Cartesian minimization, ≤200 iterations |
| `/cartesian-relax` | `cartesianRelax` | One Cartesian FastRelax repeat |

Inputs: one standard-amino-acid chain in PDB format with complete N/CA/C/O backbone. There is no residue-count cap, but the per-worker WASM heap is limited to 512 MiB. Input acceptance is not a guarantee that large proteins fit or that their protocol has been scientifically validated. The benchmark scope is primarily 1L2Y (20 residues); the memory-fix engine's FastDesign fixtures use its first eight residues, and a separate scoring proof uses 1UBQ (76 residues).

`preparePdb` explicitly creates a protein-only copy: water, non-protein ions and ligands are removed, including their LINK/CONECT references. The v2 report records excluded component names and counts. Preserve `original` and `prepared.report`, and show a notice before starting a method: results exclude those components and their interactions. Modified amino acids are not silently deleted or substituted. `validatePdb` and the calculation methods remain strict; they do not perform this preparation implicitly.

The worker passes full PDB text in a heap-allocated UTF-8 buffer, rather than `ccall`'s temporary C-stack string. It retains the buffer through asynchronous yields and frees it after the call, including failures. Reusing a client does not retain past input buffers.

RoTab's shared-compilation and staged-startup pool is part of the extension host. Independent SDK clients do not inherit that coordinator: callers must budget their combined memory and avoid simultaneous cold initializations of many instances. Browser/compiler and database initialization memory is additional to the reported linear heap.

`Result.energy` is REF2015 rescoring of the returned PDB-rounded coordinates. Cartesian optimization adds `cart_bonded=0.5` and disables `pro_close`; `objectiveEnergy` describes that pre-rounding objective. Live snapshots are display-only REF2015 evaluations of actual intermediate states. Score-only emits initial/final states with no relaxation.

## Build and standalone example

From the repository root:

```sh
npm run sdk:build   # adapter ESM, method subpaths and .d.ts; no Rosetta binary copied
npm run sdk:pack    # dist/rotab-rosetta-wasm-0.1.0.tgz; never publishes
npm run sdk:bundle  # local dist/rosetta-wasm-standalone, with verified engine
npm run sdk:verify-browser # real browser runs and developer-only native rescoring
```

The standalone bundle's `example/index.html` uses `sdk/index.js`, `sdk/worker.js` and `engine/`. Deploy the directory as static HTTPS files or integrate it into an existing development preview; `file://` is unsupported. Static hosting delivers assets, while scientific computation runs in the participant's browser. Serve `.js/.mjs` as JavaScript and `.wasm` as `application/wasm`, with all generated chunks beside their entry points.

The engine directory must be trusted and versioned, containing `manifest.json`, `rosetta.mjs`, `rosetta.wasm` and `rosetta.data`. The SDK rejects a different manifest and verifies all three scientific file hashes before instantiation. The JS module is subsequently imported from that trusted URL; hashes detect mismatched or corrupted assets but cannot attest a hostile host or browser. The factory receives verified WASM/database buffers. Cross-origin engine hosting requires CORS; the worker script should be same-origin. This build uses Asyncify rather than pthreads and requires no SharedArrayBuffer isolation headers. The application's CSP must permit the local module worker and WASM compilation (for example `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`).

Cold initialization can take minutes; Emscripten factory completion is followed by Rosetta's lazy database/table setup on the first scientific call. `onPhase` reports coarse phases; snapshot frequency depends on calculation callbacks, with a nominal 200 ms internal throttle. `dutyCycle` is a cooperative active-time target from 10% to 75% for one worker, rather than system CPU utilization. Long synchronous initialization can exceed this target, and progress reporting remains limited to available callbacks.

The [standalone API documentation](https://salireza111.github.io/RoTab_Doc/wasm/quickstart.html) covers methods, architecture, deployment, scientific evidence and validation limits.

## Distribution

The adapter is MIT. Rosetta and its database are **separately licensed**. The `.tgz` deliberately omits Rosetta glue/WASM/database; separately assembled engine bundles retain upstream license/citation files. See [NOTICE.md](NOTICE.md). Scientific redistribution is governed by the applicable Rosetta terms. This is not an official BOINC client and cannot submit official results or earn Rosetta@home credit.

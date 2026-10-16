import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ENGINE_ID,
  SOURCE_SHA,
  prepareProteinPdb,
  type EngineManifest,
} from "@rosettatab/shared";
import {
  canonicalStringify,
  generatePeerIdentity,
  hashPeerJob,
  identityId,
  MAX_PEER_MESSAGE_BYTES,
  peerSha256,
  publicIdentity,
  signPeerMessage,
  validatePeerJob,
  validatePeerResult,
  verifyPeerMessage,
  type PeerIdentity,
  type PeerJob,
  type PeerResult,
} from "./peer-protocol";

const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
const hashes = {
  "rosetta.mjs": "a".repeat(64),
  "rosetta.wasm": "b".repeat(64),
  "rosetta.data": "c".repeat(64),
};
const manifest: EngineManifest = {
  id: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  verified: true,
  module: "rosetta.mjs",
  database: "rosetta.data",
  reason: "unit-test identity only",
  supportedProtocols: ["score", "relax", "fixed_backbone_design"],
  hashes,
};
let alice: PeerIdentity, bob: PeerIdentity;
let job: PeerJob, result: PeerResult;
const copy = <T>(value: T): T => structuredClone(value);
beforeAll(async () => {
  [alice, bob] = await Promise.all([
    generatePeerIdentity(),
    generatePeerIdentity(),
  ]);
  const now = Date.now();
  job = {
    id: crypto.randomUUID(),
    title: "Trp-cage",
    publisherId: alice.id,
    createdAt: now - 100,
    expiresAt: now + 60_000,
    engine: { id: ENGINE_ID, sourceSha: SOURCE_SHA, hashes },
    protocol: "relax",
    seed: 17,
    models: 2,
    input: { pdb, sha256: await peerSha256(pdb) },
  };
  result = {
    id: crypto.randomUUID(),
    jobId: job.id,
    inputSha256: job.input.sha256,
    engine: job.engine,
    completedAt: now,
    models: [0, 1].map((modelIndex) => ({
      modelIndex,
      seed: job.seed + modelIndex,
      protocol: job.protocol,
      pdb,
      sha256: job.input.sha256,
      energy: -48.1,
      elapsedMs: 1_000,
      history: [15.3, -40.7, -48.1],
    })),
  };
});

describe("signed peer envelope", () => {
  it("binds the prepared target to its retained original upload and policy", async () => {
    const original = "\uFEFF" + pdb;
    const prepared = prepareProteinPdb(original);
    const target = copy(job);
    target.input = {
      pdb: prepared.pdb,
      sha256: await peerSha256(prepared.pdb),
      original: {
        pdb: original,
        sha256: await peerSha256(original),
        preparationPolicy: prepared.report.policy,
      },
    };
    expect((await validatePeerJob(target, manifest)).input.original?.pdb).toBe(
      original,
    );
    target.input.original!.preparationPolicy = "pdb-coordinate-preparation-v1";
    expect((await validatePeerJob(target, manifest)).input.original?.pdb).toBe(
      original,
    );
    target.input.original!.sha256 = "0".repeat(64);
    await expect(validatePeerJob(target, manifest)).rejects.toThrow(
      /Original upload hash/,
    );
    target.input.original!.pdb = original + "\nREMARK changed";
    target.input.original!.sha256 = await peerSha256(
      target.input.original!.pdb,
    );
    await expect(validatePeerJob(target, manifest)).rejects.toThrow(
      /Prepared target/,
    );
  });
  it("generates distinct persistent-capable nonextractable identities with public fingerprints", async () => {
    expect(alice.id).toMatch(/^[a-f0-9]{64}$/);
    expect(alice.id).not.toBe(bob.id);
    expect(alice.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey("jwk", alice.privateKey),
    ).rejects.toThrow();
    const restored = structuredClone(alice);
    const message = await signPeerMessage(restored, {
      type: "hello",
      peerId: alice.id,
    });
    expect(await verifyPeerMessage(JSON.stringify(message), alice.id)).toEqual(
      message,
    );
    expect(publicIdentity(alice)).toEqual({
      id: alice.id,
      publicKey: alice.publicKey,
    });
    expect(
      await identityId({
        ...alice.publicKey,
        ext: true,
        key_ops: ["verify"],
        alg: "ES256",
      }),
    ).toBe(alice.id);
    expect(publicIdentity(alice)).not.toHaveProperty("privateKey");
  });
  it("canonicalizes object order but preserves array order and exact strings", async () => {
    expect(canonicalStringify({ b: [2, 1], a: { z: "x\n", a: 3 } })).toBe(
      '{"a":{"a":3,"z":"x\\n"},"b":[2,1]}',
    );
    expect(await hashPeerJob(job)).toBe(
      await peerSha256(canonicalStringify(job)),
    );
    for (const invalid of [NaN, Infinity, undefined, () => 1, new Date()])
      expect(() => canonicalStringify(invalid)).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalStringify(cycle)).toThrow("cycle");
  });
  it("detects payload, envelope and signature tampering and pins both sender and public key", async () => {
    const signed = await signPeerMessage(alice, { type: "job", job });
    const modified = copy(signed);
    if (modified.payload.type !== "job")
      throw new Error("Wrong fixture payload.");
    modified.payload.job.seed++;
    await expect(verifyPeerMessage(modified, alice.id)).rejects.toThrow(
      "signature",
    );
    await expect(
      verifyPeerMessage({ ...signed, id: crypto.randomUUID() }, alice.id),
    ).rejects.toThrow("signature");
    await expect(
      verifyPeerMessage({ ...signed, publicKey: bob.publicKey }, alice.id),
    ).rejects.toThrow("pinned");
    await expect(verifyPeerMessage(signed, bob.id)).rejects.toThrow("pinned");
    const signature =
      (signed.signature[0] === "A" ? "B" : "A") + signed.signature.slice(1);
    await expect(
      verifyPeerMessage({ ...signed, signature }, alice.id),
    ).rejects.toThrow("signature");
  });
  it("rejects private key material, unknown commands/fields and noncanonical signatures", async () => {
    const signed = await signPeerMessage(alice, {
      type: "hello",
      peerId: alice.id,
    });
    await expect(
      verifyPeerMessage(
        { ...signed, publicKey: { ...signed.publicKey, d: "secret" } },
        alice.id,
      ),
    ).rejects.toThrow();
    await expect(
      verifyPeerMessage({ ...signed, version: 2 }, alice.id),
    ).rejects.toThrow();
    await expect(
      verifyPeerMessage({ ...signed, executable: "url" }, alice.id),
    ).rejects.toThrow();
    await expect(
      verifyPeerMessage(
        { ...signed, payload: { type: "run_script", script: "bad" } },
        alice.id,
      ),
    ).rejects.toThrow();
    // A 64-byte P1363 signature has four unused base64 bits; aliases are rejected.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signed.signature.at(-1)!);
    const alias = signed.signature.slice(0, -1) + alphabet[last + 1];
    await expect(
      verifyPeerMessage({ ...signed, signature: alias }, alice.id),
    ).rejects.toThrow("encoding");
  });
  it("bounds message bytes before parsing and binds publisher/hello identities", async () => {
    await expect(
      verifyPeerMessage(" ".repeat(MAX_PEER_MESSAGE_BYTES + 1), alice.id),
    ).rejects.toThrow("64 MiB");
    await expect(
      signPeerMessage(alice, {
        type: "job",
        job: { ...job, publisherId: bob.id },
      }),
    ).rejects.toThrow("publisher");
    await expect(
      signPeerMessage(alice, { type: "hello", peerId: bob.id }),
    ).rejects.toThrow("Hello");
    await expect(
      signPeerMessage(
        { ...alice, id: bob.id },
        { type: "hello", peerId: bob.id },
      ),
    ).rejects.toThrow("fingerprint");
  });
  it("permits signed initial pairing without a pin but requires a pin for jobs", async () => {
    const signed = await signPeerMessage(alice, {
      type: "pairing",
      pairing: {
        kind: "offer",
        sessionId: crypto.randomUUID(),
        description: { type: "offer", sdp: "v=0\r\n" },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    });
    expect((await verifyPeerMessage(signed)).senderId).toBe(alice.id);
    await expect(
      verifyPeerMessage(await signPeerMessage(alice, { type: "job", job })),
    ).rejects.toThrow("pinned");
    if (signed.payload.type !== "pairing")
      throw new Error("Wrong fixture payload.");
    await expect(
      signPeerMessage(alice, {
        type: "pairing",
        pairing: {
          ...signed.payload.pairing,
          kind: "answer",
          description: { type: "answer", sdp: "v=0" },
        },
      }),
    ).rejects.toThrow();
  });
  it("signs bounded result, receipt and progress messages without treating them as scientifically validated", async () => {
    for (const payload of [
      { type: "result" as const, result },
      { type: "receipt" as const, jobId: job.id, resultId: result.id },
      {
        type: "progress" as const,
        jobId: job.id,
        state: "running",
        completed: 1,
        total: 2,
        elapsedMs: 500,
      },
    ]) {
      const signed = await signPeerMessage(bob, payload);
      expect((await verifyPeerMessage(signed, bob.id)).payload).toEqual(
        payload,
      );
    }
    await expect(
      signPeerMessage(bob, {
        type: "progress",
        jobId: job.id,
        state: "running",
        completed: 3,
        total: 2,
        elapsedMs: 500,
      }),
    ).rejects.toThrow();
  });
});

describe("scientific input and output admission", () => {
  it("requires exact input bytes, admitted coordinates and a verified matching local build", async () => {
    expect(await validatePeerJob(job, manifest)).toEqual(job);
    await expect(
      validatePeerJob(
        { ...job, input: { ...job.input, pdb: pdb + "\n" } },
        manifest,
      ),
    ).rejects.toThrow("input hash");
    await expect(
      validatePeerJob(job, { ...manifest, verified: false }),
    ).rejects.toThrow("unverified");
    await expect(
      validatePeerJob(job, {
        ...manifest,
        hashes: { ...hashes, "rosetta.data": "d".repeat(64) },
      }),
    ).rejects.toThrow("hash");
    await expect(
      validatePeerJob(job, { ...manifest, supportedProtocols: ["score"] }),
    ).rejects.toThrow("protocol");
    const badPdb = "HETATM" + pdb.slice(6);
    await expect(
      validatePeerJob(
        { ...job, input: { pdb: badPdb, sha256: await peerSha256(badPdb) } },
        manifest,
      ),
    ).rejects.toThrow("Ligands");
  });
  it("rejects stale/future, unbounded and executable job options", async () => {
    await expect(
      validatePeerJob(job, manifest, { now: job.expiresAt }),
    ).rejects.toThrow("expired");
    await expect(
      validatePeerJob(
        {
          ...job,
          createdAt: Date.now() + 600_000,
          expiresAt: Date.now() + 700_000,
        },
        manifest,
      ),
    ).rejects.toThrow("future");
    await expect(
      validatePeerJob({ ...job, models: 5 }, manifest),
    ).rejects.toThrow();
    await expect(
      validatePeerJob({ ...job, seed: 2_000_000_000 }, manifest),
    ).rejects.toThrow("seeds");
    await expect(
      validatePeerJob({ ...job, protocol: "arbitrary_script" }, manifest),
    ).rejects.toThrow();
    await expect(
      validatePeerJob({ ...job, flags: ["-script", "remote.xml"] }, manifest),
    ).rejects.toThrow();
  });
  it("accepts complete exact model identities and catches altered output bytes", async () => {
    expect(await validatePeerResult(result, job)).toEqual(result);
    const altered = copy(result);
    altered.models[0].pdb += "\n";
    await expect(validatePeerResult(altered, job)).rejects.toThrow(
      "output hash",
    );
    await expect(
      validatePeerResult({ ...result, inputSha256: "f".repeat(64) }, job),
    ).rejects.toThrow("expected job");
    await expect(
      validatePeerResult(
        {
          ...result,
          engine: {
            ...result.engine,
            hashes: { ...hashes, "rosetta.wasm": "d".repeat(64) },
          },
        },
        job,
      ),
    ).rejects.toThrow("engine");
  });
  it("rejects missing/duplicate models, wrong seeds/protocols and invalid numeric reports", async () => {
    await expect(
      validatePeerResult({ ...result, models: result.models.slice(0, 1) }, job),
    ).rejects.toThrow("every requested model");
    for (const change of [
      { modelIndex: 0 },
      { seed: 17 },
      { protocol: "score" },
      { modelIndex: 3 },
    ]) {
      const invalid = copy(result);
      Object.assign(invalid.models[1], change);
      await expect(validatePeerResult(invalid, job)).rejects.toThrow(
        "model index",
      );
    }
    for (const change of [
      { energy: Infinity },
      { elapsedMs: -1 },
      { history: [NaN] },
      { history: Array(2_001).fill(1) },
    ]) {
      const invalid = copy(result);
      Object.assign(invalid.models[0], change);
      await expect(validatePeerResult(invalid, job)).rejects.toThrow();
    }
  });
  it("preserves chain/residue identities and permits sequence changes only for admitted design protocols", async () => {
    const mutation = pdb
      .split("\n")
      .map((line) =>
        line.startsWith("ATOM  ") && line.slice(17, 20) === "ASN"
          ? line.slice(0, 17) + "GLN" + line.slice(20)
          : line,
      )
      .join("\n");
    const mutated = copy(result);
    for (const model of mutated.models) {
      model.pdb = mutation;
      model.sha256 = await peerSha256(mutation);
    }
    await expect(validatePeerResult(mutated, job)).rejects.toThrow("sequence");
    const designJob: PeerJob = { ...job, protocol: "fixed_backbone_design" };
    for (const model of mutated.models)
      model.protocol = "fixed_backbone_design";
    expect(await validatePeerResult(mutated, designJob)).toEqual(mutated);
    const renumbered = copy(result);
    renumbered.models[0].pdb = pdb
      .split("\n")
      .map((line) =>
        line.startsWith("ATOM  ")
          ? line.slice(0, 21) + "B" + line.slice(22)
          : line,
      )
      .join("\n");
    renumbered.models[0].sha256 = await peerSha256(renumbered.models[0].pdb);
    await expect(validatePeerResult(renumbered, job)).rejects.toThrow(
      "residue identities",
    );
  });
});

import {
  ENGINE_ID,
  SOURCE_SHA,
  protocolDefinition,
  validatePdb,
  type Protocol,
  type Task,
} from "@rosettatab/shared";

export async function bundledTask(protocol: Protocol): Promise<Task> {
  const response = await fetch("./fixtures/1l2y.pdb");
  if (!response.ok)
    throw new Error(
      "The packaged 1L2Y structure is unavailable. Reload the extension.",
    );
  const pdb = await response.text();
  validatePdb(pdb);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(pdb),
  );
  const inputHash = Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    id: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    title: `Trp-cage · ${protocolDefinition(protocol).label}`,
    protocol,
    inputHash,
    pdb,
    seed: (crypto.getRandomValues(new Uint32Array(1))[0] % 2_000_000_000) + 1,
    modelIndex: 0,
    engineId: ENGINE_ID,
    sourceSha: SOURCE_SHA,
    state: "leased",
    attemptToken: crypto.randomUUID(),
    clientId: null,
    leaseUntil: null,
    result: null,
    rejection: null,
  };
}

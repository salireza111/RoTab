import {
  ENGINE_HASHES,
  ENGINE_ID,
  PROTOCOL_IDS,
  SOURCE_SHA,
  type Protocol,
} from "./types.js";

export function validateRequest(
  protocol: Protocol,
  seed: number,
  dutyCycle: number,
) {
  if (!(PROTOCOL_IDS as readonly string[]).includes(protocol))
    throw new Error(`Unsupported coordinate protocol: ${protocol}`);
  if (!Number.isInteger(seed) || seed < 1 || seed > 2_000_000_000)
    throw new RangeError("Seed must be an integer from 1 to 2,000,000,000.");
  if (!Number.isInteger(dutyCycle) || dutyCycle < 10 || dutyCycle > 75)
    throw new RangeError("dutyCycle must be an integer from 10 to 75.");
}
export function validateManifest(value: unknown) {
  const m = value as Record<string, any> | null;
  if (
    !m ||
    m.verified !== true ||
    m.id !== ENGINE_ID ||
    m.sourceSha !== SOURCE_SHA ||
    m.module !== "rosetta.mjs" ||
    m.database !== "rosetta.data" ||
    !Array.isArray(m.supportedProtocols) ||
    !PROTOCOL_IDS.every((p) => m.supportedProtocols.includes(p)) ||
    Object.entries(ENGINE_HASHES).some(
      ([name, hash]) => m.hashes?.[name] !== hash,
    )
  )
    throw new Error(
      "Engine manifest does not match this SDK's measured Rosetta build.",
    );
}
export async function sha256(bytes: BufferSource): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

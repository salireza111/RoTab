/** Independent local scorer for scientific acceptance checks. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePdb } from "@rosettatab/shared";

export const nativeAcceptanceTimeoutMs = Number(
  process.env.ROSETTATAB_NATIVE_ACCEPTANCE_MS ?? 180_000,
);
if (!Number.isInteger(nativeAcceptanceTimeoutMs) || nativeAcceptanceTimeoutMs < 60_000 || nativeAcceptanceTimeoutMs > 300_000)
  throw new Error("Native acceptance budget must be between one and five minutes.");

export async function nativeValidator() {
  if (process.env.ROSETTA_VALIDATION_URL)
    throw new Error("Native acceptance requires the independent local binary.");
  const executable = process.env.ROSETTA_VALIDATOR;
  const database = process.env.ROSETTA_DATABASE;
  if (!executable || !database) return null;
  await access(executable);
  await access(database);
  return async (pdb: string): Promise<number> => {
    validatePdb(pdb);
    const folder = await mkdtemp(join(tmpdir(), "rotab-native-acceptance-"));
    const started = performance.now();
    try {
      const input = join(folder, "input.pdb");
      await writeFile(input, pdb, { mode: 0o600 });
      const { stdout } = await promisify(execFile)(resolve(executable), [
        "--input", input, "--database", resolve(database), "--protocol", "score", "--seed", "1",
      ], { timeout: nativeAcceptanceTimeoutMs, maxBuffer: 2_000_000, cwd: folder });
      const line = stdout.split("\n").findLast(value => value.startsWith("ROSETTATAB_RESULT "));
      if (!line) throw new Error("Independent native scorer returned no result.");
      const result = JSON.parse(line.slice(18));
      if (result.error || !Number.isFinite(result.energy))
        throw new Error("Independent native scorer returned an invalid energy.");
      return result.energy;
    } catch (error: any) {
      const code = typeof error.code === "string" ? error.code : "unknown";
      const signal = typeof error.signal === "string" ? error.signal : "none";
      throw new Error(`Independent native scoring failed: code=${code}, signal=${signal}, killed=${error.killed === true}, elapsedMs=${Math.round(performance.now() - started)}. Input and process output omitted.`);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };
}

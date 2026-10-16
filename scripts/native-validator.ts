import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePdb, SOURCE_SHA } from "@rosettatab/shared";
export type Validator = (pdb: string) => Promise<number>;
export class RetryableValidation extends Error {}
export async function nativeValidator(): Promise<Validator | null> {
  const remote = process.env.ROSETTA_VALIDATION_URL;
  if (remote) {
    const health = (await fetch(remote + "/health", {
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json())) as any;
    if (!health.scientificValidation || health.sourceSha !== SOURCE_SHA)
      throw new Error(
        "Native validation service has an incompatible source version.",
      );
    return async (pdb) => {
      validatePdb(pdb);
      const response = await fetch(remote + "/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdb }),
        signal: AbortSignal.timeout(65_000),
      }).catch(() => {
        throw new RetryableValidation(
          "Native validator is unreachable. Keep the result and retry.",
        );
      });
      const data = (await response.json()) as any;
      if (response.status === 429 || response.status >= 500)
        throw new RetryableValidation(
          data.error ?? "Native validator is temporarily unavailable.",
        );
      if (
        !response.ok ||
        data.sourceSha !== SOURCE_SHA ||
        !Number.isFinite(data.energy)
      )
        throw new Error(data.error ?? "Native validation failed.");
      return data.energy;
    };
  }
  const executable = process.env.ROSETTA_VALIDATOR;
  const database = process.env.ROSETTA_DATABASE;
  if (!executable || !database) return null;
  await access(executable);
  await access(database);
  return async (pdb) => {
    validatePdb(pdb);
    const dir = await mkdtemp(join(tmpdir(), "rosettatab-validate-"));
    try {
      const path = join(dir, "input.pdb");
      await writeFile(path, pdb, { mode: 0o600 });
      const { stdout } = await promisify(execFile)(
        resolve(executable),
        [
          "--input",
          path,
          "--database",
          resolve(database),
          "--protocol",
          "score",
          "--seed",
          "1",
        ],
        { timeout: 60_000, maxBuffer: 2_000_000, cwd: dir },
      ).catch((error) => {
        if (
          error.killed ||
          error.signal === "SIGKILL" ||
          error.code === "ENOENT" ||
          error.code === "EAGAIN"
        )
          throw new RetryableValidation(
            "Native validator could not finish within its resource budget. Retry later.",
          );
        throw error;
      });
      const line = stdout
        .split("\n")
        .findLast((l) => l.startsWith("ROSETTATAB_RESULT "));
      if (!line) throw new Error("Native scorer did not return a result.");
      const data = JSON.parse(line.slice(18));
      if (!Number.isFinite(data.energy))
        throw new Error("Native scorer returned an invalid energy.");
      return data.energy;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

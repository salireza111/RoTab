import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed score adapter using a caller-owned reusable client. */
export function score(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("score", pdb, options);
}

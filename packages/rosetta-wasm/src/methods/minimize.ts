import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed minimize adapter using a caller-owned reusable client. */
export function minimize(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("minimize", pdb, options);
}

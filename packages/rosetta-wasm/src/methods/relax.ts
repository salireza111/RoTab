import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed relax adapter using a caller-owned reusable client. */
export function relax(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("relax", pdb, options);
}

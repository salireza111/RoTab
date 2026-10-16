import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed cartesian_relax adapter using a caller-owned reusable client. */
export function cartesianRelax(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("cartesian_relax", pdb, options);
}

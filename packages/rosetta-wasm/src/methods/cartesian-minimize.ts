import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed cartesian_minimize adapter using a caller-owned reusable client. */
export function cartesianMinimize(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("cartesian_minimize", pdb, options);
}

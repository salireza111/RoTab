import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed fastdesign adapter using a caller-owned reusable client. */
export function fastDesign(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("fastdesign", pdb, options);
}

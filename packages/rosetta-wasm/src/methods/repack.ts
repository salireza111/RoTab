import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed repack adapter using a caller-owned reusable client. */
export function repack(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("repack", pdb, options);
}

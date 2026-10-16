import type { ProtocolRunner, Result, RunOptions } from "../types.js";
/** Run the fixed fixed_backbone_design adapter using a caller-owned reusable client. */
export function fixedBackboneDesign(
  client: ProtocolRunner,
  pdb: string,
  options?: RunOptions,
): Promise<Result> {
  return client.run("fixed_backbone_design", pdb, options);
}

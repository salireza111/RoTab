import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Current extension resources and previously measured private pilot builds. */
export function extensionEngineMetadataPath(extension: string): string {
  const current = resolve(extension, "engine/engine-metadata.json");
  return existsSync(current)
    ? current
    : resolve(extension, "engine/manifest.json");
}

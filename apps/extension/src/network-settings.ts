import { z } from "zod";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
export const networkSettingsSchema = z
  .object({
    enabled: z.boolean(),
    automatic: z.boolean(),
    room: z.string().trim().min(1).max(80),
    relays: z
      .array(
        z
          .string()
          .max(250)
          .refine((value) => {
            try {
              const u = new URL(value);
              return (
                u.protocol === "wss:" &&
                !u.username &&
                !u.password &&
                !u.search &&
                !u.hash
              );
            } catch {
              return false;
            }
          }, "Use a secure wss:// relay URL without credentials or query parameters."),
      )
      .min(1)
      .max(3),
    stun: z
      .string()
      .max(200)
      .refine((v) => !v || /^stuns?:[^\s@]+$/.test(v)),
    turn: z
      .string()
      .max(250)
      .refine((v) => !v || /^turns?:[^\s@]+$/.test(v))
      .optional(),
    turnUsername: z.string().max(200).optional(),
    turnCredential: z.string().max(500).optional(),
    /** Remember that a bundled default was considered, including a later opt-out. */
    bundledTurnApplied: z.boolean().optional(),
  })
  .strict()
  .refine(
    (s) => !s.turn || (!!s.turnUsername && !!s.turnCredential),
    "TURN requires a username and credential.",
  );
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;
export const bundledTurnSchema = z
  .object({
    stun: z
      .string()
      .max(200)
      .regex(/^stuns?:[^\s@]+$/),
    turn: z
      .string()
      .max(250)
      .regex(/^turns?:[^\s@]+$/),
    turnUsername: z.string().min(1).max(200),
    turnCredential: z.string().min(1).max(500),
  })
  .strict();
export type BundledTurn = z.infer<typeof bundledTurnSchema>;
declare const __ROTAB_BUNDLED_TURN__: BundledTurn | null;
export const bundledTurn =
  typeof __ROTAB_BUNDLED_TURN__ === "undefined" || !__ROTAB_BUNDLED_TURN__
    ? undefined
    : bundledTurnSchema.parse(__ROTAB_BUNDLED_TURN__);

const baseNetworkSettings: NetworkSettings = {
  enabled: true,
  automatic: false,
  room: "rotab-pilot-v3",
  relays: DEFAULT_RELAYS,
  stun: "stun:stun.l.google.com:19302",
};
/** Apply the pilot fallback once; preserve custom TURN and explicit network/compute choices. */
export function resolveNetworkSettings(
  raw: unknown,
  fallback: BundledTurn | undefined = bundledTurn,
): NetworkSettings {
  const settings =
    raw === undefined
      ? structuredClone(baseNetworkSettings)
      : networkSettingsSchema.parse(raw);
  if (fallback && !settings.bundledTurnApplied) {
    if (!settings.turn) Object.assign(settings, fallback);
    settings.bundledTurnApplied = true;
  }
  if (settings.room === "rotab-pilot-v2")
    settings.room = baseNetworkSettings.room;
  return settings;
}
export const defaultNetworkSettings = resolveNetworkSettings(undefined);

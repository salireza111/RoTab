import { z } from "zod";

// Connectivity metadata only. Scientific payloads remain on the WebRTC channel.
export const iceCandidateSchema = z
  .object({
    candidate: z.string().min(1).max(2048),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();
export type IceCandidate = z.infer<typeof iceCandidateSchema>;
export const connectivityUpdateSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ice"),
      sessionId: z.uuid(),
      candidates: z.array(iceCandidateSchema).min(1).max(8),
    })
    .strict(),
  z.object({ type: z.literal("reconnect") }).strict(),
]);
export type ConnectivityUpdate = z.infer<typeof connectivityUpdateSchema>;

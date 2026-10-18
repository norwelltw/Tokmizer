import { z } from "zod";
import { FilterDef } from "../engine/schema";

export const ReqFilter = z.object({
  id: z.string().min(1).max(64),
  op: z.literal("filter"),
  cmd: z.string().min(1).max(2048),
  plan: z.enum(["trial", "smart", "pro"]),
  allowed: z.array(z.string().min(1).max(64)).max(512).optional(),
  installId: z.string().min(1).max(64).optional()
});

export const ReqPing = z.object({
  id: z.string().min(1).max(64),
  op: z.literal("ping")
});

export const ReqShutdown = z.object({
  id: z.string().min(1).max(64),
  op: z.literal("shutdown"),
  installId: z.string().min(1).max(64)
});

export const ReqReload = z.object({
  id: z.string().min(1).max(64),
  op: z.literal("reload"),
  installId: z.string().min(1).max(64).optional()
});

export const ReqMessage = z.discriminatedUnion("op", [ReqFilter, ReqPing, ReqShutdown, ReqReload]);

export type ReqMessage = z.infer<typeof ReqMessage>;

export const ResOk = z.object({
  id: z.string(),
  ok: z.literal(true),
  data: z.unknown()
});

export const ResErr = z.object({
  id: z.string(),
  ok: z.literal(false),
  err: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional()
});

export type ResMessage = z.infer<typeof ResOk> | z.infer<typeof ResErr>;

export const FilterResData = z.object({
  filter: FilterDef.nullable(),
  cacheHit: z.boolean().optional()
});

export const FRAME_DELIM = "\n";
export const MAX_FRAME_BYTES = 64 * 1024;

export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + FRAME_DELIM;
}

export function* decodeFrames(buf: string): Generator<string> {
  let start = 0;
  for (;;) {
    const idx = buf.indexOf(FRAME_DELIM, start);
    if (idx < 0) return;
    yield buf.slice(start, idx);
    start = idx + 1;
  }
}

export function nextRequestId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

import { describe, expect, it } from "vitest";
import {
  ReqMessage,
  encodeFrame,
  decodeFrames,
  nextRequestId,
  MAX_FRAME_BYTES
} from "../daemon/protocol";

describe("daemon protocol", () => {
  it("encodeFrame appends newline", () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n');
  });

  it("decodeFrames yields one per newline", () => {
    const seen: string[] = [];
    for (const f of decodeFrames("a\nb\nc\n")) seen.push(f);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("decodeFrames stops at trailing partial frame", () => {
    const seen: string[] = [];
    for (const f of decodeFrames("a\nb")) seen.push(f);
    expect(seen).toEqual(["a"]);
  });

  it("ReqMessage parses filter request", () => {
    const r = ReqMessage.parse({
      id: "x",
      op: "filter",
      cmd: "git status",
      plan: "smart"
    });
    expect(r.op).toBe("filter");
  });

  it("ReqMessage parses ping", () => {
    const r = ReqMessage.parse({ id: "x", op: "ping" });
    expect(r.op).toBe("ping");
  });

  it("ReqMessage rejects unknown op", () => {
    expect(() =>
      ReqMessage.parse({ id: "x", op: "evil", cmd: "rm -rf", plan: "smart" })
    ).toThrow();
  });

  it("ReqMessage rejects cmd over 2048 chars", () => {
    expect(() =>
      ReqMessage.parse({
        id: "x",
        op: "filter",
        cmd: "x".repeat(2049),
        plan: "smart"
      })
    ).toThrow();
  });

  it("ReqMessage rejects bad plan", () => {
    expect(() =>
      ReqMessage.parse({ id: "x", op: "filter", cmd: "ls", plan: "platinum" })
    ).toThrow();
  });

  it("nextRequestId is unique per call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextRequestId()));
    expect(ids.size).toBe(50);
  });

  it("MAX_FRAME_BYTES exposed for client/server bounds", () => {
    expect(MAX_FRAME_BYTES).toBeGreaterThanOrEqual(64 * 1024);
  });
});

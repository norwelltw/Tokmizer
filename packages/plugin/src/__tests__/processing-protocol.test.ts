import { describe, expect, it } from "vitest";
import { FrameReader, encodeProcessingFrame, decodeCapturedFrame, encodeCapturedFrame, MAX_CAPTURE_BYTES } from "../exec/processing-protocol";

describe("bounded processing frames", () => {
  it("handles headers and UTF-8 payloads fragmented at every byte", () => {
    const received: Buffer[] = [];
    const reader = new FrameReader(() => 100, (frame) => received.push(frame));
    const expected = Buffer.from("résultat 😀\n");
    for (const byte of encodeProcessingFrame(expected)) reader.push(Buffer.from([byte]));
    expect(received).toEqual([expected]);
  });

  it("handles adjacent frames without retaining a previous frame", () => {
    const received: string[] = [];
    const reader = new FrameReader(() => 100, (frame) => received.push(frame.toString()));
    reader.push(Buffer.concat([encodeProcessingFrame(Buffer.from("first")), encodeProcessingFrame(Buffer.from("second"))]));
    expect(received).toEqual(["first", "second"]);
  });

  it("rejects an oversized declaration before accepting its body", () => {
    const received: Buffer[] = [];
    const reader = new FrameReader(() => 100, (frame) => received.push(frame));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(101);
    expect(() => reader.push(header)).toThrow("frame limit");
    expect(received).toEqual([]);
  });

  it("checks the next phase limit even when frames arrive together", () => {
    let maximum = 100;
    const reader = new FrameReader(() => maximum, () => { maximum = 2; });
    const bytes = Buffer.concat([encodeProcessingFrame(Buffer.from("accepted")), encodeProcessingFrame(Buffer.from("too big"))]);
    expect(() => reader.push(bytes)).toThrow("frame limit");
  });

  it("checks aggregate admission before allocating the announced frame", () => {
    const reader = new FrameReader(() => 100, () => {}, () => { throw new Error("busy"); });
    expect(() => reader.push(encodeProcessingFrame(Buffer.from("command")))).toThrow("busy");
  });

  it("round trips both streams, exit status and truncation independently", () => {
    const input = { stdout: "hello é😀", stderr: "error\n", exitCode: 137, truncated: true, stderrTruncated: false };
    expect(decodeCapturedFrame(encodeCapturedFrame(input))).toEqual(input);
  });

  it("rejects inconsistent lengths, unsupported flags and invalid exit status", () => {
    const valid = encodeCapturedFrame({ stdout: "abc", stderr: "def", exitCode: 0, truncated: false, stderrTruncated: false });
    expect(() => decodeCapturedFrame(valid.subarray(0, valid.length - 1))).toThrow();
    const flags = Buffer.from(valid);
    flags.writeUInt32BE(4, 4);
    expect(() => decodeCapturedFrame(flags)).toThrow();
    const exit = Buffer.from(valid);
    exit.writeUInt32BE(0xffffffff, 0);
    expect(() => decodeCapturedFrame(exit)).toThrow();
    const oversized = Buffer.from(valid);
    oversized.writeUInt32BE(MAX_CAPTURE_BYTES + 1, 8);
    expect(() => decodeCapturedFrame(oversized)).toThrow();
  });

  it("does not deliver an unfinished frame and releases it on close", () => {
    const received: Buffer[] = [];
    const reader = new FrameReader(() => 100, (frame) => received.push(frame));
    reader.push(encodeProcessingFrame(Buffer.from("unfinished")).subarray(0, 8));
    reader.close();
    expect(() => reader.push(Buffer.from("rest"))).toThrow("closed");
    expect(received).toEqual([]);
  });
});

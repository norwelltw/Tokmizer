import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { exitOnBrokenPipe } from "../epipe";

describe("exitOnBrokenPipe", () => {
  it("exits quietly with 141 when the reader closed the pipe", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitOnBrokenPipe(stream, exit);
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exit).toHaveBeenCalledWith(141);
  });

  it("rethrows any other stream error", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    exitOnBrokenPipe(stream, exit);
    expect(() => stream.emit("error", Object.assign(new Error("boom"), { code: "EIO" }))).toThrow("boom");
    expect(exit).not.toHaveBeenCalled();
  });
});

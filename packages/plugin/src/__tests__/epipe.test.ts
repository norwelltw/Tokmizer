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

  it("does not throw on other stream errors and reports once", () => {
    const stream = new EventEmitter();
    const exit = vi.fn();
    const warn = vi.fn();
    exitOnBrokenPipe(stream, exit, warn);
    expect(() => stream.emit("error", Object.assign(new Error("boom"), { code: "EIO" }))).not.toThrow();
    expect(() => stream.emit("error", Object.assign(new Error("boom"), { code: "EIO" }))).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

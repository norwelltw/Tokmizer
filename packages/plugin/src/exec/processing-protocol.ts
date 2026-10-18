export const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
export const MAX_CAPTURE_FRAME_BYTES = 16 + 2 * MAX_CAPTURE_BYTES;
export const MAX_PREPARE_BYTES = 64 * 1024;

export class FrameReader {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | null = null;
  private bodyBytes = 0;
  private closed = false;

  constructor(
    private limit: () => number,
    private receive: (frame: Buffer) => void,
    private reserve: (bytes: number) => void = () => {}
  ) {}

  push(chunk: Buffer): void {
    if (this.closed) throw new Error("reader closed");
    let offset = 0;
    try {
      while (offset < chunk.length && !this.closed) {
        if (!this.body) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes !== 4) continue;
          const size = this.header.readUInt32BE(0);
          if (size > this.limit()) throw new Error("frame limit exceeded");
          this.reserve(size);
          this.body = Buffer.allocUnsafe(size);
          this.bodyBytes = 0;
        }
        const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
        chunk.copy(this.body, this.bodyBytes, offset, offset + count);
        this.bodyBytes += count;
        offset += count;
        if (this.bodyBytes === this.body.length) {
          const frame = this.body;
          this.body = null;
          this.headerBytes = 0;
          this.bodyBytes = 0;
          this.receive(frame);
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.body = null;
    this.headerBytes = 0;
    this.bodyBytes = 0;
  }
}

export function encodeProcessingFrame(body: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export type CapturedStreams = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  stderrTruncated: boolean;
};

export function encodeCapturedFrame(input: CapturedStreams): Buffer {
  const stdout = Buffer.from(input.stdout);
  const stderr = Buffer.from(input.stderr);
  if (stdout.length > MAX_CAPTURE_BYTES || stderr.length > MAX_CAPTURE_BYTES ||
    !Number.isInteger(input.exitCode) || input.exitCode < 0 || input.exitCode > 255) {
    throw new Error("invalid captured output");
  }
  const header = Buffer.allocUnsafe(16);
  header.writeUInt32BE(input.exitCode, 0);
  header.writeUInt32BE(Number(input.truncated) | (Number(input.stderrTruncated) << 1), 4);
  header.writeUInt32BE(stdout.length, 8);
  header.writeUInt32BE(stderr.length, 12);
  return Buffer.concat([header, stdout, stderr]);
}

export function decodeCapturedFrame(frame: Buffer): CapturedStreams {
  if (frame.length < 16) throw new Error("incomplete captured header");
  const exitCode = frame.readUInt32BE(0);
  const flags = frame.readUInt32BE(4);
  const stdoutBytes = frame.readUInt32BE(8);
  const stderrBytes = frame.readUInt32BE(12);
  if (exitCode > 255 || flags > 3 || stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES ||
    frame.length !== 16 + stdoutBytes + stderrBytes) {
    throw new Error("invalid captured output");
  }
  return {
    stdout: frame.subarray(16, 16 + stdoutBytes).toString("utf8"),
    stderr: frame.subarray(16 + stdoutBytes).toString("utf8"),
    exitCode,
    truncated: (flags & 1) !== 0,
    stderrTruncated: (flags & 2) !== 0
  };
}

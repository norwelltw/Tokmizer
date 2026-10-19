type ErrorSource = { on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown };

/**
 * Stdout error policy:
 * - EPIPE (reader closed the pipe): exit quietly with 141 (128 + SIGPIPE).
 * - Any other stdout error (EIO, ENOSPC, ...): never throw. Report once on stderr and
 *   swallow it so the process still ends through its normal path with the wrapped
 *   command's own exit code instead of crashing with a stack trace.
 */
export function exitOnBrokenPipe(
  stream: ErrorSource = process.stdout,
  exit: (code: number) => void = (code) => process.exit(code),
  warn: (message: string) => void = (message) => {
    try {
      process.stderr.write(message);
    } catch {}
  }
): void {
  let reported = false;
  stream.on("error", (err) => {
    if (err.code === "EPIPE") {
      exit(141);
      return;
    }
    if (!reported) {
      reported = true;
      warn(`tkr: stdout write failed (${err.code ?? err.message}); output dropped\n`);
    }
  });
}

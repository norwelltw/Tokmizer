type ErrorSource = { on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown };

export function exitOnBrokenPipe(
  stream: ErrorSource = process.stdout,
  exit: (code: number) => void = (code) => process.exit(code)
): void {
  stream.on("error", (err) => {
    if (err.code === "EPIPE") {
      exit(141);
      return;
    }
    throw err;
  });
}

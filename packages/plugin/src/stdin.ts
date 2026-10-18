export function readStdin(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stdin = process.stdin;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.pause();
      stdin.unref?.();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.on("data", onData).once("end", finish).once("error", finish);
    stdin.resume();
  });
}

export async function drainStdin(timeoutMs = 2000): Promise<void> {
  if (process.stdin.isTTY) return;
  await readStdin(timeoutMs);
}

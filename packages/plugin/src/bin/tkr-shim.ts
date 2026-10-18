#!/usr/bin/env node
import { parseShimInvocation, runShim } from "../shim/runner";
import { resolveShimJsPath } from "../shim/install";
import { healIfStale } from "../shim/heal";
import { exitOnBrokenPipe } from "../epipe";

exitOnBrokenPipe();

const invocation = parseShimInvocation(process.argv.slice(2));

if (invocation.cmdName) healIfStale(resolveShimJsPath(), invocation.cmdName).catch(() => {});

runShim(invocation)
  .then((r) => {
    process.exitCode = r.exitCode;
  })
  .catch((err) => {
    process.stderr.write(`tkr-shim: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });

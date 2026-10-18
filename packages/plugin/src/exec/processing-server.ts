import { timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import { z } from "zod";
import { maxBundleAgeMs, type DaemonRuntime } from "../daemon/runtime";
import { tokmizerHome } from "../paths";
import { yoloEnabled } from "../yolo-mode";
import { kickBackgroundEnroll, processCapturedOutput } from "./wrapper";
import { buildPreToolUseOutput, claudeLaunchArgs, execInvocation, type PreToolUsePayload } from "../hooks-host/pre-tool-rewrite";
import { postToolUseResponse, type PostToolUsePayload } from "../hooks-host/post-tool-process";
import { routePreToolUse } from "../hooks-host/hook-router";
import { recordUsageSync } from "../usage";
import { KNOWN_HOSTS, type Host } from "../host-detect";
import { FrameReader, encodeProcessingFrame, decodeCapturedFrame, MAX_CAPTURE_BYTES, MAX_CAPTURE_FRAME_BYTES, MAX_PREPARE_BYTES } from "./processing-protocol";
import { failOpenActive } from "../shim/sh";

const HOST_ENV = {
  "claude-code": "CLAUDECODE",
  codex: "CODEX_CLI",
  cursor: "CURSOR_VERSION",
  cline: "CLINE_VERSION",
  aider: "AIDER_VERSION",
  "gemini-cli": "GEMINI_CLI_VERSION",
  windsurf: "WINDSURF_VERSION",
  copilot: "GITHUB_COPILOT_VERSION",
  "qwen-code": "QWEN_CODE",
  crush: "CRUSH",
  droid: "",
  trae: "",
  junie: "",
  zcode: "",
  grok: "",
  kilo: "",
  shell: ""
} as const;

const Prepare = z.object({
  protocol: z.literal(2),
  version: z.string().min(1).max(64),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  home: z.string().min(1).max(4096),
  argv: z.array(z.string().max(32768).refine((value) => !value.includes("\0"))).min(1).max(4096),
  host: z.enum(KNOWN_HOSTS as [Host, ...Host[]]),
  sessionId: z.string().max(256).optional(),
  restoreDisabled: z.boolean(),
  restoreMaxBytes: z.number().int().positive().max(MAX_CAPTURE_BYTES).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000)
}).strict();

const PrepareHook = z.object({
  kind: z.literal("pre-tool-use"),
  protocol: z.literal(2),
  version: z.string().min(1).max(64),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  home: z.string().min(1).max(4096),
  host: z.enum(["claude-code", "codex"]),
  payload: z.record(z.string(), z.unknown()),
  claudeProjectDir: z.string().min(1).max(4096).optional(),
  claudeConfigDir: z.string().min(1).max(4096).optional(),
  path: z.string().min(1).max(32768).optional(),
  claudePid: z.string().regex(/^[1-9]\d{0,9}$/).optional()
}).strict();

const PreparePostHook = z.object({
  kind: z.literal("post-tool-use"),
  protocol: z.literal(2),
  version: z.string().min(1).max(64),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  home: z.string().min(1).max(4096),
  host: z.enum(["claude-code"])
}).strict();

function runtimeValid(runtime: DaemonRuntime | null): runtime is DaemonRuntime {
  if (!runtime) return false;
  const age = Date.now() - runtime.signedAt;
  return age >= 0 && age <= maxBundleAgeMs();
}

export async function startProcessingServer(opts: {
  path: string;
  token: string;
  version: string;
  getRuntime: () => DaemonRuntime | null;
  maxConnections?: number;
  maxBufferedBytes?: number;
  prepareTimeoutMs?: number;
  processingTimeoutMs?: number;
  onActivity?: () => void;
}): Promise<{ close: () => Promise<void>; activeConnections: () => number }> {
  if (!/^[0-9a-f]{64}$/.test(opts.token)) throw new Error("invalid processing authentication");
  const windows = process.platform === "win32";
  if (windows) {
    if (!/^\\\\\.\\pipe\\tokmizer-[A-Za-z0-9._-]+$/.test(opts.path)) throw new Error("unsafe processing pipe");
  } else {
    const directory = lstatSync(dirname(opts.path));
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
      throw new Error("unsafe processing directory");
    }
  }
  const home = realpathSync(tokmizerHome());
  const token = Buffer.from(opts.token, "hex");
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  let buffered = 0;
  let closing = false;
  const maxConnections = opts.maxConnections ?? 4;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 48 * 1024 * 1024;
  const server = createServer((socket) => {
    if (closing || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let phase: "prepare" | "capture" | "hook-payload" | "processing" | "delivery" | "accounting" | "closed" = "prepare";
    let request: z.infer<typeof Prepare> | null = null;
    let yolo = false;
    let reserved = 0;
    let processing = false;
    let account: (() => Promise<void>) | undefined;
    let deadline: NodeJS.Timeout;
    const release = (): void => {
      buffered -= reserved;
      reserved = 0;
    };
    const stop = (): void => {
      clearTimeout(deadline);
      reader.close();
      if (!processing) release();
      phase = "closed";
      socket.destroy();
    };
    const setDeadline = (ms: number): void => {
      clearTimeout(deadline);
      deadline = setTimeout(stop, ms);
      deadline.unref();
    };
    const replyJson = (data: unknown): void => {
      socket.write(encodeProcessingFrame(Buffer.from(JSON.stringify(data))));
    };
    const reader = new FrameReader(
      () => phase === "prepare" ? MAX_PREPARE_BYTES : phase === "capture" || phase === "hook-payload" ? MAX_CAPTURE_FRAME_BYTES : phase === "delivery" ? 1 : -1,
      (frame) => {
        if (phase === "delivery") {
          if (frame.length !== 1 || frame[0] !== 1) throw new Error("invalid delivery receipt");
          phase = "accounting";
          opts.onActivity?.();
          processing = true;
          const confirmation = (account?.() ?? Promise.resolve()).then(() => {
            if (!socket.destroyed) socket.end(encodeProcessingFrame(Buffer.from([1])));
          }).catch(() => stop()).finally(() => {
            processing = false;
            if (socket.destroyed) {
              release();
              sockets.delete(socket);
            }
            pending.delete(confirmation);
          });
          pending.add(confirmation);
          return;
        }
        if (phase === "hook-payload") {
          const runtime = opts.getRuntime();
          if (!runtimeValid(runtime)) {
            stop();
            return;
          }
          const payload = JSON.parse(frame.toString("utf8")) as unknown;
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid hook payload");
          opts.onActivity?.();
          phase = "processing";
          processing = true;
          setDeadline(opts.processingTimeoutMs ?? 5000);
          const work = postToolUseResponse(payload as PostToolUsePayload, {
            inferCwd: false,
            deferAccounting: (commit) => { account = commit; },
            resolver: async (cmd, allowed) => {
              if (!runtimeValid(runtime)) throw new Error("expired processing rules");
              return runtime.selectFor(cmd, "pro", allowed ? [...allowed] : undefined);
            }
          }).then((output) => {
            if (socket.destroyed) return;
            const response = Buffer.from(JSON.stringify({ ok: true, protocol: 2, output }));
            if (response.length > MAX_CAPTURE_FRAME_BYTES) throw new Error("hook response limit");
            release();
            phase = "delivery";
            setDeadline(opts.processingTimeoutMs ?? 5000);
            socket.write(encodeProcessingFrame(response));
          }).catch(() => stop()).finally(() => {
            processing = false;
            if (socket.destroyed) {
              release();
              sockets.delete(socket);
            }
            pending.delete(work);
          });
          pending.add(work);
          return;
        }
        if (phase === "prepare") {
          const parsed = JSON.parse(frame.toString("utf8"));
          if (parsed?.kind === "post-tool-use") {
            const candidate = PreparePostHook.parse(parsed);
            if (!timingSafeEqual(token, Buffer.from(candidate.token, "hex")) ||
              candidate.version !== opts.version || candidate.home !== home || !runtimeValid(opts.getRuntime())) {
              stop();
              return;
            }
            opts.onActivity?.();
            release();
            phase = "hook-payload";
            setDeadline(opts.prepareTimeoutMs ?? 1000);
            replyJson({ ok: true, protocol: 2 });
            return;
          }
          if (parsed?.kind === "pre-tool-use") {
            const candidate = PrepareHook.parse(parsed);
            if (!timingSafeEqual(token, Buffer.from(candidate.token, "hex")) ||
              candidate.version !== opts.version || candidate.home !== home) {
              stop();
              return;
            }
            opts.onActivity?.();
            let usage: { sessionId: string; routed: boolean } | undefined;
            const output = routePreToolUse(candidate.payload, candidate.host, { recordUsage: (sessionId, routed) => { usage = { sessionId, routed }; }, claudeDirs: { projectDir: candidate.claudeProjectDir, configDir: candidate.claudeConfigDir }, pathEnv: candidate.path ?? "", launchArgs: () => (candidate.claudePid ? claudeLaunchArgs({ CLAUDE_PID: candidate.claudePid }) : null) });
            const response = Buffer.from(JSON.stringify({ ok: true, protocol: 2, output }));
            if (response.length > 1024 * 1024) throw new Error("hook response limit");
            account = async () => {
              const delivered = usage;
              usage = undefined;
              if (delivered) recordUsageSync(delivered.sessionId, delivered.routed);
            };
            release();
            phase = "delivery";
            setDeadline(opts.processingTimeoutMs ?? 5000);
            socket.write(encodeProcessingFrame(response));
            return;
          }
          const candidate = Prepare.parse(parsed);
          if (!timingSafeEqual(token, Buffer.from(candidate.token, "hex")) ||
            candidate.version !== opts.version || candidate.home !== home || !runtimeValid(opts.getRuntime())) {
            stop();
            return;
          }
          request = candidate;
          opts.onActivity?.();
          yolo = yoloEnabled();
          release();
          phase = "capture";
          setDeadline(candidate.timeoutMs + 5000);
          replyJson({ ok: true, protocol: 2, yolo });
          return;
        }
        if (phase !== "capture" || !request) throw new Error("unexpected processing frame");
        const captured = decodeCapturedFrame(frame);
        opts.onActivity?.();
        const runtime = opts.getRuntime();
        if (!runtimeValid(runtime)) {
          stop();
          return;
        }
        phase = "processing";
        processing = true;
        setDeadline(opts.processingTimeoutMs ?? 5000);
        const env: NodeJS.ProcessEnv = {};
        const hostEnv = HOST_ENV[request.host as keyof typeof HOST_ENV];
        if (hostEnv) env[hostEnv] = "1";
        else if (request.host !== "shell") env.TOKMIZER_HOST = request.host;
        if (request.sessionId !== undefined) env.CLAUDE_CODE_SESSION_ID = request.sessionId;
        env.TOKMIZER_CCR_DISABLED = request.restoreDisabled ? "1" : "0";
        if (request.restoreMaxBytes !== undefined) env.TOKMIZER_CCR_ENTRY_MAX_BYTES = String(request.restoreMaxBytes);
        const work = processCapturedOutput({ ...captured, argv: request.argv }, {
          env,
          yolo,
          onMissingState: kickBackgroundEnroll,
          deferAccounting: (commit) => { account = commit; },
          resolver: async (cmd, allowed) => {
            if (!runtimeValid(runtime)) throw new Error("expired processing rules");
            return runtime.selectFor(cmd, "pro", allowed ? [...allowed] : undefined);
          }
        }).then((result) => {
          if (socket.destroyed) return;
          const stdout = Buffer.from(result.stdout);
          const stderr = Buffer.from(result.stderr);
          if (stdout.length > MAX_CAPTURE_BYTES + MAX_PREPARE_BYTES || stderr.length > MAX_CAPTURE_BYTES + MAX_PREPARE_BYTES) {
            throw new Error("processing response limit");
          }
          const header = Buffer.allocUnsafe(8);
          header.writeUInt32BE(stdout.length, 0);
          header.writeUInt32BE(stderr.length, 4);
          phase = "delivery";
          setDeadline(opts.processingTimeoutMs ?? 5000);
          socket.write(encodeProcessingFrame(Buffer.concat([header, stdout, stderr])));
        }).catch(() => stop()).finally(() => {
          processing = false;
          if (socket.destroyed) {
            release();
            sockets.delete(socket);
          }
          pending.delete(work);
        });
        pending.add(work);
      },
      (size) => {
        if (buffered + size > maxBufferedBytes) throw new Error("processing capacity exceeded");
        buffered += size;
        reserved += size;
      }
    );
    setDeadline(opts.prepareTimeoutMs ?? 1000);
    socket.on("data", (data: Buffer) => {
      try { reader.push(data); } catch { stop(); }
    });
    socket.on("error", stop);
    socket.on("close", () => {
      if (!processing) sockets.delete(socket);
      stop();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (!windows) chmodSync(opts.path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    activeConnections: () => sockets.size,
    close: async () => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled(pending);
    }
  };
}

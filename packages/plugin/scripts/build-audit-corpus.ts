import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "__tests__", "fixtures", "audit");

mkdirSync(OUT, { recursive: true });

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const BLU = "\x1b[34m";
const MAG = "\x1b[35m";
const CYA = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RST = "\x1b[0m";

function pickN<T>(arr: T[], rnd: () => number, n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(rnd() * arr.length)]!);
  return out;
}

function hexSha(rnd: () => number, len = 40): string {
  const chars = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(rnd() * 16)];
  return s;
}

function isoTs(rnd: () => number): string {
  const y = 2026, mo = 5, d = 1 + Math.floor(rnd() * 28);
  const h = Math.floor(rnd() * 24), mi = Math.floor(rnd() * 60), s = Math.floor(rnd() * 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${Math.floor(rnd() * 1000).toString().padStart(3, "0")}Z`;
}

function repeatTo(targetBytes: number, lineGen: () => string): string {
  const buf: string[] = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    const line = lineGen();
    buf.push(line);
    bytes += Buffer.byteLength(line, "utf8") + 1;
  }
  return buf.join("\n") + "\n";
}

function fixtureGit(): string {
  const rnd = prng(1);
  const authors = ["Author", "Reviewer", "claude-code", "Bot", "Maintainer"];
  const verbs = ["feat", "fix", "chore", "refactor", "docs", "test", "ci", "build", "perf", "style"];
  const subjects = [
    "tighten plan resolver for free bonus window",
    "add daemon socket health probe + retry budget",
    "drop noisy progress bar from npm install path",
    "audit residual leaks in shim runner",
    "wire vercel.json maxDuration per route",
    "redact secrets before observation buffer write",
    "fix off-by-one in sticky scrollytelling",
    "polish hero gradient on safari iOS",
    "bump shared to 0.1.0 + lockfile dedupe",
    "restore prismatic logo on mobile narrow viewports"
  ];
  const lineGen = () => {
    const sha = hexSha(rnd, 7);
    const ts = isoTs(rnd);
    const verb = verbs[Math.floor(rnd() * verbs.length)]!;
    const subject = subjects[Math.floor(rnd() * subjects.length)]!;
    const author = authors[Math.floor(rnd() * authors.length)]!;
    return `${YEL}*${RST} ${CYA}${sha}${RST} ${GRN}(HEAD -> main, origin/main)${RST} ${BOLD}${verb}: ${subject}${RST} ${DIM}— ${author} <${author.toLowerCase()}@noreply.local> ${ts}${RST} [TID:0]`;
  };
  return repeatTo(120_000, lineGen);
}

function fixtureNpm(): string {
  const rnd = prng(2);
  const pkgs = ["react", "react-dom", "next", "tailwindcss", "playwright", "vitest",
    "smol-toml", "zod", "tsx", "typescript", "eslint", "prettier", "@types/node",
    "esbuild", "@playwright/test", "happy-dom", "lucide-react", "framer-motion"];
  const lineGen = () => {
    const r = rnd();
    const pkg = pkgs[Math.floor(rnd() * pkgs.length)]!;
    if (r < 0.25) return `npm WARN deprecated ${pkg}@${Math.floor(rnd() * 10)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 20)}: This package has been deprecated, see https://github.com/example/repo/issues/${Math.floor(rnd() * 9999)} for migration steps and tooling support details`;
    if (r < 0.40) return `npm notice ${pkg}@${Math.floor(rnd() * 10)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 20)} - patches ${Math.floor(rnd() * 5)} CVE in transitive deps; rerun audit if you depend on bundle`;
    if (r < 0.50) return `npm fund ${pkg}: please consider funding its development at https://opencollective.com/${pkg}-friends`;
    if (r < 0.62) return `npm audit found 0 vulnerabilities in ${1000 + Math.floor(rnd() * 200)} scanned packages`;
    if (r < 0.72) return `npm WARN tar ENOENT: no such file or directory, open '/tmp/.npm-cache/_cacache/tmp/${hexSha(rnd, 32)}.tgz' (retry ${Math.floor(rnd() * 3)})`;
    if (r < 0.82) return `${DIM}added ${1 + Math.floor(rnd() * 4)} packages, removed ${Math.floor(rnd() * 2)} packages, and audited ${1000 + Math.floor(rnd() * 300)} packages in ${Math.floor(rnd() * 50)}s${RST}`;
    if (r < 0.90) return ``;
    if (r < 0.95) return `up to date in ${Math.floor(rnd() * 9)}s`;
    return `${GRN}+ ${pkg}@${Math.floor(rnd() * 10)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 30)}${RST}`;
  };
  return repeatTo(180_000, lineGen);
}

function fixtureDocker(): string {
  const rnd = prng(3);
  const steps = ["FROM node:20-bookworm-slim", "RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git",
    "COPY package.json package-lock.json ./", "RUN npm ci --omit=dev",
    "COPY . .", "RUN npm run build", "USER node", "ENTRYPOINT [\"node\", \"dist/index.js\"]"];
  const lineGen = () => {
    const r = rnd();
    if (r < 0.40) return `#${Math.floor(rnd() * 20)} ${Math.floor(rnd() * 200)}.${Math.floor(rnd() * 999)} ${DIM}sha256:${hexSha(rnd, 64)} ${(rnd() * 100).toFixed(1)}MB / ${(100 + rnd() * 500).toFixed(1)}MB ${(rnd() * 100).toFixed(1)}%${RST}`;
    if (r < 0.55) return `#${Math.floor(rnd() * 20)} extracting sha256:${hexSha(rnd, 64)} ${(rnd() * 100).toFixed(1)}s`;
    if (r < 0.65) return `Loaded plugin: buildx ${Math.floor(rnd() * 20)}`;
    if (r < 0.75) return ``;
    if (r < 0.85) return `#${Math.floor(rnd() * 20)} ${steps[Math.floor(rnd() * steps.length)]} ${DIM}DONE ${(rnd() * 5).toFixed(2)}s${RST}`;
    if (r < 0.92) return `#${Math.floor(rnd() * 20)} ${BLU}CACHED${RST} [${Math.floor(rnd() * 10)}/${steps.length}] ${steps[Math.floor(rnd() * steps.length)]}`;
    return `#${Math.floor(rnd() * 20)} writing image sha256:${hexSha(rnd, 64)} done`;
  };
  return repeatTo(140_000, lineGen);
}

function fixtureKubectl(): string {
  const rnd = prng(4);
  const ns = ["kube-system", "default", "monitoring", "ingress-nginx", "argocd", "cert-manager", "linkerd", "istio-system", "logging", "telemetry"];
  const apps = ["api", "web", "worker", "scheduler", "indexer", "auth", "billing", "ingest", "egress", "search"];
  const statuses = ["Running", "Pending", "CrashLoopBackOff", "Completed", "Error", "Terminating", "ContainerCreating"];
  let first = true;
  const lineGen = () => {
    if (first) {
      first = false;
      return `NAMESPACE        NAME                                          READY   STATUS                  RESTARTS         AGE`;
    }
    const n = ns[Math.floor(rnd() * ns.length)]!;
    const a = apps[Math.floor(rnd() * apps.length)]!;
    const s = statuses[Math.floor(rnd() * statuses.length)]!;
    const sha = hexSha(rnd, 10);
    const ready = `${Math.floor(rnd() * 3)}/${1 + Math.floor(rnd() * 3)}`;
    const restarts = Math.floor(rnd() * 200);
    const age = `${Math.floor(rnd() * 90)}d`;
    return `${n.padEnd(16)} ${a}-deployment-${sha}-${hexSha(rnd, 5)}            ${ready}     ${s.padEnd(22)}  ${restarts.toString().padEnd(15)}  ${age}`;
  };
  return repeatTo(160_000, lineGen);
}

function fixtureCargo(): string {
  const rnd = prng(5);
  const crates = ["serde", "tokio", "tower", "hyper", "reqwest", "regex", "rayon", "anyhow",
    "thiserror", "clap", "tracing", "tracing-subscriber", "axum", "tonic", "prost", "futures",
    "futures-util", "async-trait", "uuid", "chrono", "time", "itertools", "indexmap", "smallvec"];
  const lineGen = () => {
    const r = rnd();
    const c = crates[Math.floor(rnd() * crates.length)]!;
    if (r < 0.25) return `   ${GRN}Compiling${RST} ${c} v${Math.floor(rnd() * 5)}.${Math.floor(rnd() * 30)}.${Math.floor(rnd() * 60)}`;
    if (r < 0.40) return `   ${BLU}Updating${RST} crates.io index for ${c}`;
    if (r < 0.52) return `   ${YEL}Downloaded${RST} ${c} v${Math.floor(rnd() * 5)}.${Math.floor(rnd() * 30)}.${Math.floor(rnd() * 60)}`;
    if (r < 0.62) return `   ${DIM}Fresh${RST} ${c} v${Math.floor(rnd() * 5)}.${Math.floor(rnd() * 30)}.${Math.floor(rnd() * 60)}`;
    if (r < 0.70) return ``;
    if (r < 0.85) return `${YEL}warning${RST}: unused variable: \`${c}_handle\`\n   --> src/${c}/runtime.rs:${Math.floor(rnd() * 999)}:${Math.floor(rnd() * 60)}\n    |\n    | let ${c}_handle = runtime.spawn(task);\n    |     ^^^^^^^^^^^ help: if this is intentional, prefix it with an underscore`;
    if (r < 0.95) return `   ${BLU}Locking${RST} ${c} to ${Math.floor(rnd() * 99)} new + ${Math.floor(rnd() * 20)} updated versions`;
    return `    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in ${(rnd() * 60).toFixed(2)}s`;
  };
  return repeatTo(140_000, lineGen);
}

function fixtureGh(): string {
  const rnd = prng(6);
  const titles = [
    "feat(daemon): keepalive timer with backoff + drift correction across timezones",
    "fix(audit-residuals): redact API tokens before observation flush",
    "chore(deps): bump react 19.2.5 -> 19.2.6 and dedupe lockfile to drop hoisted 18.3.1",
    "test(pipeline): cover smart-code collapse for python triple-quoted strings",
    "docs(plan): tighten copy in 03-human-copy.md after reviewer pass",
    "refactor(matcher): cache select lookups by canonical command form",
    "perf(strip-ansi): single-pass CSI+OSC replacer using rope buffer",
    "ci(vercel): per-route maxDuration + security headers + caveman commit",
    "style(globals): collapse design tokens, drop legacy fallback vars"
  ];
  const states = ["OPEN", "MERGED", "DRAFT", "CLOSED"];
  let first = true;
  const lineGen = () => {
    if (first) {
      first = false;
      return `Showing 30 of 142 open pull requests in tokmizer/tokmizer\n\nID    TITLE                                                                                          BRANCH                            STATE       CREATED`;
    }
    const id = `#${1000 + Math.floor(rnd() * 9000)}`;
    const t = titles[Math.floor(rnd() * titles.length)]!;
    const b = `feat/${hexSha(rnd, 6)}-${["wip", "draft", "review", "ready"][Math.floor(rnd() * 4)]}`;
    const s = states[Math.floor(rnd() * states.length)]!;
    const c = `${Math.floor(rnd() * 14) + 1}d`;
    return `${CYA}${id}${RST}  ${t.padEnd(95)}  ${b.padEnd(32)}  ${MAG}${s.padEnd(10)}${RST}  ${c}`;
  };
  return repeatTo(120_000, lineGen);
}

function fixtureAws(): string {
  const rnd = prng(7);
  const types = ["t3.micro", "t3.small", "m5.large", "c5.xlarge", "r5.2xlarge"];
  let i = 0;
  const lineGen = () => {
    const r = rnd();
    if (i === 0) { i++; return `{\n    "Reservations": ["`; }
    if (r < 0.04) return `        ],`;
    if (r < 0.08) return `        {`;
    if (r < 0.12) return `        },`;
    if (r < 0.16) return `            "Instances": [`;
    const padBy = `                "${["InstanceId", "ImageId", "PrivateIpAddress", "PublicDnsName", "LaunchTime", "Architecture", "RootDeviceType", "VirtualizationType", "ClientToken", "Hypervisor", "BlockDeviceMappings", "EbsOptimized", "EnaSupport", "Tags", "MetadataOptions"][Math.floor(rnd() * 15)]}":`;
    if (r < 0.45) return `${padBy} "i-${hexSha(rnd, 16)}",`;
    if (r < 0.55) return `${padBy} "ami-${hexSha(rnd, 16)}",`;
    if (r < 0.65) return `${padBy} "${types[Math.floor(rnd() * types.length)]}",`;
    if (r < 0.75) return `                "PrivateIpAddress": "10.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}",`;
    if (r < 0.85) return `                "Tags": [{"Key": "Name", "Value": "instance-${hexSha(rnd, 8)}"}, {"Key": "Environment", "Value": "${["dev", "stg", "prod"][Math.floor(rnd() * 3)]}"}, {"Key": "Owner", "Value": "team-${hexSha(rnd, 6)}"}],`;
    return `                "LaunchTime": "${isoTs(rnd)}",`;
  };
  return repeatTo(190_000, lineGen);
}

function fixturePytest(): string {
  const rnd = prng(8);
  let first = true;
  const lineGen = () => {
    if (first) {
      first = false;
      return [
        `============================= test session starts ==============================`,
        `platform linux -- Python 3.11.6, pytest-8.0.0, pluggy-1.4.0`,
        `rootdir: /home/runner/work/tokmizer/tokmizer`,
        `plugins: anyio-4.2.0, asyncio-0.23.3, cov-4.1.0`,
        `collecting ... collected 1247 items`,
        ``
      ].join("\n");
    }
    const r = rnd();
    if (r < 0.65) return `tests/unit/${["pipeline", "loader", "matcher", "schema"][Math.floor(rnd() * 4)]}/test_${hexSha(rnd, 6)}.py::test_${hexSha(rnd, 8)} ${GRN}PASSED${RST} [ ${(rnd() * 100).toFixed(0).padStart(2)}%]`;
    if (r < 0.75) return ``;
    if (r < 0.85) return `${YEL}WARNING${RST}  conftest.py: PytestUnknownMarkWarning: Unknown pytest.mark.${["slow", "integration", "flaky"][Math.floor(rnd() * 3)]} - is this a typo?`;
    if (r < 0.93) {
      return [
        `${RED}FAILED${RST} tests/integration/test_filter_chain.py::test_${hexSha(rnd, 8)} - AssertionError: expected output to match snapshot`,
        `${RED}E${RST}   assert "compiled output ${hexSha(rnd, 10)}" == "expected ${hexSha(rnd, 10)}"`,
        `${RED}E${RST}     - expected output ${hexSha(rnd, 10)}`,
        `${RED}E${RST}     + compiled output ${hexSha(rnd, 10)}`,
        ``
      ].join("\n");
    }
    return `tests/integration/test_${hexSha(rnd, 8)}.py::test_${hexSha(rnd, 6)} ${GRN}PASSED${RST} [ ${(rnd() * 100).toFixed(0).padStart(2)}%]`;
  };
  return repeatTo(160_000, lineGen);
}

function fixtureVitest(): string {
  const rnd = prng(9);
  const lineGen = () => {
    const r = rnd();
    if (r < 0.70) return ` ${GRN}✓${RST} packages/plugin/src/__tests__/${["pipeline", "matcher", "loader"][Math.floor(rnd() * 3)]}.test.ts > should ${["compile", "strip ansi", "match command", "apply max_lines", "respect on_empty"][Math.floor(rnd() * 5)]} ${(rnd() * 50).toFixed(0)}ms`;
    if (r < 0.78) return ``;
    if (r < 0.85) return ` ${YEL}↓${RST} packages/plugin/src/__tests__/skipped.test.ts > should ${["work later"][0]} ${DIM}[skipped]${RST}`;
    if (r < 0.94) return [
      ` ${RED}×${RST} packages/plugin/src/__tests__/pipeline.test.ts > should compile ${rnd().toFixed(3)}`,
      `${RED}  AssertionError: expected '...lots...of...output...${hexSha(rnd, 20)}' to equal '...other...output...${hexSha(rnd, 20)}'${RST}`,
      `   ❯ packages/plugin/src/__tests__/pipeline.test.ts:${Math.floor(rnd() * 300)}:${Math.floor(rnd() * 80)}`,
      ``
    ].join("\n");
    return ` ${GRN}✓${RST} ${["smart-code", "strip-ansi", "redact", "fingerprint"][Math.floor(rnd() * 4)]} > ${hexSha(rnd, 10)}`;
  };
  return repeatTo(120_000, lineGen);
}

function fixtureTerraform(): string {
  const rnd = prng(10);
  const resources = ["aws_instance.web", "aws_security_group.allow_https", "aws_s3_bucket.assets",
    "aws_lambda_function.processor", "aws_dynamodb_table.sessions", "aws_iam_role.task_exec",
    "aws_cloudwatch_log_group.app", "google_compute_instance.runner", "kubernetes_deployment.api"];
  const lineGen = () => {
    const r = rnd();
    if (r < 0.10) return `Refreshing state... [id=${hexSha(rnd, 30)}]`;
    if (r < 0.14) return `Acquiring state lock. This may take a few moments...`;
    if (r < 0.18) return `Releasing state lock. This may take a few moments...`;
    if (r < 0.24) return `Initializing the backend...`;
    if (r < 0.30) return `- Reusing previous version of hashicorp/aws from the dependency lock file`;
    if (r < 0.34) return `- Installing hashicorp/aws v5.${Math.floor(rnd() * 30)}.${Math.floor(rnd() * 60)}...`;
    if (r < 0.38) return `- Installed hashicorp/aws v5.${Math.floor(rnd() * 30)}.${Math.floor(rnd() * 60)} (signed by HashiCorp)`;
    if (r < 0.46) return ``;
    if (r < 0.55) return `      ${DIM}# (${Math.floor(rnd() * 50)} unchanged attributes hidden)${RST}`;
    if (r < 0.70) {
      const res = resources[Math.floor(rnd() * resources.length)]!;
      return [
        `  ${YEL}~${RST} resource "${res.split(".")[0]}" "${res.split(".")[1]}" {`,
        `      ${YEL}~${RST} id              = "${hexSha(rnd, 16)}" -> (known after apply)`,
        `      ${DIM}# (${Math.floor(rnd() * 20)} unchanged attributes hidden)${RST}`,
        `    }`
      ].join("\n");
    }
    if (r < 0.85) return `Plan: ${Math.floor(rnd() * 20)} to add, ${Math.floor(rnd() * 20)} to change, ${Math.floor(rnd() * 5)} to destroy.`;
    return `${DIM}Note: Objects have changed outside of Terraform${RST}`;
  };
  return repeatTo(140_000, lineGen);
}

function fixtureGcloud(): string {
  const rnd = prng(11);
  const zones = ["us-central1-a", "us-central1-b", "europe-west1-c", "asia-east1-a"];
  const types = ["n1-standard-1", "n1-standard-2", "e2-medium", "c2-standard-4"];
  let first = true;
  const lineGen = () => {
    if (first) {
      first = false;
      return [
        `WARNING: The following projects do not have a compute API enabled (skipped):`,
        ``,
        `NAME                                       ZONE              MACHINE_TYPE      PREEMPTIBLE  INTERNAL_IP    EXTERNAL_IP     STATUS`
      ].join("\n");
    }
    const r = rnd();
    if (r < 0.08) return `WARNING: This command is using service account impersonation`;
    if (r < 0.18) return ``;
    const name = `instance-${hexSha(rnd, 12)}-${["api", "worker", "web", "ingest"][Math.floor(rnd() * 4)]}`;
    const zone = zones[Math.floor(rnd() * zones.length)]!;
    const type = types[Math.floor(rnd() * types.length)]!;
    const internal = `10.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}`;
    const external = `34.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}`;
    return `${name.padEnd(42)} ${zone.padEnd(17)} ${type.padEnd(17)} ${"".padEnd(12)} ${internal.padEnd(14)} ${external.padEnd(15)} ${["RUNNING", "STOPPED", "TERMINATED"][Math.floor(rnd() * 3)]}`;
  };
  return repeatTo(120_000, lineGen);
}

function fixtureTsc(): string {
  const rnd = prng(12);
  const files = ["src/engine/pipeline.ts", "src/engine/loader.ts", "src/engine/matcher.ts",
    "packages/plugin/src/daemon/server.ts", "app/src/lib/auth.ts", "app/src/app/page.tsx",
    "packages/shared/src/api-contracts.ts"];
  const messages = [
    "Property 'foo' does not exist on type '{ bar: string; }'.",
    "Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
    "Object is possibly 'undefined'.",
    "Type 'unknown' is not assignable to type 'string'.",
    "Cannot find module '@/lib/auth' or its corresponding type declarations."
  ];
  const lineGen = () => {
    const r = rnd();
    if (r < 0.55) {
      const f = files[Math.floor(rnd() * files.length)]!;
      const line = Math.floor(rnd() * 900) + 1;
      const col = Math.floor(rnd() * 100) + 1;
      const m = messages[Math.floor(rnd() * messages.length)]!;
      return `${f}(${line},${col}): error TS${2300 + Math.floor(rnd() * 800)}: ${m}`;
    }
    if (r < 0.70) return ``;
    if (r < 0.85) return `Found ${Math.floor(rnd() * 200)} errors in ${Math.floor(rnd() * 20)} files.`;
    return `${DIM}    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~${RST}`;
  };
  return repeatTo(120_000, lineGen);
}

function fixtureFind(): string {
  const rnd = prng(13);
  const dirs = ["/var/log", "/usr/local/share", "/opt", "/Users/runner/Library", "/tmp", "/private/var"];
  const lineGen = () => {
    const r = rnd();
    if (r < 0.50) return `find: '${dirs[Math.floor(rnd() * dirs.length)]}/system/${hexSha(rnd, 10)}': Permission denied`;
    if (r < 0.55) return `find: '${dirs[Math.floor(rnd() * dirs.length)]}/${hexSha(rnd, 10)}': Operation not permitted`;
    if (r < 0.65) return ``;
    const d = dirs[Math.floor(rnd() * dirs.length)]!;
    return `${d}/${["app", "system", "runner", "boot", "daemon"][Math.floor(rnd() * 5)]}/${hexSha(rnd, 8)}/${hexSha(rnd, 6)}-${["info", "debug", "error", "trace"][Math.floor(rnd() * 4)]}.log`;
  };
  return repeatTo(110_000, lineGen);
}

function fixtureNext(): string {
  const rnd = prng(14);
  let first = true;
  const lineGen = () => {
    if (first) {
      first = false;
      return [
        ` ${BLU}▲ Next.js 15.0.0${RST}`,
        ``,
        `   Creating an optimized production build ...`,
        ` ${GRN}✓${RST} Compiled successfully in ${(rnd() * 60).toFixed(2)}s`,
        ``,
        `Route (app)                                Size     First Load JS`
      ].join("\n");
    }
    const r = rnd();
    if (r < 0.55) {
      const route = `/${["dashboard", "pricing", "blog", "docs", "auth", "settings"][Math.floor(rnd() * 6)]}/${hexSha(rnd, 6)}`;
      return `┌ ○ ${route.padEnd(40)} ${(rnd() * 50).toFixed(2)} kB  ${(rnd() * 250).toFixed(2)} kB`;
    }
    if (r < 0.70) return `├ ${["○", "ƒ"][Math.floor(rnd() * 2)]} /api/${hexSha(rnd, 8)}                        ${(rnd() * 5).toFixed(2)} kB         ${(rnd() * 100).toFixed(2)} kB`;
    if (r < 0.80) return ``;
    if (r < 0.90) return `+ First Load JS shared by all                        ${(rnd() * 200).toFixed(2)} kB`;
    return `  └ chunks/${hexSha(rnd, 12)}.js                     ${(rnd() * 100).toFixed(2)} kB`;
  };
  return repeatTo(80_000, lineGen);
}

function fixturePrisma(): string {
  const rnd = prng(15);
  let first = true;
  const lineGen = () => {
    if (first) {
      first = false;
      return [
        `${BLU}Environment variables loaded from .env${RST}`,
        `${BLU}Prisma schema loaded from prisma/schema.prisma${RST}`,
        `${BLU}Datasource "db": PostgreSQL database "tokmizer_dev", schema "public" at "localhost:5432"${RST}`,
        ``,
        `Applying migration \`${isoTs(rnd)}_init\``,
      ].join("\n");
    }
    const r = rnd();
    if (r < 0.40) return `Applying migration \`${isoTs(rnd)}_${["add_users", "add_observations", "add_corpus", "drop_legacy_table", "alter_column"][Math.floor(rnd() * 5)]}\``;
    if (r < 0.55) return ``;
    if (r < 0.75) return `The following migration(s) have been created and applied from new schema changes:`;
    if (r < 0.85) return `migrations/`;
    if (r < 0.95) return `   └─ ${isoTs(rnd).slice(0, 14)}_${hexSha(rnd, 8)}/migration.sql`;
    return `${GRN}✔${RST} Generated Prisma Client (v5.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 20)}) to ./node_modules/@prisma/client in ${(rnd() * 5).toFixed(2)}s`;
  };
  return repeatTo(70_000, lineGen);
}

const fixtures: Array<{ name: string; content: string; command: string }> = [
  { name: "git.txt", command: "git log --all --graph --oneline --decorate --color=always", content: fixtureGit() },
  { name: "npm.txt", command: "npm install --verbose", content: fixtureNpm() },
  { name: "docker.txt", command: "docker build -t example/app:latest .", content: fixtureDocker() },
  { name: "kubectl.txt", command: "kubectl get pods -A", content: fixtureKubectl() },
  { name: "cargo.txt", command: "cargo build", content: fixtureCargo() },
  { name: "gh.txt", command: "gh pr list --limit 200", content: fixtureGh() },
  { name: "aws.txt", command: "aws ec2 describe-instances", content: fixtureAws() },
  { name: "pytest.txt", command: "pytest -v", content: fixturePytest() },
  { name: "vitest.txt", command: "vitest run --reporter=verbose", content: fixtureVitest() },
  { name: "terraform.txt", command: "terraform plan", content: fixtureTerraform() },
  { name: "gcloud.txt", command: "gcloud compute instances list", content: fixtureGcloud() },
  { name: "tsc.txt", command: "tsc --noEmit", content: fixtureTsc() },
  { name: "find.txt", command: "find / -name '*.log'", content: fixtureFind() },
  { name: "next.txt", command: "next build", content: fixtureNext() },
  { name: "prisma.txt", command: "prisma migrate dev", content: fixturePrisma() }
];

const manifest: Array<{ name: string; command: string; bytes: number }> = [];
for (const f of fixtures) {
  const path = join(OUT, f.name);
  writeFileSync(path, f.content, "utf8");
  manifest.push({ name: f.name, command: f.command, bytes: Buffer.byteLength(f.content, "utf8") });
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

process.stdout.write(`Wrote ${manifest.length} fixtures to ${OUT}\n`);
for (const m of manifest) {
  process.stdout.write(`  ${m.name.padEnd(20)} ${m.bytes.toString().padStart(8)} bytes  — ${m.command}\n`);
}

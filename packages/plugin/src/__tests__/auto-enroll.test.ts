import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign } from "node:crypto";

let dir: string;

vi.mock("../prod-public-key", () => ({ TOKMIZER_PROD_PUBLIC_KEY_PEM: "" }));
vi.mock("../transport", async (importActual) => {
  const actual = await importActual<typeof import("../transport")>();
  return { ...actual, fetchSigned: vi.fn() };
});
vi.mock("../fingerprint", () => ({
  buildFingerprint: vi.fn().mockResolvedValue({
    fingerprint: "f".repeat(64),
    installId: "11111111-1111-1111-1111-111111111111"
  })
}));
vi.mock("../bundle", () => ({ refreshBundles: vi.fn().mockResolvedValue(undefined) }));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function signedEnrollResponse() {
  const body = JSON.stringify({
    token: "tokmizer_anon",
    jwt: "jwt-anon-value",
    signingSecret: "s".repeat(32),
    plan: "free",
    status: "active",
    trialEndsAt: null,
    subEndsAt: null,
    jwtVersion: 1
  });
  const ts = Date.now();
  const sig = sign(null, Buffer.from(`${ts}.${body}`, "utf8"), privateKey).toString("base64url");
  return {
    status: 200,
    ok: true,
    headers: new Headers({ "x-tokmizer-resp-sig": sig, "x-tokmizer-resp-ts": String(ts) }),
    text: () => Promise.resolve(body)
  } as unknown as Response;
}

let savedCi: string | undefined;
let savedGha: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkr-enroll-"));
  savedHome = process.env.TOKMIZER_HOME;
  process.env.TOKMIZER_HOME = dir;
  process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM = PUB_PEM;
  process.env.TOKMIZER_DEV = "1";
  savedCi = process.env.CI;
  savedGha = process.env.GITHUB_ACTIONS;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.TOKMIZER_HOME;
  else process.env.TOKMIZER_HOME = savedHome;
  delete process.env.TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM;
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
  if (savedGha === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = savedGha;
  vi.clearAllMocks();
});

describe("maybeAutoEnroll", () => {
  it("sends only the install ID, plus the internal marker when TOKMIZER_INTERNAL=1", async () => {
    const { fetchSigned } = await import("../transport");
    const mock = fetchSigned as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(signedEnrollResponse());
    const { maybeAutoEnroll } = await import("../license");
    await maybeAutoEnroll("http://localhost");
    expect(Object.keys(mock.mock.calls[0]![2]).sort()).toEqual(["fingerprint", "installId", "pluginVersion", "timeZone"]);
    rmSync(join(dir, "state.json"), { force: true });
    rmSync(join(dir, "license.json"), { force: true });
    mock.mockClear();
    process.env.TOKMIZER_INTERNAL = "1";
    try {
      const { autoEnroll } = await import("../license");
      await autoEnroll("http://localhost");
    } finally {
      delete process.env.TOKMIZER_INTERNAL;
    }
    expect(mock.mock.calls[0]![2]).toMatchObject({ internal: true });
  });

  it("enrolls and saves state when none exists", async () => {
    const { fetchSigned } = await import("../transport");
    (fetchSigned as ReturnType<typeof vi.fn>).mockResolvedValue(signedEnrollResponse());
    const { maybeAutoEnroll } = await import("../license");
    const state = await maybeAutoEnroll("http://localhost");
    expect(state?.token).toBe("tokmizer_anon");
    expect(state?.plan).toBe("free");
    expect(state?.email).toBe("");
    expect(existsSync(join(dir, "state.json"))).toBe(true);
  });

  it("skips enrollment entirely in CI environments", async () => {
    process.env.CI = "true";
    const { fetchSigned } = await import("../transport");
    const { maybeAutoEnroll } = await import("../license");
    const state = await maybeAutoEnroll("http://localhost");
    expect(state).toBeNull();
    expect(fetchSigned).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  it("skips enrollment under GitHub Actions even without CI flag", async () => {
    process.env.GITHUB_ACTIONS = "true";
    const { fetchSigned } = await import("../transport");
    const { maybeAutoEnroll } = await import("../license");
    const state = await maybeAutoEnroll("http://localhost");
    expect(state).toBeNull();
    expect(fetchSigned).not.toHaveBeenCalled();
  });

  it("still returns existing state in CI", async () => {
    process.env.CI = "true";
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ token: "tokmizer_linked", plan: "pro", email: "x@y.z" })
    );
    const { maybeAutoEnroll } = await import("../license");
    const state = await maybeAutoEnroll("http://localhost");
    expect(state?.token).toBe("tokmizer_linked");
  });

  it("returns existing state without enrolling", async () => {
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        token: "tokmizer_known",
        jwt: "j",
        signingSecret: "s",
        plan: "smart",
        status: "active",
        trialEndsAt: null,
        subEndsAt: null,
        jwtVersion: 1,
        installId: "11111111-1111-1111-1111-111111111111",
        email: "u@x"
      })
    );
    const { fetchSigned } = await import("../transport");
    const { maybeAutoEnroll } = await import("../license");
    const state = await maybeAutoEnroll("http://localhost");
    expect(state?.token).toBe("tokmizer_known");
    expect(fetchSigned).not.toHaveBeenCalled();
  });

  it("writes a cooldown and returns null when enroll fails, then skips while cooled", async () => {
    const { fetchSigned } = await import("../transport");
    (fetchSigned as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 500,
      ok: false,
      headers: new Headers(),
      text: () => Promise.resolve("boom")
    } as unknown as Response);
    const { maybeAutoEnroll } = await import("../license");

    const first = await maybeAutoEnroll("http://localhost");
    expect(first).toBeNull();
    expect(existsSync(join(dir, "enroll-cooldown"))).toBe(true);

    (fetchSigned as ReturnType<typeof vi.fn>).mockClear();
    const second = await maybeAutoEnroll("http://localhost");
    expect(second).toBeNull();
    expect(fetchSigned).not.toHaveBeenCalled();
  });
});

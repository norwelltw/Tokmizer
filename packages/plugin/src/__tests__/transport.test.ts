import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fetchSigned } from "../transport";
import { PLUGIN_VERSION } from "../version";

describe("fetchSigned", () => {
  it("attaches all required headers", async () => {
    const seen: { url: string; init: RequestInit } = { url: "", init: {} };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.url = url;
        seen.init = init;
        return new Response("{}", { status: 200 });
      })
    );
    await fetchSigned(
      "POST",
      "/api/v1/license/activate",
      { token: "x", email: "a@b.c" },
      {
        baseUrl: "https://x.test",
        fingerprint: "f".repeat(64),
        installId: "11111111-1111-1111-1111-111111111111"
      }
    );
    const h = new Headers(seen.init.headers as HeadersInit);
    expect(h.get("x-tokmizer-fingerprint")).toBe("f".repeat(64));
    expect(h.get("x-tokmizer-install-id")).toBe("11111111-1111-1111-1111-111111111111");
    expect(h.get("x-tokmizer-plugin-version")).toBe(PLUGIN_VERSION);
    expect(h.get("x-tokmizer-sig")?.length).toBe(64);
  });

  it("binds the HMAC to the method, the path and the timestamp", async () => {
    const seen: { init: RequestInit } = { init: {} };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      seen.init = init;
      return new Response("{}", { status: 200 });
    }));
    await fetchSigned("PATCH", "/api/v1/settings", { a: 1 }, {
      baseUrl: "https://x.test",
      signingSecret: "secret",
      fingerprint: "f".repeat(64),
      installId: "11111111-1111-1111-1111-111111111111"
    });
    const h = new Headers(seen.init.headers as HeadersInit);
    const ts = h.get("x-tokmizer-ts");
    const expected = createHmac("sha256", "secret").update(`PATCH\n/api/v1/settings\n${ts}\n{"a":1}`).digest("hex");
    expect(h.get("x-tokmizer-sig")).toBe(expected);
  });
});

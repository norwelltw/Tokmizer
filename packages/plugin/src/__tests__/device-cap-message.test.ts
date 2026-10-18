import { describe, expect, it, vi } from "vitest";

vi.mock("../transport", () => ({
  fetchSigned: vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: "forbidden",
          message: "Device limit reached (3 devices max). Manage devices at tokmizer.com/dashboard/devices.",
          code: "device_cap"
        }),
        { status: 403 }
      )
  ),
  consumeSignedJson: vi.fn()
}));

vi.mock("../fingerprint", () => ({
  buildFingerprint: vi.fn(async () => ({
    fingerprint: "f".repeat(64),
    installId: "11111111-1111-1111-1111-111111111111",
    hostname: "host",
    os: "darwin",
    osVersion: "14.5",
    cpuModel: "m",
    cpuCores: 8,
    macHash: "a".repeat(64),
    usernameHash: "b".repeat(64)
  }))
}));

import { activate } from "../license";
import { M } from "../ui";

describe("activate device cap error surface", () => {
  it("throws the human device-limit message instead of raw response text", async () => {
    await expect(activate({ token: "tokmizer_x", baseUrl: "http://localhost:9" })).rejects.toThrow(
      M.deviceCap
    );
  });
});

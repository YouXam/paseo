import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, exportSyncDataKey, importSyncDataKey } from "./crypto";

describe("cloud sync base64url", () => {
  it("encodes URL-safe base64 without padding", () => {
    expect(base64UrlEncode(new Uint8Array([251, 255, 255]))).toBe("-___");
    expect(base64UrlEncode(new Uint8Array([1, 2]))).toBe("AQI");
  });

  it("decodes unpadded URL-safe base64", () => {
    expect(Array.from(base64UrlDecode("-___"))).toEqual([251, 255, 255]);
    expect(Array.from(base64UrlDecode("AQI"))).toEqual([1, 2]);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 64, 127, 128, 200, 251, 255]);

    expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
  });
});

describe("cloud sync data keys", () => {
  it("exports and imports AES-GCM data keys", async () => {
    const bytes = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));
    const original = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );

    const encoded = await exportSyncDataKey(original);
    const restored = await importSyncDataKey(encoded);

    expect(Array.from(base64UrlDecode(await exportSyncDataKey(restored)))).toEqual(
      Array.from(bytes),
    );
  });
});

import { describe, expect, it } from "vitest";
import { createTurnCredentials } from "../../backend/src/turnCredentials";

describe("coturn REST credentials", () => {
  it("signs an expiring username with HMAC-SHA1 and Base64", () => {
    const result = createTurnCredentials("test-secret", 1_700_000_000_000, 3600, "nakiri");
    expect(result.username).toBe("1700003600:nakiri");
    expect(result.expiresAt).toBe(1_700_003_600);
    expect(result.credential).toBe("tfSatl2CG5j6lsrwR1sVqHhX7lw=");
  });

  it("rejects an empty secret, invalid TTL, or empty subject", () => {
    expect(() => createTurnCredentials("", 1_700_000_000_000, 3600, "nakiri")).toThrow();
    expect(() => createTurnCredentials("secret", 1_700_000_000_000, 0, "nakiri")).toThrow();
    expect(() => createTurnCredentials("secret", 1_700_000_000_000, Number.POSITIVE_INFINITY, "nakiri")).toThrow();
    expect(() => createTurnCredentials("secret", Number.NaN, 3600, "nakiri")).toThrow();
    expect(() => createTurnCredentials("secret", 1_700_000_000_000, 3600, "")).toThrow();
  });
});

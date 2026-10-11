import { AuthController } from "./auth.controller";

/**
 * POST /auth/google/start is public and stores a server-side nonce per call, so it carries its own
 * per-IP cap, set next to `google/exchange` (30 per minute), instead of relying on the global one.
 */
describe("AuthController throttle metadata: Google sign-in endpoints", () => {
  const meta = (name: keyof AuthController, key: "LIMIT" | "TTL") =>
    Reflect.getMetadata(`THROTTLER:${key}default`, AuthController.prototype[name] as object);

  it("google/start has an explicit default throttle of 30 per minute", () => {
    expect(meta("googleStart", "LIMIT")).toBe(30);
    expect(meta("googleStart", "TTL")).toBe(60_000);
  });

  it("matches google/exchange", () => {
    expect(meta("googleStart", "LIMIT")).toBe(meta("googleExchange", "LIMIT"));
    expect(meta("googleStart", "TTL")).toBe(meta("googleExchange", "TTL"));
  });
});

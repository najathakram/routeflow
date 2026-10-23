import type { ConfigService } from "@nestjs/config";

import { buildThrottlers } from "./throttlers";

const configWith = (values: Record<string, unknown>) =>
  ({ get: (k: string) => values[k] }) as unknown as ConfigService;

describe("buildThrottlers default limit (B599)", () => {
  const limitOf = (cfg: ConfigService, name: string) =>
    (buildThrottlers(cfg).find((t) => t.name === name) as { limit: number }).limit;

  it("honours throttle.defaultLimit for the default throttler", () => {
    expect(limitOf(configWith({ "throttle.defaultLimit": 5000 }), "default")).toBe(5000);
  });

  it("falls back to 100 / 60 s when unset or invalid", () => {
    expect(limitOf(configWith({}), "default")).toBe(100);
    expect(limitOf(configWith({ "throttle.defaultLimit": "abc" }), "default")).toBe(100);
  });

  it("leaves the uploads ceiling on its own setting", () => {
    expect(limitOf(configWith({ "throttle.defaultLimit": 5000 }), "uploads")).toBe(1200);
  });
});

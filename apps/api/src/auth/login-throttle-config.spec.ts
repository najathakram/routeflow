import { Logger } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import {
  loginThrottleConfig,
  resolveLoginThrottle,
  __resetLoginThrottleCache,
} from "./login-throttle.config";

// pB10 — login throttle env knob (Wave B README, "Added scope" pB10 section).
// AUTH_LOGIN_THROTTLE_LIMIT / AUTH_LOGIN_THROTTLE_TTL_MS, prod defaults unchanged (10 / 300000).

describe("loginThrottleConfig (pB10 — login throttle env knob)", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AUTH_LOGIN_THROTTLE_LIMIT;
    delete process.env.AUTH_LOGIN_THROTTLE_TTL_MS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // T1: unset env -> production defaults (10 requests / 300000ms = 5 min), matching the
  // existing @Throttle({ default: { ttl: 300_000, limit: 10 } }) on auth.controller.ts:66.
  it("T1 — returns the production defaults (limit 10, ttl 300000) when the env vars are unset", () => {
    expect(loginThrottleConfig(process.env)).toEqual({ limit: 10, ttl: 300000 });
  });

  // T2: env vars set to the brief's example local override -> those exact values, as numbers.
  it("T2 — returns the env-configured limit/ttl as numbers when both vars are set", () => {
    process.env.AUTH_LOGIN_THROTTLE_LIMIT = "1000";
    process.env.AUTH_LOGIN_THROTTLE_TTL_MS = "60000";
    expect(loginThrottleConfig(process.env)).toEqual({ limit: 1000, ttl: 60000 });
  });

  // T3: values that are not whole positive integers must not throw and must fall back to the
  // production defaults. Number.parseInt() accepts a PARTIAL parse, so the underscore-separated
  // forms are the dangerous ones: "300_000" would parse to 300 (a 0.3s window — effectively
  // unlimited brute force) and "1_000" to 1 (a login outage). Both must be rejected outright.
  it.each([
    ["not-a-number", "also-not-a-number"],
    ["1_000", "300_000"],
    ["5abc", "5abc"],
    ["1e3", "1e3"],
  ])(
    "T3 — falls back to the defaults without throwing for non-integer values (%s / %s)",
    (limitValue, ttlValue) => {
      process.env.AUTH_LOGIN_THROTTLE_LIMIT = limitValue;
      process.env.AUTH_LOGIN_THROTTLE_TTL_MS = ttlValue;
      let result: { limit: number; ttl: number } | undefined;
      expect(() => {
        result = loginThrottleConfig(process.env);
      }).not.toThrow();
      expect(result).toEqual({ limit: 10, ttl: 300000 });
    },
  );

  // T3b: surrounding whitespace is tolerated — " 12 " is a whole positive integer.
  it("T3b — trims surrounding whitespace around an otherwise valid integer", () => {
    process.env.AUTH_LOGIN_THROTTLE_LIMIT = " 12 ";
    process.env.AUTH_LOGIN_THROTTLE_TTL_MS = " 60000 ";
    expect(loginThrottleConfig(process.env)).toEqual({ limit: 12, ttl: 60000 });
  });

  // T3c: a rejected value must be visible in the boot log — otherwise the only symptom of the
  // "300_000" typo is either "logins are being brute-forced" or "nobody can log in", with
  // nothing in the logs naming the cause. resolveLoginThrottle() logs once, on the first call.
  it("T3c — warns once (naming the var and the default) when a provided value is rejected", () => {
    __resetLoginThrottleCache();
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      process.env.AUTH_LOGIN_THROTTLE_TTL_MS = "300_000";
      expect(resolveLoginThrottle()).toEqual({ limit: 10, ttl: 300000 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("AUTH_LOGIN_THROTTLE_TTL_MS");
      expect(String(warn.mock.calls[0][0])).toContain("300000");
      // Memoized: a second call must not re-log.
      resolveLoginThrottle();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      __resetLoginThrottleCache();
    }
  });

  // T4: zero/negative values are invalid throttle config and must also fall back to defaults.
  it("T4 — falls back to the defaults for zero or negative values", () => {
    process.env.AUTH_LOGIN_THROTTLE_LIMIT = "0";
    process.env.AUTH_LOGIN_THROTTLE_TTL_MS = "-5";
    expect(loginThrottleConfig(process.env)).toEqual({ limit: 10, ttl: 300000 });
  });

  // T5: static wiring assertion — the login route's @Throttle decorator must be driven by
  // the config module (loginThrottleConfig / resolveLoginThrottle), not a hardcoded literal,
  // per the README's pB10 spec.
  it("T5 — auth.controller.ts's login route references the login-throttle config", () => {
    const controllerPath = path.join(__dirname, "auth.controller.ts");
    const source = fs.readFileSync(controllerPath, "utf8");
    const loginIndex = source.indexOf('@Post("login")');
    expect(loginIndex).toBeGreaterThan(-1);

    // The login route's decorators sit BETWEEN `@Post("login")` and the `async login(` signature
    // (auth.controller.ts: @Post at :63, @Throttle at :66), so the block to scan is the one after
    // the route decorator — not the text before it.
    const sigIndex = source.indexOf("async login(", loginIndex);
    expect(sigIndex).toBeGreaterThan(loginIndex);
    const decoratorBlock = source.slice(loginIndex, sigIndex);
    const throttleMatches = [
      ...decoratorBlock.matchAll(/@Throttle\(([\s\S]*?)\)\s*(?:\/\/[^\n]*)?\n/g),
    ];
    expect(throttleMatches.length).toBeGreaterThan(0);
    const throttleArg = throttleMatches[0][1];

    // Whatever shape it takes, the decorator must not carry a hardcoded ttl/limit VALUE.
    // `ttl: () => resolveLoginThrottle().ttl` is a resolver, not a literal, so the check is
    // on the value that follows the key.
    expect(throttleArg).not.toMatch(/\b(?:ttl|limit)\s*:\s*[\d_]/);

    // Either the throttler-resolvable form (`() => resolveLoginThrottle().limit`, evaluated per
    // request after ConfigModule has loaded apps/api/.env) or the local-const-then-reference
    // shape used by route-optimization's OPTIMIZE_THROTTLE — but a const is legitimate only when
    // it is itself initialised from the config module. Follow the identifier exactly one hop.
    if (!/loginThrottleConfig|resolveLoginThrottle/.test(throttleArg)) {
      const ref = /default:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(throttleArg);
      expect(ref).not.toBeNull();
      const refName = ref ? ref[1] : "";
      expect(source).toMatch(
        new RegExp(
          `\\b(?:const|let|var)\\s+${refName}\\s*=\\s*(?:loginThrottleConfig|resolveLoginThrottle)\\s*\\(`,
        ),
      );
    }
  });

  // T6: resolveLoginThrottle() reads process.env LAZILY (so a value that ConfigModule copies out
  // of apps/api/.env after this module is imported still takes effect) and then MEMOIZES, so the
  // per-request decorator resolver does not re-parse the env on every login.
  it("T6 — resolveLoginThrottle reads the env on first use and memoizes afterwards", () => {
    __resetLoginThrottleCache();
    process.env.AUTH_LOGIN_THROTTLE_LIMIT = "42";
    expect(resolveLoginThrottle().limit).toBe(42);

    // A later env change is ignored until the cache is reset — one read per process.
    process.env.AUTH_LOGIN_THROTTLE_LIMIT = "7";
    expect(resolveLoginThrottle().limit).toBe(42);

    __resetLoginThrottleCache();
    expect(resolveLoginThrottle().limit).toBe(7);
  });

  afterEach(() => {
    __resetLoginThrottleCache();
  });
});

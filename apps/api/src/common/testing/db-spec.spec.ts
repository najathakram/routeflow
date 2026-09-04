/**
 * T4 (R6) — `apps/api/src/common/testing/db-spec.ts` contract.
 *
 * House rule for tests of NEW modules: guarded `require` inside the test body
 * so absence fails on an assertion (`typeof mod.fn` is `"undefined"`), never
 * on an unresolved import. See test-plan.md T4.
 */

describe("db-spec (T4, R6)", () => {
  let mod: any = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("./db-spec");
  } catch {
    mod = {};
  }

  // Call-site fallbacks: the guarded require above protects the module LOAD,
  // but calling a missing export still throws `TypeError: … is not a function`
  // before the assertion runs. These wrappers keep every case failing on its
  // OWN oracle (a wrong value / a missing throw), never on a TypeError.
  const NOT_IMPLEMENTED = "<db-spec not implemented>";
  const requireLocalDatabaseUrl = (env: any): string =>
    typeof mod.requireLocalDatabaseUrl === "function"
      ? mod.requireLocalDatabaseUrl(env)
      : NOT_IMPLEMENTED;
  const describeDb = (name: string, fn: () => void): void => {
    if (typeof mod.describeDb === "function") mod.describeDb(name, fn);
  };

  describe("module shape", () => {
    it("exports requireLocalDatabaseUrl as a function", () => {
      expect(typeof mod.requireLocalDatabaseUrl).toBe("function");
    });

    it("exports describeDb as a function", () => {
      expect(typeof mod.describeDb).toBe("function");
    });
  });

  describe("requireLocalDatabaseUrl(env)", () => {
    it("(a) returns the URL when the host is localhost", () => {
      const url = "postgresql://u:p@localhost:5432/x";
      expect(requireLocalDatabaseUrl({ DATABASE_URL: url })).toBe(url);
    });

    it("(b) throws, message containing the host, for a non-local host", () => {
      const url = "postgresql://u:p@db.example.com:5432/x";
      expect(() => requireLocalDatabaseUrl({ DATABASE_URL: url })).toThrow(/db\.example\.com/);
    });

    it("(c) still throws for a non-local host with RUN_DB_SPECS='ci' — there is no bypass", () => {
      // CI's postgres service is reachable at localhost, so the refusal needs no escape hatch;
      // a `ci` bypass would only disable it in the one lane that runs unattended.
      const url = "postgresql://u:p@db.example.com:5432/x";
      expect(() => requireLocalDatabaseUrl({ DATABASE_URL: url, RUN_DB_SPECS: "ci" })).toThrow(
        /db\.example\.com/,
      );
    });

    it("(d) throws, message containing DATABASE_URL, when it is unset", () => {
      expect(() => requireLocalDatabaseUrl({})).toThrow(/DATABASE_URL/);
    });

    it("(e) returns the URL for the compose host 'postgres'", () => {
      const url = "postgresql://u:p@postgres:5432/x";
      expect(requireLocalDatabaseUrl({ DATABASE_URL: url })).toBe(url);
    });

    it("(f) returns the URL for the IPv6 loopback host '[::1]'", () => {
      // `new URL(...).hostname` yields "[::1]" with brackets — the guard must
      // normalise before the LOCAL_HOSTS lookup.
      const url = "postgresql://u:p@[::1]:5432/x";
      expect(requireLocalDatabaseUrl({ DATABASE_URL: url, RUN_DB_SPECS: "local" })).toBe(url);
    });
  });

  describe("describeDb(name, fn)", () => {
    const originalRunDbSpecs = process.env.RUN_DB_SPECS;

    afterEach(() => {
      jest.restoreAllMocks();
      if (originalRunDbSpecs === undefined) {
        delete process.env.RUN_DB_SPECS;
      } else {
        process.env.RUN_DB_SPECS = originalRunDbSpecs;
      }
    });

    it("throws — never skips — when RUN_DB_SPECS is unset", () => {
      delete process.env.RUN_DB_SPECS;

      // A lane that reports green with zero executed tests is the gap this replaces: the
      // suite must refuse to be collected rather than quietly skip itself.
      const describeSkipSpy = jest
        .spyOn(global.describe, "skip")
        .mockImplementation((() => {}) as any);
      const describeSpy = jest.spyOn(global, "describe").mockImplementation((() => {}) as any);
      (describeSpy as unknown as { skip: typeof describeSkipSpy }).skip = describeSkipSpy;

      const fn = jest.fn();

      expect(() => describeDb("n", fn)).toThrow(/RUN_DB_SPECS/);
      expect(fn).not.toHaveBeenCalled();
      expect(describeSkipSpy).not.toHaveBeenCalled();
      expect(describeSpy).not.toHaveBeenCalled();
    });

    it("invokes describe with fn — and runs it — when RUN_DB_SPECS is 'local'", () => {
      process.env.RUN_DB_SPECS = "local";

      const describeSkipSpy = jest
        .spyOn(global.describe, "skip")
        .mockImplementation((() => {}) as any);
      const describeSpy = jest
        .spyOn(global, "describe")
        .mockImplementation(((_name: string, body: () => void) => body()) as any);
      (describeSpy as unknown as { skip: typeof describeSkipSpy }).skip = describeSkipSpy;

      const fn = jest.fn();
      describeDb("n", fn);

      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(describeSpy.mock.calls[0][0]).toBe("n");
      expect(describeSpy.mock.calls[0][1]).toBe(fn);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(describeSkipSpy).not.toHaveBeenCalled();
    });
  });
});

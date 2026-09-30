import {
  TenantContextGuard,
  TenantContextMissingError,
  readEnforceFlag,
  superAdminCreateExtension,
} from "./tenant-context-guard";

/** SA-619 PR-1: the warn (dark) / throw (enforced) decision, the counter, the de-dup, forSystem. */
describe("TenantContextGuard (SA-619)", () => {
  const make = (enforce: boolean, t0 = 1_000_000) => {
    const warn = jest.fn();
    let now = t0;
    const guard = new TenantContextGuard({ enforce, log: { warn }, now: () => now });
    return { guard, warn, tick: (ms: number) => (now += ms) };
  };

  describe("readEnforceFlag: read once at boot, default dark, unknown => false", () => {
    it.each([
      [undefined, false],
      ["", false],
      ["false", false],
      ["0", false],
      ["maybe", false],
      ["TRUE ", false], // unknown spelling is NOT enforcement
      ["true", true],
      ["1", true],
    ])("TENANT_CONTEXT_ENFORCE=%j => %s", (value, expected) => {
      expect(readEnforceFlag({ TENANT_CONTEXT_ENFORCE: value } as NodeJS.ProcessEnv)).toBe(
        expected,
      );
    });
  });

  describe("dark (enforce=false): warn once, never throw", () => {
    it.each(["ANONYMOUS", "NONE", "SYSTEM"] as const)(
      "a missing context (%s) warns and does not throw",
      (kind) => {
        const { guard, warn } = make(false);
        expect(() => guard.missingContext(kind, "GET /x")).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).toContain("TENANT_CONTEXT_MISSING");
        expect(line).toContain(kind);
        expect(line).toContain("GET /x");
      },
    );

    it("the warn carries a bounded stack (top 5 frames) and no data", () => {
      const { guard, warn } = make(false);
      guard.missingContext("NONE", "job:x.y");
      const line = String(warn.mock.calls[0][0]);
      const frames = line.split("\n").filter((l) => /^\s+at /.test(l));
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.length).toBeLessThanOrEqual(5);
    });

    it("the same call site warns once per window, but the counter counts every hit", () => {
      const { guard, warn, tick } = make(false);
      const hit = () => guard.missingContext("NONE", "GET /same");
      for (let i = 0; i < 50; i++) hit();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(guard.count("MISSING")).toBe(50);
      tick(61_000);
      hit();
      expect(warn).toHaveBeenCalledTimes(2); // a new window logs again
    });

    it("different routes are different sites", () => {
      const { guard, warn } = make(false);
      guard.missingContext("NONE", "GET /a");
      guard.missingContext("NONE", "GET /b");
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  describe("enforced: throws TenantContextMissingError", () => {
    it.each(["ANONYMOUS", "NONE", "SYSTEM"] as const)("a missing context (%s) throws", (kind) => {
      const { guard } = make(true);
      expect(() => guard.missingContext(kind, "GET /x")).toThrow(TenantContextMissingError);
    });
    it("a super admin tenant-owned create without a tenantId throws", () => {
      const { guard } = make(true);
      expect(() => guard.superAdminCreate("Customer", "create")).toThrow(TenantContextMissingError);
    });
    it("the error says what happened and names no data", () => {
      const { guard } = make(true);
      try {
        guard.missingContext("ANONYMOUS", "GET /x");
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(TenantContextMissingError);
        expect((e as Error).message).toMatch(/forSystem/);
      }
    });
  });

  describe("super admin tenant-owned creates (dark)", () => {
    it("warns once per model+operation and still lets the call through", () => {
      const { guard, warn } = make(false);
      guard.superAdminCreate("Customer", "create");
      guard.superAdminCreate("Customer", "create");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("Customer");
      expect(guard.count("SUPER_ADMIN_CREATE")).toBe(2);
    });
  });

  describe("forSystem(reason)", () => {
    it("records the reason, never warns, never throws (dark or enforced)", () => {
      for (const enforce of [false, true]) {
        const { guard, warn } = make(enforce);
        expect(() => guard.system("billing-cron: cross-tenant trial expiry")).not.toThrow();
        expect(warn).not.toHaveBeenCalled();
        expect(guard.systemReasons()).toEqual({ "billing-cron: cross-tenant trial expiry": 1 });
      }
    });
    it.each(["", "   ", undefined, null, 7] as const)(
      "a missing/blank/non-string reason (%j) throws",
      (reason) => {
        const { guard } = make(false);
        expect(() => guard.system(reason as never)).toThrow(/reason/);
      },
    );
  });
});

describe("superAdminCreateExtension (SA-619)", () => {
  const run = async (model: string, operation: string, args: any, guard: any) => {
    const query = jest.fn().mockResolvedValue("ok");
    const ext: any = superAdminCreateExtension(guard, (m) => m === "Customer");
    const out = await ext.query.$allModels.$allOperations({ model, operation, args, query });
    return { out, query };
  };
  const guardSpy = () => ({ superAdminCreate: jest.fn() });

  it("a tenant-owned create with no tenantId reports and still runs the query", async () => {
    const g = guardSpy();
    const { out, query } = await run("Customer", "create", { data: { name: "x" } }, g);
    expect(g.superAdminCreate).toHaveBeenCalledWith("Customer", "create", "SUPER_ADMIN");
    expect(query).toHaveBeenCalled();
    expect(out).toBe("ok");
  });
  it("an explicit tenantId (data.tenantId, or every createMany row) does not report", async () => {
    const g = guardSpy();
    await run("Customer", "create", { data: { tenantId: "t-1" } }, g);
    await run("Customer", "createMany", { data: [{ tenantId: "t" }, { tenantId: "t" }] }, g);
    await run(
      "Customer",
      "upsert",
      { where: { id: "1" }, create: { tenantId: "t" }, update: {} },
      g,
    );
    expect(g.superAdminCreate).not.toHaveBeenCalled();
  });
  it("one createMany row without a tenantId reports", async () => {
    const g = guardSpy();
    await run("Customer", "createMany", { data: [{ tenantId: "t" }, {}] }, g);
    expect(g.superAdminCreate).toHaveBeenCalledWith("Customer", "createMany", "SUPER_ADMIN");
  });
  it("an explicit tenantId: null is a deliberate PLATFORM row (system config, global settings): not reported", async () => {
    const g = guardSpy();
    await run("Customer", "create", { data: { key: "k", tenantId: null } }, g);
    await run("Customer", "createMany", { data: [{ tenantId: null }, { tenantId: "t" }] }, g);
    await run(
      "Customer",
      "upsert",
      { where: { id: "1" }, create: { tenantId: null }, update: {} },
      g,
    );
    expect(g.superAdminCreate).not.toHaveBeenCalled();
    // ...but an ABSENT key is still the L-124 class
    await run("Customer", "create", { data: { key: "k" } }, g);
    expect(g.superAdminCreate).toHaveBeenCalledTimes(1);
  });
  it("the report names the caller's kind, not always SUPER_ADMIN", () => {
    const warn = jest.fn();
    const guard = new TenantContextGuard({ enforce: false, log: { warn } });
    guard.superAdminCreate("Customer", "create", "ANONYMOUS");
    expect(String(warn.mock.calls[0][0])).toContain("ANONYMOUS");
    expect(String(warn.mock.calls[0][0])).not.toContain(
      "SUPER_ADMIN_CREATE model=Customer op=create kind=SUPER_ADMIN",
    );
  });
  it("a model that is not tenant-owned, and every read, never report", async () => {
    const g = guardSpy();
    await run("Tenant", "create", { data: {} }, g);
    await run("Customer", "findMany", { where: {} }, g);
    await run("Customer", "update", { where: { id: "1" }, data: {} }, g);
    expect(g.superAdminCreate).not.toHaveBeenCalled();
  });
});

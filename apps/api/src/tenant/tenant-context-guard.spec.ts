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

    it("the call site is only captured when a warn can actually log (no stack per deduplicated hit)", () => {
      const { guard, warn, tick } = make(false);
      const where = jest.fn().mockReturnValue("GET /hot");
      for (let i = 0; i < 200; i++) guard.missingContext("NONE", where);
      expect(where).toHaveBeenCalledTimes(1); // one capture, 199 free hits
      expect(warn).toHaveBeenCalledTimes(1);
      expect(guard.count("MISSING")).toBe(200); // every hit still counted
      tick(61_000);
      guard.missingContext("NONE", where);
      expect(where).toHaveBeenCalledTimes(2); // a new window captures again
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("enforced: the site is captured (the thrown error names it)", () => {
      const { guard } = make(true);
      const where = jest.fn().mockReturnValue("GET /hot");
      expect(() => guard.missingContext("NONE", where)).toThrow(/GET \/hot/);
      expect(where).toHaveBeenCalledTimes(1);
    });

    it("different routes are different sites (once the per-kind capture gap has passed)", () => {
      const { guard, warn, tick } = make(false);
      guard.missingContext("NONE", "GET /a");
      tick(1_500);
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
  it("{ tenantId: undefined } is NOT a tenant: Prisma writes a NULL-tenant row for it (the L-124 class)", async () => {
    const g = guardSpy();
    await run("Customer", "create", { data: { name: "x", tenantId: undefined } }, g);
    await run("Customer", "createMany", { data: [{ tenantId: "t" }, { tenantId: undefined }] }, g);
    await run(
      "Customer",
      "upsert",
      { where: { id: "1" }, create: { tenantId: undefined }, update: {} },
      g,
    );
    expect(g.superAdminCreate).toHaveBeenCalledTimes(3);
  });
  it("a model that is not tenant-owned, and every read, never report", async () => {
    const g = guardSpy();
    await run("Tenant", "create", { data: {} }, g);
    await run("Customer", "findMany", { where: {} }, g);
    await run("Customer", "update", { where: { id: "1" }, data: {} }, g);
    expect(g.superAdminCreate).not.toHaveBeenCalled();
  });
});

describe("TenantContextGuard.stats (SA-619 PR-2a: the counters are readable)", () => {
  const make = (enforce = false, t0 = 1_000_000) => {
    let now = t0;
    const guard = new TenantContextGuard({ enforce, log: { warn: jest.fn() }, now: () => now });
    return { guard, tick: (ms: number) => (now += ms), t0 };
  };

  it("reports the flag, the boot time, totals by violation, by kind, and the reasons, with no data", () => {
    const { guard, t0, tick } = make(false);
    guard.missingContext("ANONYMOUS", "a.ts:1");
    tick(2_000);
    guard.missingContext("ANONYMOUS", "b.ts:2");
    guard.missingContext("NONE", "c.ts:3");
    guard.superAdminCreate("Customer", "create", "SUPER_ADMIN");
    guard.system("billing-cron: cross-tenant trial expiry");
    const st = guard.stats();
    expect(st.enforce).toBe(false);
    expect(st.since).toBe(new Date(t0).toISOString());
    expect(st.counts).toEqual({
      MISSING: 3,
      SUPER_ADMIN_CREATE: 1,
      NESTED_CROSS_TENANT: 0,
      NESTED_DEPTH: 0,
    });
    expect(st.byKind).toEqual({ ANONYMOUS: 2, NONE: 1, SUPER_ADMIN: 1 });
    expect(st.systemReasons).toEqual({ "billing-cron: cross-tenant trial expiry": 1 });
  });

  it("lists the noisiest sites first (site keys only: no stack, no data), bounded, with an overflow bucket", () => {
    const { guard, tick } = make(false);
    for (let i = 0; i < 5; i++) {
      guard.missingContext("NONE", "hot.ts:9");
      tick(2_000);
    }
    guard.missingContext("NONE", "cold.ts:1");
    const st = guard.stats();
    expect(st.sites[0]).toEqual({ site: "MISSING|NONE|hot.ts:9", count: 5 });
    expect(JSON.stringify(st)).not.toMatch(/\n\s+at /); // never a stack
    // bounded: > MAX_SITES distinct sites collapse into "other" while the totals stay exact
    for (let i = 0; i < 250; i++) {
      tick(2_000);
      guard.missingContext("ANONYMOUS", `s${i}.ts:1`);
    }
    const big = guard.stats();
    expect(big.sites.length).toBeLessThanOrEqual(101);
    expect(big.counts.MISSING).toBe(5 + 1 + 250);
    expect(big.sites.some((s) => s.site === "other")).toBe(true);
  });

  it("statsLine is one structured log line carrying the same numbers (zero is logged too: '72 h of zero warns' is readable)", () => {
    const { guard } = make(false);
    const zero = guard.statsLine();
    expect(zero.startsWith("TENANT_CONTEXT_STATS ")).toBe(true);
    expect(JSON.parse(zero.slice("TENANT_CONTEXT_STATS ".length)).counts).toEqual({
      MISSING: 0,
      SUPER_ADMIN_CREATE: 0,
      NESTED_CROSS_TENANT: 0,
      NESTED_DEPTH: 0,
    });
    guard.missingContext("NONE", "x.ts:1");
    expect(JSON.parse(guard.statsLine().slice("TENANT_CONTEXT_STATS ".length)).counts.MISSING).toBe(
      1,
    );
  });

  it("counts the nested-write repairs too (SA-620c)", () => {
    const { guard } = make(false);
    guard.nestedViolation("CROSS_TENANT_CHILD", "VendorBillItem at data.items.create");
    guard.nestedViolation(
      "DEPTH",
      "nested write exceeds the depth limit of 8 relations at data.a.b",
    );
    const st = guard.stats();
    expect(st.counts.NESTED_CROSS_TENANT).toBe(1);
    expect(st.counts.NESTED_DEPTH).toBe(1);
  });

  it("nested repairs are located too: they appear in stats().sites (index-free), not only in the totals", () => {
    const { guard } = make(false);
    guard.nestedViolation("CROSS_TENANT_CHILD", "VendorBillItem at data.items.createMany.data[]");
    expect(guard.stats().sites).toContainEqual({
      site: "NESTED_CROSS_TENANT|VendorBillItem at data.items.createMany.data[]",
      count: 1,
    });
  });

  it("forSystem reasons are bounded: a long reason is truncated and distinct reasons cap at 200 (+ other)", () => {
    const { guard } = make(false);
    guard.system("x".repeat(500));
    expect(Object.keys(guard.systemReasons())[0].length).toBeLessThanOrEqual(120);
    for (let i = 0; i < 300; i++) guard.system(`reason number ${i}`);
    const r = guard.systemReasons();
    expect(Object.keys(r).length).toBeLessThanOrEqual(201);
    expect(r.other).toBeGreaterThan(0);
  });

  it("enforced mode counts too (the throw still happens)", () => {
    const { guard } = make(true);
    expect(() => guard.missingContext("NONE", "x.ts:1")).toThrow();
    expect(guard.stats().counts.MISSING).toBe(1);
    expect(guard.stats().enforce).toBe(true);
  });
});

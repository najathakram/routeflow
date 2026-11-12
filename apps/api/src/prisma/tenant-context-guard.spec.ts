import * as fs from "fs";
import * as path from "path";
import {
  createTenantContextGuard,
  readEnforcementFlag,
  TenantContextMissingError,
} from "./tenant-context-guard";
import type { TenantContextKind } from "../tenant/tenant-context.service";
import {
  buildRelationIndex,
  findNestedTenantGaps,
  stampNestedTenant,
} from "./tenant-nested-walker";

/**
 * SA-1105 rows K-1, K-7, K-8, K-9 (the guard as a pure module). Each row drives `createTenantContextGuard` with an
 * injected clock, log and stack, so nothing here reads the real clock or the real flag.
 */
const KINDS: TenantContextKind[] = ["TENANT", "SUPER_ADMIN", "ANONYMOUS", "NONE", "SYSTEM"];
const SITE = ["at LowStock.sweep (apps/api/src/x/y.ts:10:5)", "at Object.<anonymous> (z.ts:1:1)"];

function make(opts: { enforce?: boolean } = {}) {
  const lines: string[] = [];
  let clock = 1_000_000;
  const guard = createTenantContextGuard({
    enforce: opts.enforce ?? false,
    log: { warn: (m) => lines.push(m) },
    now: () => clock,
    frames: () => SITE,
    summaryMs: 0,
  });
  return { guard, lines, tick: (ms: number) => (clock += ms) };
}

const NO_TENANT = { name: "acme" };

describe("K-1 the kind matrix: a tenant-owned write with no tenantId", () => {
  const WRITES = [
    ["create", NO_TENANT],
    ["createMany", [NO_TENANT, { name: "b", tenantId: "t1" }]],
    ["createManyAndReturn", [{ name: "a", tenantId: "t1" }, NO_TENANT]],
    ["upsert", NO_TENANT],
  ] as const;

  for (const kind of KINDS) {
    for (const [op, data] of WRITES) {
      it(`${kind} ${op}: ${kind === "SYSTEM" ? "never reports" : "reports once, counter +1, never throws"}`, () => {
        const { guard } = make();
        const out = guard.checkWrite(kind, "Customer", op, data);
        if (kind === "SYSTEM") {
          expect(out).toEqual({ ok: true });
          expect(guard.counts()).toEqual({});
        } else {
          expect(out.ok).toBe(false);
          expect(guard.counts()).toEqual({ [`${kind}|Customer|${op}`]: 1 });
        }
      });
    }
  }

  it("TENANT with the id injected is ok (the belt-and-braces case never fires)", () => {
    const { guard } = make();
    expect(guard.checkWrite("TENANT", "Customer", "create", { name: "a", tenantId: "t1" })).toEqual(
      { ok: true },
    );
    expect(guard.counts()).toEqual({});
  });

  it("a `tenant` relation names the tenant too; null, undefined and the empty string do not", () => {
    const { guard } = make();
    expect(
      guard.checkWrite("SUPER_ADMIN", "Customer", "create", { tenant: { connect: { id: "t1" } } })
        .ok,
    ).toBe(true);
    for (const bad of [null, undefined, ""]) {
      expect(guard.checkWrite("SUPER_ADMIN", "Customer", "create", { tenantId: bad }).ok).toBe(
        false,
      );
    }
  });

  it("a read reports for NONE and ANONYMOUS only (a SUPER_ADMIN reads unscoped by design)", () => {
    const { guard } = make();
    expect(guard.checkRead("NONE", "Customer").ok).toBe(false);
    expect(guard.checkRead("ANONYMOUS", "Customer").ok).toBe(false);
    for (const k of ["SUPER_ADMIN", "SYSTEM", "TENANT"] as const) {
      expect(guard.checkRead(k, "Customer")).toEqual({ ok: true });
    }
    expect(guard.counts()).toEqual({ "NONE|Customer|read": 1, "ANONYMOUS|Customer|read": 1 });
  });
});

describe("K-7 the log rate: a hot loop cannot flood the log", () => {
  it("1000 hits from one call site inside one second count 1000 and log at most one line", () => {
    const { guard, lines } = make();
    for (let i = 0; i < 1000; i++) guard.checkWrite("SUPER_ADMIN", "Customer", "create", NO_TENANT);
    expect(guard.counts()["SUPER_ADMIN|Customer|create"]).toBe(1000);
    expect(lines.filter((l) => l.startsWith("TENANT_CONTEXT_MISSING kind="))).toHaveLength(1);
  });

  it("the same site logs again one second later, and carries no data, no ids and at most 5 frames", () => {
    const { guard, lines, tick } = make();
    guard.checkWrite("SUPER_ADMIN", "Customer", "create", { secret: "s3cr3t", tenantId: null });
    tick(1_000);
    guard.checkWrite("SUPER_ADMIN", "Customer", "create", NO_TENANT);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^TENANT_CONTEXT_MISSING kind=SUPER_ADMIN model=Customer op=create/);
    expect(lines.join("\n")).not.toMatch(/s3cr3t|acme/);
    expect(lines[0].split("\n").length).toBeLessThanOrEqual(1 + 5);
  });

  it("the summary line is one JSON line and exists only when the counter is non-empty", () => {
    const { guard } = make();
    expect(guard.summary()).toBeNull();
    guard.checkWrite("NONE", "Order", "create", NO_TENANT);
    expect(guard.summary()).toBe('TENANT_CONTEXT_MISSING_SUMMARY {"NONE|Order|create":1}');
  });
});

describe("B1285 the capture gate is keyed by the call place, with a global budget", () => {
  const hit = (g: ReturnType<typeof make>["guard"], model: string, where?: string) =>
    g.checkWrite("SUPER_ADMIN", model, "create", NO_TENANT, undefined, where);
  const missing = (lines: string[]) =>
    lines.filter((l) => l.startsWith("TENANT_CONTEXT_MISSING kind="));

  it("B5-1: a hot route does not hide another route with the same kind, model, op and code site", () => {
    const { guard, lines } = make();
    for (let i = 0; i < 1000; i++) hit(guard, "Customer", "OrdersController.create");
    hit(guard, "Customer", "billing-cron.expireTrials");
    const logged = missing(lines);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("at=OrdersController.create");
    expect(logged[1]).toContain("at=billing-cron.expireTrials");
    expect(guard.counts()["SUPER_ADMIN|Customer|create"]).toBe(1001);
  });

  it("B5-2: 50 distinct keys in one second capture at most 20 stacks, every counter is exact, and the next second catches up", () => {
    const { guard, lines, tick } = make();
    const keys = Array.from({ length: 50 }, (_, i) => `Model${i}`);
    for (const m of keys) hit(guard, m, `${m}Ctl.handler`);
    expect(missing(lines)).toHaveLength(20);
    for (const m of keys) expect(guard.counts()[`SUPER_ADMIN|${m}|create`]).toBe(1);
    // An over-budget key is not gated, so its next hit captures: the starved keys (30..49) are caught first here.
    tick(1_000);
    for (const m of [...keys].reverse()) hit(guard, m, `${m}Ctl.handler`);
    expect(missing(lines)).toHaveLength(40);
    for (const m of keys) expect(guard.counts()[`SUPER_ADMIN|${m}|create`]).toBe(2);
    expect(new Set(missing(lines).map((l) => l.split("\n")[0])).size).toBe(40);
  });

  it("B5-8: a key starved by the budget is not gated, so its next hit after the window rolls captures", () => {
    const { guard, lines, tick } = make();
    for (let i = 0; i < 20; i++) hit(guard, `Fill${i}`, `Fill${i}Ctl.handler`);
    expect(missing(lines)).toHaveLength(20);
    tick(1);
    hit(guard, "Starved", "StarvedCtl.handler"); // over budget: counted, not captured, not gated
    expect(missing(lines)).toHaveLength(20);
    tick(999); // the window opened at t0 rolls at t0 + 1000: 999 ms after the starved hit
    hit(guard, "Starved", "StarvedCtl.handler");
    expect(missing(lines)).toHaveLength(21);
    expect(missing(lines)[20]).toContain("model=Starved");
    expect(guard.counts()["SUPER_ADMIN|Starved|create"]).toBe(2);
  });

  it("B5-3: one site at 1000 hits per second still logs one line (K-7 unchanged)", () => {
    const { guard, lines } = make();
    for (let i = 0; i < 1000; i++) hit(guard, "Customer", "OrdersController.create");
    expect(missing(lines)).toHaveLength(1);
  });

  it("B5-4: a raw path is never a gate key or a log field", () => {
    const { guard, lines } = make();
    hit(guard, "Customer", "/orders/123");
    hit(guard, "Customer", "/orders/456?x=1");
    const logged = missing(lines);
    expect(logged).toHaveLength(1);
    expect(logged.join("\n")).not.toMatch(/at=|123|456|\/orders/);
  });
});

describe("K-8 nested-create detection (from the parent's call site; the walker names the gaps)", () => {
  // The harness only: Order.items -> OrderItem, tenant-owned. The guard receives the gaps the walker found.
  const field = (name: string, kind: string, type = "String", from: string[] = []) => ({
    name,
    kind,
    type,
    isList: kind === "object",
    relationFromFields: from,
  });
  const index = buildRelationIndex([
    { name: "Order", fields: [field("tenantId", "scalar"), field("items", "object", "OrderItem")] },
    { name: "OrderItem", fields: [field("tenantId", "scalar")] },
  ] as any);
  const target = (model: string, data: unknown) => findNestedTenantGaps(model, data, index);

  it("a parent create with a nested create and no child tenantId reports op nested-create", () => {
    const { guard, lines } = make();
    const out = guard.checkWrite(
      "TENANT",
      "Order",
      "create",
      { tenantId: "t1", items: { create: [{ sku: "a" }] } },
      target("Order", { items: { create: [{ sku: "a" }] } }),
    );
    expect(out).toEqual({ ok: false, reason: "TENANT_CONTEXT_MISSING", ops: ["nested-create"] });
    expect(guard.counts()).toEqual({ "TENANT|Order.items|nested-create": 1 });
    expect(lines[0]).toMatch(/op=nested-create/);
  });

  it("a child that names its tenant, a non-tenant child and a createMany child are read the same way", () => {
    const { guard } = make();
    expect(
      guard.checkWrite(
        "TENANT",
        "Order",
        "create",
        { tenantId: "t1", items: { create: { tenantId: "t1" } } },
        target("Order", { items: { create: { tenantId: "t1" } } }),
      ).ok,
    ).toBe(true);
    expect(
      guard.checkWrite(
        "TENANT",
        "Order",
        "create",
        { tenantId: "t1", notes: { create: { x: 1 } } },
        target("Order", { notes: { create: { x: 1 } } }),
      ).ok,
    ).toBe(true);
    expect(
      guard.checkWrite(
        "TENANT",
        "Order",
        "create",
        { tenantId: "t1", items: { createMany: { data: [{ sku: "a" }] } } },
        target("Order", { items: { createMany: { data: [{ sku: "a" }] } } }),
      ).ok,
    ).toBe(false);
  });
});

describe("SA-1110 W-0, W-5, W-6, W-8: the guard reads the walker's gaps at every depth", () => {
  const f = (name: string, kind: string, type = "String", from: string[] = []) => ({
    name,
    kind,
    type,
    isList: kind === "object",
    relationFromFields: from,
  });
  const deep = buildRelationIndex([
    { name: "A", fields: [f("tenantId", "scalar"), f("items", "object", "B")] },
    { name: "B", fields: [f("tenantId", "scalar"), f("sub", "object", "C")] },
    { name: "C", fields: [f("tenantId", "scalar")] },
  ] as any);
  const gapsOf = (data: unknown) => findNestedTenantGaps("A", data, deep);

  it("W-0: TENANT create of a VendorBill with an unstamped item throws when enforced; stamped first, it does not", () => {
    const on = make({ enforce: true });
    const data = { tenantId: "t1", items: { create: [{ qty: 1 }] } };
    const bill = (d: unknown) =>
      on.guard.checkWrite("TENANT", "VendorBill", "create", d, gapsFor(d));
    const gapsFor = (d: unknown) => findNestedTenantGaps("VendorBill", d);
    expect(() => bill(data)).toThrow(TenantContextMissingError);
    expect(() => bill(stampNestedTenant("VendorBill", data, "t1"))).not.toThrow();
  });

  it("W-5: a depth-2 gap under NONE is reported as A.items.sub, one counter key", () => {
    const { guard } = make();
    const data = { items: { create: [{ tenantId: "t1", sub: { create: [{ q: 1 }] } }] } };
    const out = guard.checkWrite("NONE", "A", "create", { tenantId: "t1", ...data }, gapsOf(data));
    expect(out).toEqual({ ok: false, reason: "TENANT_CONTEXT_MISSING", ops: ["nested-create"] });
    expect(guard.counts()).toEqual({ "NONE|A.items.sub|nested-create": 1 });
  });

  it("W-6: connectOrCreate and nested upsert create children are reported", () => {
    for (const items of [
      { connectOrCreate: [{ where: {}, create: { q: 1 } }] },
      { upsert: [{ where: {}, create: { q: 1 }, update: {} }] },
    ]) {
      const { guard } = make();
      const out = guard.checkWrite(
        "NONE",
        "A",
        "create",
        { tenantId: "t1", items },
        gapsOf({ items }),
      );
      expect(out.ok).toBe(false);
      expect(guard.counts()).toEqual({ "NONE|A.items|nested-create": 1 });
    }
  });

  it("W-8: SUPER_ADMIN nested create with no tenant anywhere is reported at every depth, never stamped", () => {
    const { guard } = make();
    const data = { items: { create: [{ sub: { create: [{ q: 1 }] } }] } };
    const out = guard.checkWrite("SUPER_ADMIN", "A", "create", data, gapsOf(data));
    expect(out.ok).toBe(false);
    expect(guard.counts()).toEqual({
      "SUPER_ADMIN|A|create": 1,
      "SUPER_ADMIN|A.items|nested-create": 1,
      "SUPER_ADMIN|A.items.sub|nested-create": 1,
    });
  });

  it("a gap list that is empty adds nothing, and an update-style report needs no top-level row", () => {
    const { guard } = make();
    expect(guard.checkWrite("TENANT", "A", "create", { tenantId: "t1" }, [])).toEqual({ ok: true });
    expect(guard.checkNested("TENANT", ["A.items.sub"])).toEqual({
      ok: false,
      reason: "TENANT_CONTEXT_MISSING",
      ops: ["nested-create"],
    });
    expect(guard.checkNested("SYSTEM", ["A.items.sub"])).toEqual({ ok: true });
    expect(guard.counts()).toEqual({ "TENANT|A.items.sub|nested-create": 1 });
  });
});

describe("K-9 the enforcement flag: only the exact string 'on' throws", () => {
  it.each([undefined, "", "off", "ON", "ON ", "on ", "true", "1", "yes"])("%j stays dark", (v) => {
    expect(readEnforcementFlag({ TENANT_CONTEXT_ENFORCEMENT: v } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("'on' enforces, and a dark guard never throws for any kind or op", () => {
    expect(readEnforcementFlag({ TENANT_CONTEXT_ENFORCEMENT: "on" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
    const dark = make();
    for (const kind of KINDS) {
      expect(() => dark.guard.checkWrite(kind, "Customer", "create", NO_TENANT)).not.toThrow();
      expect(() => dark.guard.checkRead(kind, "Customer")).not.toThrow();
    }
    const on = make({ enforce: true });
    expect(() => on.guard.checkWrite("SUPER_ADMIN", "Customer", "create", NO_TENANT)).toThrow(
      TenantContextMissingError,
    );
    expect(() => on.guard.checkWrite("SYSTEM", "Customer", "create", NO_TENANT)).not.toThrow();
  });

  it("the process guard reads the flag once at boot and no deploy file sets it in slice 1", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TENANT_CONTEXT_ENFORCING } = require("./tenant-context-guard");
    expect(TENANT_CONTEXT_ENFORCING).toBe(false);
    const root = path.join(__dirname, "..", "..", "..", "..");
    const files = [
      "docker-compose.yml",
      "apps/api/railway.toml",
      "apps/api/Dockerfile",
      "apps/api/.env.example",
      ...fs
        .readdirSync(path.join(root, ".github", "workflows"))
        .map((f) => path.join(".github", "workflows", f)),
    ];
    const setters = files.filter(
      (f) =>
        fs.existsSync(path.join(root, f)) &&
        fs.readFileSync(path.join(root, f), "utf8").includes("TENANT_CONTEXT_ENFORCEMENT"),
    );
    expect(setters).toEqual([]);
  });
});

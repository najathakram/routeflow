import * as fs from "fs";
import * as path from "path";
import {
  createTenantContextGuard,
  readEnforcementFlag,
  TenantContextMissingError,
} from "./tenant-context-guard";
import type { TenantContextKind } from "../tenant/tenant-context.service";

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

describe("K-8 nested-create detection (one level, from the parent's call site)", () => {
  const target = (parent: string, key: string) =>
    parent === "Order" && key === "items" ? "OrderItem" : undefined;

  it("a parent create with a nested create and no child tenantId reports op nested-create", () => {
    const { guard, lines } = make();
    const out = guard.checkWrite(
      "TENANT",
      "Order",
      "create",
      { tenantId: "t1", items: { create: [{ sku: "a" }] } },
      target,
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
        target,
      ).ok,
    ).toBe(true);
    expect(
      guard.checkWrite(
        "TENANT",
        "Order",
        "create",
        { tenantId: "t1", notes: { create: { x: 1 } } },
        target,
      ).ok,
    ).toBe(true);
    expect(
      guard.checkWrite(
        "TENANT",
        "Order",
        "create",
        { tenantId: "t1", items: { createMany: { data: [{ sku: "a" }] } } },
        target,
      ).ok,
    ).toBe(false);
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

import { Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { tenantContextCounts } from "./tenant-context-guard";
import { TenantContextService, type TenantContextKind } from "../tenant/tenant-context.service";

/**
 * SA-1105 rows K-2, K-5, K-6 (and the forSystem door): `forTenant()` / `tenantTransaction()` with no tenant stay the
 * UNSCOPED client, run every query exactly as given, and report a tenant-owned access or write to the one guard. The
 * REAL prototype methods run against fakes (the `prisma-isolation.spec.ts` shape); nothing here configures a mock to
 * already agree with the code.
 */
const proto = PrismaService.prototype as unknown as Record<string, any>;

function host(ctx: TenantContextService) {
  return {
    tenantCtx: ctx,
    getTenantId: () => ctx.getOrNull(),
    $extends: (ext: any) => ({ __extension: ext }),
    forTenant: proto.forTenant,
    forSystem: proto.forSystem,
    _observeExtension: proto._observeExtension,
    _observeTx: proto._observeTx,
    _tenantExtension: proto._tenantExtension,
    _wrapTxWithTenant: proto._wrapTxWithTenant,
    tenantTransaction: proto.tenantTransaction,
  } as any;
}

const handler = (h: any) => h.forTenant().__extension.query.$allModels.$allOperations;
const hits = () => tenantContextCounts();
const delta = (before: Record<string, number>, key: string) =>
  (hits()[key] ?? 0) - (before[key] ?? 0);

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

const asKind = (
  ctx: TenantContextService,
  kind: "SUPER_ADMIN" | "ANONYMOUS",
  fn: () => Promise<unknown>,
) => ctx.run(null, fn, kind, "OrdersController.create");

describe("K-2 the #2872 scenario: a SUPER_ADMIN create of a tenant-owned model with no tenantId", () => {
  it("is still written exactly as given (dark), reported once, and the log holds no data", async () => {
    const ctx = new TenantContextService();
    const query = jest.fn(async (a: any) => a);
    const before = { ...hits() };
    await asKind(ctx, "SUPER_ADMIN", () =>
      handler(host(ctx))({
        model: "Customer",
        operation: "create",
        args: { data: { businessName: "Acme Foods", contactName: "Pat" } },
        query,
      }),
    );
    expect(query).toHaveBeenCalledWith({
      data: { businessName: "Acme Foods", contactName: "Pat" },
    });
    expect(delta(before, "SUPER_ADMIN|Customer|create")).toBe(1);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(
      lines.filter((l) => l.startsWith("TENANT_CONTEXT_MISSING kind=SUPER_ADMIN model=Customer")),
    ).toHaveLength(1);
    expect(lines.join("\n")).not.toMatch(/Acme|Pat/);
    expect(lines.join("\n")).toMatch(/at=OrdersController\.create/);
  });

  it("a SUPER_ADMIN read of the same model is not reported (unscoped by design) and a non-tenant model never is", async () => {
    const ctx = new TenantContextService();
    const query = jest.fn(async () => []);
    const before = { ...hits() };
    await asKind(ctx, "SUPER_ADMIN", async () => {
      await handler(host(ctx))({ model: "Customer", operation: "findMany", args: {}, query });
      await handler(host(ctx))({
        model: "PlatformConfig",
        operation: "create",
        args: { data: {} },
        query,
      });
    });
    expect(hits()).toEqual(before);
  });
});

describe("K-5 a cron body that calls forTenant() without run (kind NONE)", () => {
  it("reads unscoped, as today, and the report names the access", async () => {
    const ctx = new TenantContextService();
    expect(ctx.kind()).toBe("NONE");
    const query = jest.fn(async (a: any) => a);
    const before = { ...hits() };
    await handler(host(ctx))({
      model: "Order",
      operation: "findMany",
      args: { where: { status: "NEW" } },
      query,
    });
    expect(query).toHaveBeenCalledWith({ where: { status: "NEW" } }); // not scoped, not changed
    expect(delta(before, "NONE|Order|read")).toBe(1);
    expect(warn.mock.calls.join("\n")).toMatch(
      /TENANT_CONTEXT_MISSING kind=NONE model=Order op=read/,
    );
  });

  it("an ANONYMOUS request is reported the same way; a TENANT request is scoped and silent", async () => {
    const ctx = new TenantContextService();
    const query = jest.fn(async (a: any) => a);
    const before = { ...hits() };
    await asKind(ctx, "ANONYMOUS", () =>
      handler(host(ctx))({ model: "Order", operation: "count", args: {}, query }),
    );
    expect(delta(before, "ANONYMOUS|Order|read")).toBe(1);
    const scoped = await ctx.run("t1", async () => {
      const ext = host(ctx).forTenant().__extension.query.$allModels.$allOperations;
      return ext({ model: "Order", operation: "create", args: { data: { x: 1 } }, query });
    });
    expect(scoped.data).toEqual({ x: 1, tenantId: "t1" });
    expect(hits()).toEqual({
      ...before,
      "ANONYMOUS|Order|read": (before["ANONYMOUS|Order|read"] ?? 0) + 1,
    });
  });
});

describe("K-6 the same tenantless write through tenantTransaction's raw tx (SA-619a)", () => {
  function txHost(ctx: TenantContextService) {
    const create = jest.fn(async (a: any) => a);
    const rawTx = { customer: { create }, $executeRaw: jest.fn(async () => 0) };
    const h = host(ctx);
    h.$transaction = (fn: (tx: any) => Promise<any>) => fn(rawTx);
    return { h, create };
  }

  it("is reported by the same guard under the same key as the extension, and runs unchanged", async () => {
    const ctx = new TenantContextService();
    const { h, create } = txHost(ctx);
    const before = { ...hits() };
    await asKind(ctx, "SUPER_ADMIN", () =>
      h.tenantTransaction((tx: any) => tx.customer.create({ data: { businessName: "x" } })),
    );
    expect(create).toHaveBeenCalledWith({ data: { businessName: "x" } });
    expect(delta(before, "SUPER_ADMIN|Customer|create")).toBe(1);
  });

  it("a tenant transaction injects the id and reports nothing", async () => {
    const ctx = new TenantContextService();
    const { h, create } = txHost(ctx);
    const before = { ...hits() };
    await ctx.run("t1", () =>
      h.tenantTransaction((tx: any) => tx.customer.create({ data: { businessName: "x" } })),
    );
    expect(create).toHaveBeenCalledWith({ data: { businessName: "x", tenantId: "t1" } });
    expect(hits()).toEqual(before);
  });
});

describe("forSystem: the deliberate unscoped door", () => {
  it("returns the client itself, and refuses a reason that is empty or shorter than 12 characters", () => {
    const h = host(new TenantContextService());
    expect(h.forSystem("low-stock digest: cross-tenant scan")).toBe(h);
    for (const bad of ["", "   ", "too short", undefined, 42]) {
      expect(() => h.forSystem(bad as any)).toThrow(/literal reason/);
    }
  });
});

describe("Q1 TenantContextService.kind(): the kinds and isSuperAdmin() re-expressed through it", () => {
  const ctx = new TenantContextService();
  const kindOf = (run: (fn: () => TenantContextKind) => TenantContextKind) => run(() => ctx.kind());

  it.each([
    ["no store", () => ctx.kind(), "NONE"],
    ["a tenant", () => ctx.run("t1", () => ctx.kind()), "TENANT"],
    ["null, no kind named", () => ctx.run(null, () => ctx.kind()), "ANONYMOUS"],
    ["null, SUPER_ADMIN", () => ctx.run(null, () => ctx.kind(), "SUPER_ADMIN"), "SUPER_ADMIN"],
    [
      "a tenant even when SUPER_ADMIN is named (impersonation)",
      () => ctx.run("t1", () => ctx.kind(), "SUPER_ADMIN"),
      "TENANT",
    ],
  ])("%s -> %s", (_n, run, kind) => {
    expect(run()).toBe(kind);
  });

  it("isSuperAdmin() is kind() === SUPER_ADMIN: an ANONYMOUS or NONE context is not a super admin any more", () => {
    expect(ctx.isSuperAdmin()).toBe(false);
    expect(ctx.run(null, () => ctx.isSuperAdmin())).toBe(false);
    expect(ctx.run(null, () => ctx.isSuperAdmin(), "SUPER_ADMIN")).toBe(true);
    expect(kindOf((fn) => ctx.run("t1", fn))).toBe("TENANT");
  });

  it("getOrNull() is unchanged and run() keeps its two-argument form", () => {
    expect(ctx.run("t1", () => ctx.getOrNull())).toBe("t1");
    expect(ctx.run(null, () => ctx.getOrNull())).toBeNull();
    expect(ctx.getOrNull()).toBeNull();
  });
});

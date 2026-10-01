import * as fs from "fs";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantContextGuard, TenantContextMissingError } from "../tenant/tenant-context-guard";
import { stripComments } from "../common/testing/unscoped-write-scan";

/**
 * SA-619 PR-2c, case 10: the TENANT_CONTEXT_ENFORCE=true REHEARSAL. A table of the representative
 * caller shapes runs against a PrismaService whose guard is ENFORCING (no database: the base
 * $transaction is stubbed and the extension is only built). Every row that must keep working is asserted
 * not to throw; every row that WOULD throw is listed, so the list of flip-day casualties is explicit
 * rather than discovered in prod logs. Then a source scan pins the array-form `$transaction([...])`
 * callers (the shape the guard cannot see through) to the five classified ones.
 */
describe("SA-619 enforce-flip rehearsal (TENANT_CONTEXT_ENFORCE=true)", () => {
  const make = () => {
    const warn = jest.fn();
    const guard = new TenantContextGuard({ enforce: true, log: { warn } });
    const ctx = new TenantContextService();
    const prisma = new PrismaService(ctx, guard);
    jest.spyOn(PrismaClient.prototype, "$transaction").mockImplementation((async (arg: any) =>
      typeof arg === "function"
        ? arg({
            $executeRaw: jest.fn().mockResolvedValue(0),
            customer: { create: jest.fn().mockResolvedValue("c"), findMany: jest.fn() },
            systemConfig: { create: jest.fn().mockResolvedValue("sc") },
          })
        : ["ok"]) as any);
    return { prisma, ctx };
  };
  afterEach(() => jest.restoreAllMocks());

  type Kind = "TENANT" | "SUPER_ADMIN" | "ANONYMOUS" | "SYSTEM" | "NONE";
  const inCtx = <T>(ctx: TenantContextService, kind: Kind, fn: () => T): T =>
    kind === "NONE"
      ? fn()
      : kind === "TENANT"
        ? ctx.run("t-1", fn)
        : ctx.run(null, fn, kind as "SUPER_ADMIN" | "ANONYMOUS" | "SYSTEM");

  const rows: Array<[string, Kind, (p: PrismaService) => unknown]> = [
    ["a request: forTenant()", "TENANT", (p) => p.forTenant()],
    ["a request: tenantTransaction", "TENANT", (p) => p.tenantTransaction(async () => "ok")],
    [
      "a request: array $transaction of forTenant() promises",
      "TENANT",
      (p) => p.$transaction([Promise.resolve(1)] as any),
    ],
    ["a cron under tenantCtx.run: forTenant()", "TENANT", (p) => p.forTenant()],
    [
      "a buyer token route: systemTransaction",
      "ANONYMOUS",
      (p) => p.systemTransaction("buyer-auth.verifyEmail", async () => "ok"),
    ],
    [
      "a buyer public lookup: forSystem()",
      "ANONYMOUS",
      (p) => p.forSystem("buyer: public lookup by token"),
    ],
    [
      "a webhook with no context: forSystem()",
      "NONE",
      (p) => p.forSystem("webhook: resolve tenant from the external id"),
    ],
    [
      "a webhook with no context: systemTransaction",
      "NONE",
      (p) => p.systemTransaction("webhook: apply payment", async () => "ok"),
    ],
    [
      "a SYSTEM-kind job: array $transaction",
      "SYSTEM",
      (p) => p.$transaction([Promise.resolve(1)] as any),
    ],
    ["a SUPER_ADMIN platform read: forTenant()", "SUPER_ADMIN", (p) => p.forTenant()],
    [
      "a SUPER_ADMIN tx, explicit tenantId on a tenant-owned create",
      "SUPER_ADMIN",
      (p) => p.tenantTransaction((tx: any) => tx.customer.create({ data: { tenantId: "t-1" } })),
    ],
    [
      "a SUPER_ADMIN tx, explicit tenantId:null (a deliberate platform row)",
      "SUPER_ADMIN",
      (p) => p.tenantTransaction((tx: any) => tx.customer.create({ data: { tenantId: null } })),
    ],
    [
      "a SUPER_ADMIN tx writing a platform model (SystemConfig has a nullable tenantId)",
      "SUPER_ADMIN",
      (p) => p.tenantTransaction((tx: any) => tx.systemConfig.create({ data: { tenantId: null } })),
    ],
  ];

  it.each(rows)("keeps working: %s [%s]", async (_n, kind, run) => {
    const { prisma, ctx } = make();
    await expect(
      Promise.resolve().then(() => inCtx(ctx, kind, () => run(prisma))),
    ).resolves.not.toBeInstanceOf(Error);
  });

  /** The flip-day casualties: each is what would 500 once the flag is on. Listed so none is a surprise. */
  const casualties: Array<[string, Kind, (p: PrismaService) => unknown]> = [
    ["an anonymous caller using forTenant()", "ANONYMOUS", (p) => p.forTenant()],
    [
      "a context-less caller using tenantTransaction",
      "NONE",
      (p) => p.tenantTransaction(async () => "ok"),
    ],
    [
      "an anonymous caller using the ARRAY $transaction",
      "ANONYMOUS",
      (p) => p.$transaction([Promise.resolve(1)] as any),
    ],
    [
      "a SUPER_ADMIN tenant-owned create with NO tenantId",
      "SUPER_ADMIN",
      (p) => p.tenantTransaction((tx: any) => tx.customer.create({ data: { name: "x" } })),
    ],
    [
      "a systemTransaction create with NO tenantId",
      "NONE",
      (p) =>
        p.systemTransaction("job: backfill", (tx: any) =>
          tx.customer.create({ data: { name: "x" } }),
        ),
    ],
  ];

  it.each(casualties)("WOULD throw (a casualty, listed): %s [%s]", async (_n, kind, run) => {
    const { prisma, ctx } = make();
    await expect(
      Promise.resolve().then(() => inCtx(ctx, kind, () => run(prisma))),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  describe("the array-form $transaction([...]) callers in the source", () => {
    const SRC = path.resolve(__dirname, "..");
    const walk = (d: string, o: string[] = []): string[] => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f, o);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) o.push(f);
      }
      return o;
    };
    const found: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join("/");
      if (rel === "prisma/prisma.service.ts") continue; // the override itself
      const n = (stripComments(fs.readFileSync(f, "utf8")).match(/\$transaction\s*\(\s*\[/g) ?? [])
        .length;
      if (n) found[rel] = n;
    }

    /**
     * CLASSIFIED (PR-2c): every promise in these batches is built with `forTenant()`, so each is a
     * tenant-scoped query inside a request that already passed forTenant()'s own context check; the
     * array override's check passes for TENANT / SUPER_ADMIN, and a context-less caller would already
     * have failed at forTenant(). No conversion is needed for the flip.
     */
    const CLASSIFIED: Record<string, number> = {
      "products/products.service.ts": 1,
      "route-optimization/route-optimization.service.ts": 2,
      "routes/routes.service.ts": 1,
      "suppliers/suppliers.service.ts": 1,
    };

    it("exactly the five classified callers exist (a new one must be classified here)", () => {
      expect(found).toEqual(CLASSIFIED);
    });
  });
});

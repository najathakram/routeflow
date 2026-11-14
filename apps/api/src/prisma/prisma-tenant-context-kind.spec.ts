import * as fs from "fs";
import * as path from "path";
import { Logger } from "@nestjs/common";
import { PrismaService, type SystemClient } from "./prisma.service";
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

// SA-1110: under TENANT the walker stamps nested creates first, so the signal below is the walker-miss signal. These
// rows simulate a miss (identity stamp) to keep proving the guard still reports it, with the same keys and labels.
let mockWalkerMisses = false;
jest.mock("./tenant-nested-walker", () => {
  const real = jest.requireActual("./tenant-nested-walker");
  return {
    ...real,
    stampNestedTenant: (...a: any[]) => (mockWalkerMisses ? a[1] : real.stampNestedTenant(...a)),
  };
});

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

describe("K-2 upsert: a tenantless upsert is judged on its `create` payload", () => {
  const args = {
    where: { id: "c1" },
    create: { businessName: "Acme Foods", contactName: "Pat" },
    update: {},
  };

  it("through the extension: reported once as SUPER_ADMIN|Customer|upsert, and the args pass through untouched", async () => {
    const ctx = new TenantContextService();
    const query = jest.fn(async (a: any) => a);
    const before = { ...hits() };
    await asKind(ctx, "SUPER_ADMIN", () =>
      handler(host(ctx))({ model: "Customer", operation: "upsert", args, query }),
    );
    expect(delta(before, "SUPER_ADMIN|Customer|upsert")).toBe(1);
    expect(query.mock.calls[0][0]).toStrictEqual(args);
    expect(warn.mock.calls.join("\n")).not.toMatch(/Acme|Pat/);
  });

  it("through the raw tx proxy: the same key, args untouched", async () => {
    const ctx = new TenantContextService();
    const upsert = jest.fn(async (a: any) => a);
    const rawTx = { customer: { upsert }, $executeRaw: jest.fn(async () => 0) };
    const h = host(ctx);
    h.$transaction = (fn: (tx: any) => Promise<any>) => fn(rawTx);
    const before = { ...hits() };
    await asKind(ctx, "SUPER_ADMIN", () =>
      h.tenantTransaction((tx: any) => tx.customer.upsert(args)),
    );
    expect(delta(before, "SUPER_ADMIN|Customer|upsert")).toBe(1);
    expect(upsert.mock.calls[0][0]).toStrictEqual(args);
  });

  it("an upsert whose create names a tenant is not reported", async () => {
    const ctx = new TenantContextService();
    const query = jest.fn(async (a: any) => a);
    const before = { ...hits() };
    await asKind(ctx, "SUPER_ADMIN", () =>
      handler(host(ctx))({
        model: "Customer",
        operation: "upsert",
        args: { ...args, create: { ...args.create, tenantId: "t1" } },
        query,
      }),
    );
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

describe("forSystem(reason, fn): the deliberate unscoped door, callback shape only (SA-1105 A-1)", () => {
  const REASON = "low-stock digest: cross-tenant scan";
  const query = jest.fn(async (a: any) => a);

  it("runs fn with the client itself and returns its result, and refuses a reason that is empty or shorter than 12 characters", async () => {
    const h = host(new TenantContextService());
    const seen: unknown[] = [];
    await expect(
      h.forSystem(REASON, async (db: unknown) => {
        seen.push(db);
        return 42;
      }),
    ).resolves.toBe(42);
    expect(seen).toEqual([h]);
    for (const bad of ["", "   ", "too short", undefined, 42]) {
      expect(() => h.forSystem(bad as any, async () => 1)).toThrow(/literal reason/);
    }
  });

  it("the returned-client form is a compile error (forSystem needs its callback)", () => {
    const typed = {} as PrismaService;
    // @ts-expect-error -- A-1: `forSystem(reason)` without `fn` no longer exists
    const oneArg = () => typed.forSystem(REASON);
    expect(typeof oneArg).toBe("function");
  });

  it("S-1 kind() is SYSTEM inside the body, and the outer kind is restored after it returns and after it throws", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    const inside = await h.forSystem(REASON, async () => ctx.kind());
    expect(inside).toBe("SYSTEM");
    expect(ctx.kind()).toBe("NONE");
    await expect(
      h.forSystem(REASON, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(ctx.kind()).toBe("NONE");
    await ctx.run(
      null,
      async () => {
        await h.forSystem(REASON, async () => undefined);
        expect(ctx.kind()).toBe("SUPER_ADMIN");
      },
      "SUPER_ADMIN",
    );
  });

  it("S-2 a forTenant() read inside the body raises no warn and leaves the counter unchanged (the SYSTEM branch is live)", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    const before = { ...hits() };
    await h.forSystem(REASON, async () => {
      // SYSTEM: forTenant() is the unscoped client itself, with no observing layer in front of it ...
      expect(h.forTenant()).toBe(h);
      // ... and the guard, asked for a read as the running kind, stays silent.
      const observe = h._observeExtension(ctx.kind()).query.$allModels.$allOperations;
      await observe({ model: "Product", operation: "findMany", args: { where: {} }, query });
    });
    expect(query).toHaveBeenCalledWith({ where: {} }); // unscoped, unchanged
    expect(hits()).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it("S-3 a nested tenantCtx.run(tenantId) inside the body is TENANT as usual", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    const kinds = await h.forSystem(REASON, async () => [
      ctx.kind(),
      await ctx.run("t1", async () => ctx.kind()),
      ctx.kind(),
    ]);
    expect(kinds).toEqual(["SYSTEM", "TENANT", "SYSTEM"]);
  });

  it("B4-1 run() cannot name SYSTEM: it is a type error, and runSystem is the only producer (B1284)", () => {
    const ctx = new TenantContextService();
    // @ts-expect-error -- B1284: SYSTEM is produced only by runSystem
    ctx.run(null, () => 1, "SYSTEM");
    expect(ctx.runSystem("a long enough reason", () => [ctx.kind(), ctx.getOrNull()])).toEqual([
      "SYSTEM",
      null,
    ]);
    expect(ctx.runSystem("a long enough reason", () => ctx.label())).toBe("a long enough reason");
    expect(ctx.kind()).toBe("NONE");
    expect(() =>
      ctx.runSystem("a long enough reason", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(ctx.kind()).toBe("NONE");
  });

  it("B1296-1 (guard, SA-1131): a query deferred inside fn runs SYSTEM after forSystem has returned, inside a SUPER_ADMIN caller", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    const before = { ...hits() };
    let deferred!: Promise<{ kind: TenantContextKind; client: unknown }>;
    await ctx.run(
      null,
      async () => {
        await h.forSystem(REASON, async (db: SystemClient) => {
          deferred = new Promise((resolve, reject) =>
            setTimeout(() => {
              const client = (db as any).forTenant();
              const observe = h._observeExtension(ctx.kind()).query.$allModels.$allOperations;
              const kind = ctx.kind();
              void Promise.resolve(
                observe({ model: "Product", operation: "findMany", args: { where: {} }, query }),
              ).then(() => resolve({ kind, client }), reject);
            }, 0),
          );
        });
        expect(ctx.kind()).toBe("SUPER_ADMIN"); // forSystem has returned; the caller's kind is back
      },
      "SUPER_ADMIN",
    );
    // AsyncLocalStorage carries the SYSTEM frame into work scheduled inside it: the deferred read is the unscoped
    // client, unreported. If a change to forSystem ever ends that propagation, this row says so the day it lands.
    await expect(deferred).resolves.toEqual({ kind: "SYSTEM", client: h });
    expect(hits()).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it("B1296-2 a synchronous helper typed SystemClient, called with db inside fn, works and runs SYSTEM", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    const helper = (db: SystemClient) => ({ same: db === h, kind: ctx.kind() });
    await expect(h.forSystem(REASON, async (db: SystemClient) => helper(db))).resolves.toEqual({
      same: true,
      kind: "SYSTEM",
    });
  });

  it("B1296-3 (type) a SystemClient helper refuses a plain PrismaService, and forSystem's callback hands a SystemClient", () => {
    const plain = {} as PrismaService;
    const helper = (db: SystemClient) => db;
    // @ts-expect-error -- B1296: an injected PrismaService is not the callback's client
    const outside = () => helper(plain);
    const inside = () => plain.forSystem(REASON, async (db) => helper(db));
    expect([typeof outside, typeof inside]).toEqual(["function", "function"]);
  });

  it("B1296-4 the brand is minted in one place: only prisma.service.ts asserts a value to SystemClient, once", () => {
    // `x as SystemClient` compiles (a subtype narrowing), so the compiler alone does not stop a forged client. In B1296-1/2
    // `h` is `any`, so their `db: SystemClient` annotations check nothing; B1296-3 is the typed row, this is the mint pin.
    const root = path.resolve(__dirname, "..");
    const self = path.resolve(__filename);
    const mint = /\bas\s+(?:unknown\s+as\s+)?SystemClient\b/g;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && p !== self) {
          const rel = path.relative(root, p).replace(/\\/g, "/");
          found.push(...Array.from(fs.readFileSync(p, "utf8").matchAll(mint), () => rel));
        }
      }
    };
    walk(root);
    expect(found).toEqual(["prisma/prisma.service.ts"]);
  });
});

describe("the TENANT-path checks: a nested create whose child names no tenant is the one signal on a tenant request", () => {
  // the extension assigns args.data, so the stamping row works on its own copy
  const nested = {
    data: { lineItems: { create: [{ productId: "p1", qty: 1 }] } },
  };
  const fresh = () => structuredClone(nested);

  it("SA-1110: with the walker working, both layers stamp the child and report nothing", async () => {
    const ctx = new TenantContextService();
    const before = { ...hits() };
    const out = await ctx.run("t1", () =>
      handler(host(ctx))({
        model: "Order",
        operation: "create",
        args: fresh(),
        query: async (a: any) => a,
      }),
    );
    expect(out.data.lineItems.create[0].tenantId).toBe("t1");
    const create = jest.fn(async (a: any) => a);
    const h = host(ctx);
    h.$transaction = (fn: (tx: any) => Promise<any>) =>
      fn({ order: { create }, $executeRaw: jest.fn(async () => 0) });
    await ctx.run("t1", () => h.tenantTransaction((tx: any) => tx.order.create(fresh())));
    expect(create.mock.calls[0][0].data.lineItems.create[0].tenantId).toBe("t1");
    expect(delta(before, "TENANT|Order.lineItems|nested-create")).toBe(0);
  });

  describe("a walker miss (simulated: identity stamp) is still the one signal", () => {
    beforeEach(() => (mockWalkerMisses = true));
    afterEach(() => (mockWalkerMisses = false));

    it("through forTenant(): reported once as TENANT|Order.lineItems|nested-create, and the args still carry the injected id", async () => {
      const ctx = new TenantContextService();
      const q = jest.fn(async (a: any) => a);
      const before = { ...hits() };
      const out = await ctx.run("t1", () =>
        handler(host(ctx))({ model: "Order", operation: "create", args: nested, query: q }),
      );
      expect(out.data.tenantId).toBe("t1");
      expect(delta(before, "TENANT|Order.lineItems|nested-create")).toBe(1);
    });

    it("through tenantTransaction(): the same key, so the two layers cannot disagree", async () => {
      const ctx = new TenantContextService();
      const create = jest.fn(async (a: any) => a);
      const rawTx = { order: { create }, $executeRaw: jest.fn(async () => 0) };
      const h = host(ctx);
      h.$transaction = (fn: (tx: any) => Promise<any>) => fn(rawTx);
      const before = { ...hits() };
      await ctx.run("t1", () => h.tenantTransaction((tx: any) => tx.order.create(nested)));
      expect(create.mock.calls[0][0].data.tenantId).toBe("t1");
      expect(delta(before, "TENANT|Order.lineItems|nested-create")).toBe(1);
    });
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

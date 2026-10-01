import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import {
  TenantContextGuard,
  TenantContextMissingError,
  superAdminCreateExtension,
} from "../tenant/tenant-context-guard";

/**
 * SA-619 PR-2b (cases 1-5): the system door, in BOTH modes. No database: $extends and the base
 * $transaction are stubbed; the checks are driven through the extension / proxy they install.
 */
describe("SA-619 PR-2b: the system door", () => {
  const make = (enforce: boolean) => {
    const warn = jest.fn();
    const guard = new TenantContextGuard({ enforce, log: { warn } });
    const ctx = new TenantContextService();
    const prisma = new PrismaService(ctx, guard);
    return { prisma, ctx, guard, warn };
  };

  /** What forSystem()/forTenant() hand to $extends, and the client it returns. */
  const captureExtend = (prisma: PrismaService) => {
    const seen: any[] = [];
    jest.spyOn(prisma, "$extends").mockImplementation(((ext: any) => {
      seen.push(ext);
      return { extended: true } as any;
    }) as any);
    return seen;
  };
  const runOp = (ext: any, model: string, operation: string, args: any) =>
    ext.query.$allModels.$allOperations({ model, operation, args, query: jest.fn() });

  describe("case 1: forSystem() applies the write check", () => {
    it("returns an extended client, not the bare one (RED: it returned `this`)", () => {
      const { prisma } = make(false);
      const seen = captureExtend(prisma);
      const out = prisma.forSystem("billing.cron");
      expect(out).not.toBe(prisma);
      expect(seen).toHaveLength(1);
    });

    it("dark: a tenant-owned create with no tenantId warns (kind SYSTEM) and still runs", async () => {
      const { prisma, warn } = make(false);
      const seen = captureExtend(prisma);
      prisma.forSystem("billing.cron");
      const query = jest.fn().mockResolvedValue("ok");
      await seen[0].query.$allModels.$allOperations({
        model: "Customer",
        operation: "create",
        args: { data: { name: "x" } },
        query,
      });
      expect(query).toHaveBeenCalledWith({ data: { name: "x" } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("SYSTEM");
    });

    it("enforced: it throws and never reaches the query", async () => {
      const { prisma } = make(true);
      const seen = captureExtend(prisma);
      prisma.forSystem("billing.cron");
      const query = jest.fn();
      await expect(
        seen[0].query.$allModels.$allOperations({
          model: "Customer",
          operation: "create",
          args: { data: {} },
          query,
        }),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      expect(query).not.toHaveBeenCalled();
    });

    it("an explicit tenantId, an explicit null, a platform model, and a read are all allowed", async () => {
      const { prisma, warn } = make(true);
      const seen = captureExtend(prisma);
      prisma.forSystem("billing.cron");
      await runOp(seen[0], "Customer", "create", { data: { tenantId: "t-1" } });
      await runOp(seen[0], "Customer", "create", { data: { tenantId: null } });
      await runOp(seen[0], "Tenant", "create", { data: { name: "acme" } });
      await runOp(seen[0], "Customer", "findMany", {});
      expect(warn).not.toHaveBeenCalled();
    });

    it("a nested child with no tenantId is reported by the same walker", async () => {
      const { prisma } = make(true);
      const seen = captureExtend(prisma);
      prisma.forSystem("billing.cron");
      const rel = Prisma.dmmf.datamodel.models
        .find((m) => m.name === "Order")!
        .fields.find((f) => f.type === "OrderItem")!.name;
      await expect(
        runOp(seen[0], "Order", "create", {
          data: { tenantId: "t-1", [rel]: { create: [{ productId: "p" }] } },
        }),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
    });

    it("still records the reason, and a blank reason still throws before anything is built", () => {
      const { prisma, guard } = make(false);
      const seen = captureExtend(prisma);
      prisma.forSystem("billing.cron");
      expect(guard.systemReasons()).toEqual({ "billing.cron": 1 });
      expect(() => prisma.forSystem("  ")).toThrow(/reason/);
      expect(seen).toHaveLength(1);
    });

    it("superAdminCreateExtension takes the kind it reports under (default SUPER_ADMIN unchanged)", async () => {
      const superAdminCreate = jest.fn();
      const owned = () => true;
      await runOp(superAdminCreateExtension({ superAdminCreate } as any, owned), "X", "create", {
        data: {},
      });
      expect(superAdminCreate).toHaveBeenLastCalledWith("X", "create", "SUPER_ADMIN");
      await runOp(
        superAdminCreateExtension({ superAdminCreate } as any, owned, "SYSTEM"),
        "X",
        "create",
        { data: {} },
      );
      expect(superAdminCreate).toHaveBeenLastCalledWith("X", "create", "SYSTEM");
    });
  });

  describe("review fold: the forSystem client's array $transaction is deliberate (never reported)", () => {
    afterEach(() => jest.restoreAllMocks());
    it("passes the array and options straight to Prisma's own $transaction, even with no context, enforced", async () => {
      const { prisma, warn } = make(true);
      const seen = captureExtend(prisma);
      prisma.forSystem("auth.resetPassword");
      const base = jest
        .spyOn(PrismaClient.prototype, "$transaction")
        .mockResolvedValue(["a"] as any);
      const arr = [Promise.resolve(1)];
      const out = await seen[0].client.$transaction(arr, { timeout: 5 });
      expect(out).toEqual(["a"]);
      expect(base).toHaveBeenCalledWith(arr, { timeout: 5 });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("case 2: systemTransaction(reason, fn)", () => {
    const rawTx = () => ({
      $executeRaw: jest.fn().mockResolvedValue(0),
      customer: {
        create: jest.fn().mockResolvedValue("created"),
        findMany: jest.fn().mockResolvedValue(["row"]),
      },
    });
    const setup = (enforce: boolean) => {
      const h = make(enforce);
      const tx = rawTx();
      const open = jest
        .spyOn(PrismaClient.prototype, "$transaction")
        .mockImplementation((async (fn: any) => fn(tx)) as any);
      return { ...h, tx, open };
    };
    afterEach(() => jest.restoreAllMocks());

    it("exists, records the reason and runs unscoped (app.current_tenant_id cleared)", async () => {
      const h = setup(false);
      const out = await h.prisma.systemTransaction("webhook.stripe", async (tx: any) =>
        tx.customer.findMany({}),
      );
      expect(out).toEqual(["row"]);
      expect(h.guard.systemReasons()).toEqual({ "webhook.stripe": 1 });
      expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(String(h.tx.$executeRaw.mock.calls[0][0].join?.("") ?? "")).toContain(
        "app.current_tenant_id",
      );
      expect(h.tx.$executeRaw.mock.calls[0][1]).toBe("");
    });

    it("applies the SAME write check as a SUPER_ADMIN tx, under kind SYSTEM (dark warns, enforced throws)", async () => {
      const dark = setup(false);
      await dark.prisma.systemTransaction("webhook.stripe", (tx: any) =>
        tx.customer.create({ data: { name: "x" } }),
      );
      expect(dark.warn).toHaveBeenCalledTimes(1);
      expect(String(dark.warn.mock.calls[0][0])).toContain("SYSTEM");
      const hard = setup(true);
      await expect(
        hard.prisma.systemTransaction("webhook.stripe", (tx: any) =>
          tx.customer.create({ data: { name: "x" } }),
        ),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      await hard.prisma.systemTransaction("webhook.stripe", (tx: any) =>
        tx.customer.create({ data: { tenantId: "t-1" } }),
      );
    });

    it("a blank reason throws BEFORE a transaction is opened", async () => {
      const h = setup(false);
      await expect(h.prisma.systemTransaction("", jest.fn())).rejects.toThrow(/reason/);
      expect(h.open).not.toHaveBeenCalled();
    });
  });

  describe("case 3: a context-less tenantTransaction under enforce; systemTransaction is the only door", () => {
    afterEach(() => jest.restoreAllMocks());
    it.each(["ANONYMOUS", "SYSTEM"] as const)(
      "enforced: tenantTransaction in a %s context rejects before a tx opens; systemTransaction runs",
      async (kind) => {
        const { prisma, ctx } = make(true);
        const open = jest
          .spyOn(PrismaClient.prototype, "$transaction")
          .mockImplementation((async (fn: any) =>
            fn({ $executeRaw: jest.fn().mockResolvedValue(0) })) as any);
        await ctx.run(
          null,
          async () => {
            await expect(prisma.tenantTransaction(jest.fn())).rejects.toBeInstanceOf(
              TenantContextMissingError,
            );
            expect(open).not.toHaveBeenCalled();
            await expect(
              prisma.systemTransaction("cron.reminder", async () => "done"),
            ).resolves.toBe("done");
            expect(open).toHaveBeenCalledTimes(1);
          },
          kind,
        );
      },
    );

    it("dark: entering through systemTransaction never reports a missing context (RED: SYSTEM kind still reported)", async () => {
      const { prisma, ctx, warn } = make(false);
      jest
        .spyOn(PrismaClient.prototype, "$transaction")
        .mockImplementation((async (fn: any) =>
          fn({ $executeRaw: jest.fn().mockResolvedValue(0) })) as any);
      await ctx.run(
        null,
        () => prisma.systemTransaction("cron.reminder", async () => "done"),
        "SYSTEM",
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("case 4: the array form $transaction([...])", () => {
    afterEach(() => jest.restoreAllMocks());
    const stub = () =>
      jest.spyOn(PrismaClient.prototype, "$transaction").mockResolvedValue(["a", "b"] as any);
    const promises = () => [Promise.resolve(1), Promise.resolve(2)];

    it.each(["ANONYMOUS"] as const)(
      "dark: a %s array transaction warns once and still runs, passing the SAME array and options",
      async (kind) => {
        const { prisma, ctx, warn } = make(false);
        const base = stub();
        const arr = promises();
        const opts = { isolationLevel: "Serializable" } as any;
        const out = await ctx.run(null, () => prisma.$transaction(arr as any, opts), kind);
        expect(out).toEqual(["a", "b"]);
        expect(base).toHaveBeenCalledWith(arr, opts);
        expect(warn).toHaveBeenCalledTimes(1);
      },
    );

    it("no context at all (NONE) warns dark and throws enforced, before the base $transaction", async () => {
      const dark = make(false);
      stub();
      await dark.prisma.$transaction(promises() as any);
      expect(dark.warn).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();
      const hard = make(true);
      const base = stub();
      await expect(hard.prisma.$transaction(promises() as any)).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
      expect(base).not.toHaveBeenCalled();
    });

    it("TENANT and SUPER_ADMIN pass silently under enforce", async () => {
      const { prisma, ctx, warn } = make(true);
      const base = stub();
      await ctx.run("t-1", () => prisma.$transaction(promises() as any));
      await ctx.run(null, () => prisma.$transaction(promises() as any), "SUPER_ADMIN");
      expect(base).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it("a SYSTEM-kind context passes (the system door is deliberate), enforced too", async () => {
      const { prisma, ctx, warn } = make(true);
      const base = stub();
      await ctx.run(null, () => prisma.$transaction(promises() as any), "SYSTEM");
      expect(base).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it("the interactive form passes straight through untouched (tenantTransaction does its own check)", async () => {
      const { prisma, warn } = make(true);
      const base = stub();
      const fn = jest.fn();
      await prisma.$transaction(fn as any, { timeout: 1 } as any);
      expect(base).toHaveBeenCalledWith(fn, { timeout: 1 });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("case 5: forTenant().$transaction throws (always: the extended client's tx would be unscoped)", () => {
    it("the tenant extension installs a $transaction that throws, pointing at tenantTransaction", () => {
      const { prisma, ctx } = make(false);
      const seen = captureExtend(prisma);
      ctx.run("t-1", () => prisma.forTenant());
      const client = seen[0].client;
      expect(typeof client.$transaction).toBe("function");
      expect(() => client.$transaction(async () => 1)).toThrow(/tenantTransaction/);
      expect(() => client.$transaction([Promise.resolve(1)])).toThrow(/tenantTransaction/);
    });
  });
});

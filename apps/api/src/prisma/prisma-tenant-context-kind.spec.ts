import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantContextGuard, TenantContextMissingError } from "../tenant/tenant-context-guard";

/**
 * SA-619 PR-1: the kind x operation matrix for PrismaService.forTenant() / tenantTransaction() /
 * forSystem(), in BOTH modes (dark = warn, enforced = throw). No database: $transaction is stubbed,
 * and forTenant() only builds a client extension.
 */
describe("PrismaService tenant context kinds (SA-619)", () => {
  const make = (enforce: boolean) => {
    const warn = jest.fn();
    const guard = new TenantContextGuard({ enforce, log: { warn } });
    const ctx = new TenantContextService();
    const prisma = new PrismaService(ctx, guard);
    return { prisma, ctx, guard, warn };
  };

  describe("forTenant(), dark", () => {
    it("TENANT => a scoped client, no warn", () => {
      const { prisma, ctx, warn } = make(false);
      ctx.run("t-1", () => {
        expect(prisma.forTenant()).not.toBe(prisma);
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN read => unscoped-capable client, no warn", () => {
      const { prisma, ctx, warn } = make(false);
      ctx.run(
        null,
        () => {
          expect(() => prisma.forTenant()).not.toThrow();
        },
        "SUPER_ADMIN",
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(["ANONYMOUS", "SYSTEM"] as const)("%s => today's unscoped client, ONE warn", (kind) => {
      const { prisma, ctx, warn } = make(false);
      ctx.run(
        null,
        () => {
          expect(prisma.forTenant()).toBe(prisma);
        },
        kind,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(kind);
    });

    it("no context at all (NONE) => unscoped client + warn", () => {
      const { prisma, warn } = make(false);
      expect(prisma.forTenant()).toBe(prisma);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("NONE");
    });

    it("the warn names the caller (this file), not prisma.service", () => {
      const { prisma, warn } = make(false);
      prisma.forTenant();
      expect(String(warn.mock.calls[0][0])).toContain("prisma-tenant-context-kind.spec");
    });
  });

  describe("forTenant(), enforced", () => {
    it.each(["ANONYMOUS", "SYSTEM"] as const)("%s throws TenantContextMissingError", (kind) => {
      const { prisma, ctx } = make(true);
      ctx.run(
        null,
        () => {
          expect(() => prisma.forTenant()).toThrow(TenantContextMissingError);
        },
        kind,
      );
    });
    it("no context throws", () => {
      expect(() => make(true).prisma.forTenant()).toThrow(TenantContextMissingError);
    });
    it("TENANT and SUPER_ADMIN reads do NOT throw", () => {
      const { prisma, ctx } = make(true);
      ctx.run("t-1", () => expect(() => prisma.forTenant()).not.toThrow());
      ctx.run(null, () => expect(() => prisma.forTenant()).not.toThrow(), "SUPER_ADMIN");
    });
  });

  describe("tenantTransaction() follows the same rule", () => {
    const stub = (prisma: PrismaService) =>
      jest
        .spyOn(prisma, "$transaction")
        .mockImplementation((async (fn: any) =>
          fn({ $executeRaw: jest.fn().mockResolvedValue(0) })) as any);

    it("dark: a context-less transaction warns and still runs; a tenant or SUPER_ADMIN one is silent", async () => {
      const { prisma, ctx, warn } = make(false);
      stub(prisma);
      const fn = jest.fn().mockResolvedValue("ok");
      await expect(prisma.tenantTransaction(fn)).resolves.toBe("ok");
      expect(warn).toHaveBeenCalledTimes(1);
      await ctx.run("t-1", () => prisma.tenantTransaction(fn));
      await ctx.run(null, () => prisma.tenantTransaction(fn), "SUPER_ADMIN");
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("enforced: a context-less transaction rejects before opening a transaction", async () => {
      const { prisma } = make(true);
      const tx = stub(prisma);
      await expect(prisma.tenantTransaction(jest.fn())).rejects.toBeInstanceOf(
        TenantContextMissingError,
      );
      expect(tx).not.toHaveBeenCalled();
    });
  });

  describe("tenantTransaction(): SA-619a raw-tx creates for every non-TENANT kind", () => {
    const rawTx = () => ({
      $executeRaw: jest.fn().mockResolvedValue(0),
      customer: {
        create: jest.fn().mockResolvedValue("created"),
        createMany: jest.fn().mockResolvedValue("many"),
        upsert: jest.fn().mockResolvedValue("upserted"),
        findMany: jest.fn().mockResolvedValue(["row"]),
      },
      tenant: { create: jest.fn().mockResolvedValue("tenant") }, // a platform model: no tenantId column
    });
    const setup = (enforce: boolean) => {
      const h = make(enforce);
      const tx = rawTx();
      jest.spyOn(h.prisma, "$transaction").mockImplementation((async (fn: any) => fn(tx)) as any);
      return { ...h, tx };
    };
    const asSuperAdmin = <T>(h: ReturnType<typeof setup>, fn: (tx: any) => Promise<T>) =>
      h.ctx.run(null, () => h.prisma.tenantTransaction(fn), "SUPER_ADMIN");

    it("dark: a SUPER_ADMIN create without a tenantId warns once (with the model) and still runs", async () => {
      const h = setup(false);
      const out = await asSuperAdmin(h, (tx) => tx.customer.create({ data: { name: "x" } }));
      expect(out).toBe("created");
      expect(h.tx.customer.create).toHaveBeenCalledWith({ data: { name: "x" } }); // args untouched
      expect(h.warn).toHaveBeenCalledTimes(1);
      expect(String(h.warn.mock.calls[0][0])).toContain("Customer");
    });

    it("an explicit tenantId (create, createMany rows, upsert create) does not warn", async () => {
      const h = setup(false);
      await asSuperAdmin(h, async (tx) => {
        await tx.customer.create({ data: { tenantId: "t-1" } });
        await tx.customer.createMany({ data: [{ tenantId: "t-1" }, { tenantId: "t-1" }] });
        await tx.customer.upsert({ where: { id: "1" }, create: { tenantId: "t-1" }, update: {} });
      });
      expect(h.warn).not.toHaveBeenCalled();
    });

    it("a createMany with one row missing the tenantId warns", async () => {
      const h = setup(false);
      await asSuperAdmin(h, (tx) => tx.customer.createMany({ data: [{ tenantId: "t" }, {}] }));
      expect(h.warn).toHaveBeenCalledTimes(1);
    });

    it("a platform model (no tenantId column) is allowed without one", async () => {
      const h = setup(false);
      await asSuperAdmin(h, (tx) => tx.tenant.create({ data: { name: "acme" } }));
      expect(h.warn).not.toHaveBeenCalled();
    });

    it("reads through the raw tx stay unscoped and silent for a SUPER_ADMIN", async () => {
      const h = setup(false);
      const out = await asSuperAdmin(h, (tx) => tx.customer.findMany({ where: { name: "x" } }));
      expect(out).toEqual(["row"]);
      expect(h.tx.customer.findMany).toHaveBeenCalledWith({ where: { name: "x" } });
      expect(h.warn).not.toHaveBeenCalled();
    });

    it("enforced: a SUPER_ADMIN create without a tenantId throws and never reaches the client", async () => {
      const h = setup(true);
      await expect(
        asSuperAdmin(h, (tx) => tx.customer.create({ data: { name: "x" } })),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      expect(h.tx.customer.create).not.toHaveBeenCalled();
    });

    it("enforced: with an explicit tenantId, a platform model, or a read it is allowed", async () => {
      const h = setup(true);
      await asSuperAdmin(h, async (tx) => {
        await tx.customer.create({ data: { tenantId: "t-1" } });
        await tx.tenant.create({ data: {} });
        await tx.customer.findMany({});
      });
      expect(h.tx.customer.create).toHaveBeenCalledTimes(1);
    });

    it("an ANONYMOUS transaction is checked too (dark: a context warn plus the create warn)", async () => {
      const h = setup(false);
      await h.ctx.run(null, () =>
        h.prisma.tenantTransaction((tx: any) => tx.customer.create({ data: {} })),
      );
      expect(h.warn).toHaveBeenCalledTimes(2);
    });

    it("a TENANT transaction is unchanged: the tenantId is injected and nothing warns", async () => {
      const h = setup(false);
      await h.ctx.run("t-1", () =>
        h.prisma.tenantTransaction((tx: any) => tx.customer.create({ data: { name: "x" } })),
      );
      expect(h.tx.customer.create).toHaveBeenCalledWith({ data: { name: "x", tenantId: "t-1" } });
      expect(h.warn).not.toHaveBeenCalled();
    });
  });

  describe("forSystem(reason)", () => {
    it("returns the unscoped client under every kind, in both modes, without warning", () => {
      for (const enforce of [false, true]) {
        const { prisma, ctx, warn } = make(enforce);
        expect(prisma.forSystem("test: cross-tenant read")).toBe(prisma);
        for (const kind of ["SUPER_ADMIN", "ANONYMOUS", "SYSTEM"] as const)
          ctx.run(
            null,
            () => expect(prisma.forSystem("test: cross-tenant read")).toBe(prisma),
            kind,
          );
        ctx.run("t-1", () => expect(prisma.forSystem("test: cross-tenant read")).toBe(prisma));
        expect(warn).not.toHaveBeenCalled();
      }
    });
    it("a blank reason throws", () => {
      expect(() => make(false).prisma.forSystem("")).toThrow(/reason/);
    });
  });

  describe("the #2872 scenario: a context-less staff lookup", () => {
    const staffAdmins = (prisma: PrismaService) => prisma.forTenant();
    it("dark: warns (and, like today, is unscoped)", () => {
      const { prisma, warn } = make(false);
      expect(staffAdmins(prisma)).toBe(prisma);
      expect(warn).toHaveBeenCalledTimes(1);
    });
    it("enforced: throws instead of returning every tenant's admins", () => {
      expect(() => staffAdmins(make(true).prisma)).toThrow(TenantContextMissingError);
    });
  });

  describe("a cron body", () => {
    it("a forTenant() with no tenantCtx.run warns; under run(tenantId) it does not", async () => {
      const { prisma, ctx, warn } = make(false);
      const job = () => prisma.forTenant();
      job();
      expect(warn).toHaveBeenCalledTimes(1);
      await ctx.run("t-1", async () => {
        await Promise.resolve();
        job();
      });
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

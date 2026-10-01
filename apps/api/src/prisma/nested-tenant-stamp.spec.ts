import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import {
  TenantContextGuard,
  checkCreateHasTenant,
  wrapTxWithCreateCheck,
} from "../tenant/tenant-context-guard";
import { NestedTenantWalkError, isTenantOwnedModel } from "../tenant/nested-tenant-walk";

/**
 * SA-620 B1 integration: the SAME walker is applied by the tenant client extension, the tenant tx proxy,
 * and (as a check) the SA-619 non-TENANT create check. No database: the extension handler and the proxy
 * are driven directly with a spy standing in for the query.
 */
describe("nested tenant stamping is applied everywhere (SA-620 case 4/5)", () => {
  const make = () => {
    const ctx = new TenantContextService();
    const guard = new TenantContextGuard({ enforce: false, log: { warn: jest.fn() } });
    return { prisma: new PrismaService(ctx, guard), guard };
  };
  const handler = (prisma: PrismaService) =>
    (prisma as any)._tenantExtension("t-1").query.$allModels.$allOperations as (
      a: any,
    ) => Promise<any>;
  const run = async (op: string, model: string, args: any) => {
    const query = jest.fn().mockResolvedValue("ok");
    await handler(make().prisma)({ model, operation: op, args, query });
    return query.mock.calls[0][0];
  };

  it("extension: create stamps the top row AND its nested children", async () => {
    const args = await run("create", "VendorBill", {
      data: { note: "n", items: { createMany: { data: [{ q: 1 }, { q: 2 }] } } },
    });
    expect(args.data.tenantId).toBe("t-1");
    expect(args.data.items.createMany.data.map((r: any) => r.tenantId)).toEqual(["t-1", "t-1"]);
  });

  it("extension: upsert stamps create (nested too) and walks update for nested creates", async () => {
    const args = await run("upsert", "VendorBill", {
      where: { id: "1" },
      create: { items: { create: [{ q: 1 }] } },
      update: { items: { create: [{ q: 9 }] } },
    });
    expect(args.create.tenantId).toBe("t-1");
    expect(args.create.items.create[0].tenantId).toBe("t-1");
    expect(args.update.items.create[0].tenantId).toBe("t-1");
  });

  it("extension: an UPDATE that adds lines (update.data with a nested create) stamps them (the VendorBill edit)", async () => {
    for (const op of ["update", "updateMany", "updateManyAndReturn"]) {
      const args = await run(op, "VendorBill", {
        where: { id: "1" },
        data: { items: { create: [{ q: 3 }] } },
      });
      expect(args.where.tenantId).toBe("t-1"); // the existing scoping is unchanged
      expect(args.data.items.create[0].tenantId).toBe("t-1");
    }
  });

  it("extension: an explicit DIFFERENT tenantId on a nested child throws before the query", async () => {
    const query = jest.fn();
    await expect(
      handler(make().prisma)({
        model: "VendorBill",
        operation: "create",
        args: { data: { items: { create: { tenantId: "other" } } } },
        query,
      }),
    ).rejects.toBeInstanceOf(NestedTenantWalkError);
    expect(query).not.toHaveBeenCalled();
  });

  it("extension: reads and deletes are untouched", async () => {
    const args = await run("findMany", "VendorBill", { where: { note: "x" } });
    expect(args).toEqual({ where: { note: "x", tenantId: "t-1" } });
  });

  it("tx proxy: create / update / upsert stamp nested children through the same walker", async () => {
    const calls: any[] = [];
    const rawTx = {
      vendorBill: {
        create: jest.fn(async (a: any) => calls.push(["create", a])),
        update: jest.fn(async (a: any) => calls.push(["update", a])),
        upsert: jest.fn(async (a: any) => calls.push(["upsert", a])),
      },
    };
    const { prisma } = make();
    const tx = (prisma as any)._wrapTxWithTenant(rawTx, "t-1");
    await tx.vendorBill.create({ data: { items: { create: [{ q: 1 }] } } });
    await tx.vendorBill.update({ where: { id: "1" }, data: { items: { create: { q: 2 } } } });
    await tx.vendorBill.upsert({
      where: { id: "1" },
      create: { items: { createMany: { data: [{ q: 3 }] } } },
      update: {},
    });
    expect(calls[0][1].data.items.create[0].tenantId).toBe("t-1");
    expect(calls[1][1].data.items.create.tenantId).toBe("t-1");
    expect(calls[2][1].create.items.createMany.data[0].tenantId).toBe("t-1");
  });

  it("the non-TENANT check reports a nested child with no tenant, and not one that names it", () => {
    const g = { superAdminCreate: jest.fn() };
    checkCreateHasTenant(g, isTenantOwnedModel, "VendorBill", "create", {
      data: { tenantId: "t", items: { create: [{ q: 1 }] } },
    });
    expect(g.superAdminCreate).toHaveBeenCalledWith("VendorBillItem", "create", "SUPER_ADMIN");
    g.superAdminCreate.mockClear();
    checkCreateHasTenant(g, isTenantOwnedModel, "VendorBill", "create", {
      data: { tenantId: "t", items: { create: [{ q: 1, tenantId: "t" }] } },
    });
    checkCreateHasTenant(g, isTenantOwnedModel, "VendorBill", "create", {
      data: { tenantId: "t", items: { create: [{ q: 1, tenantId: null }] } },
    });
    expect(g.superAdminCreate).not.toHaveBeenCalled();
  });

  it("the raw-tx proxy (non-TENANT kinds) reports nested children on create and update", async () => {
    const g = { superAdminCreate: jest.fn() };
    const rawTx = {
      vendorBill: {
        create: jest.fn().mockResolvedValue(1),
        update: jest.fn().mockResolvedValue(1),
      },
    };
    const tx = wrapTxWithCreateCheck(rawTx, g, isTenantOwnedModel, "ANONYMOUS");
    await tx.vendorBill.create({ data: { tenantId: "t", items: { create: [{ q: 1 }] } } });
    await tx.vendorBill.update({ where: { id: "1" }, data: { items: { create: { q: 1 } } } });
    expect(g.superAdminCreate).toHaveBeenCalledTimes(2);
    expect(g.superAdminCreate).toHaveBeenCalledWith("VendorBillItem", "create", "ANONYMOUS");
    expect(rawTx.vendorBill.create).toHaveBeenCalledWith({
      data: { tenantId: "t", items: { create: [{ q: 1 }] } },
    }); // arguments untouched
  });
});

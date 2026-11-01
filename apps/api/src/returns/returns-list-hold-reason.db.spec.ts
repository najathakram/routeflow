/**
 * SA-1060 PR-1, row R-1 (server half), real Postgres — `GET /returns?holdReason=` through ReturnsService. The approval screen lists
 * the INLINE returns that are RECEIVED and held (DRIVER_CAP, ALREADY_RETURNED); on master the filter does not exist, so the
 * list also carries the plain RECEIVED return that is not waiting for anyone. A rejected hold keeps its reason but is filtered out
 * by status, as the screen asks for RECEIVED. One real ReturnsService via `Object.create` (no Nest DI), as returns-list-kind.db.spec.ts.
 *
 * SAFETY: one throwaway `qa-1060-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly what this run made.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ReturnsService } from "./returns.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1060 PR-1 R-1 — GET /returns?holdReason=, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let returns: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-1060-${run}`, "returns-list-hold-reason.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let productId = "";
  let orderId = "";
  const returnIds: string[] = [];
  let driverCapId = "";
  let alreadyReturnedId = "";
  let plainReceivedId = "";
  let rejectedHoldId = "";

  const operator = (): JwtPayload =>
    ({
      sub: "op-sub",
      username: `operator-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;
  const list = (options: any) =>
    tenantCtx.run(tenantId, () => returns.findAllForUser(operator(), options));
  const idsOf = (res: any) => res.data.map((r: any) => r.id).sort();

  const mkReturn = async (data: Record<string, unknown>) => {
    const row = await raw.return.create({
      data: {
        orderId,
        customerId,
        reason: "DAMAGED",
        tenantId,
        kind: "INLINE",
        items: { create: [{ productId, qty: "1", tenantId, subtotal: "9.00" }] },
        ...data,
      } as any,
    });
    returnIds.push(row.id);
    return row.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    returns = Object.assign(Object.create(ReturnsService.prototype), { prisma });

    tenantId = (await raw.tenant.create({ data: { slug, name: `1060 ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: {
          email: `c-${run}@example.test`,
          username: `c-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: "1060 customer", contactName: "Tester", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `1060 widget ${run}`,
          unit: "Each",
          pricePerUnit: "10.00",
          currentStock: "1000",
          tenantId,
        },
      })
    ).id;
    orderId = (
      await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "DELIVERED" as any,
          subtotal: "0.00",
          total: "0.00",
        },
      })
    ).id;

    driverCapId = await mkReturn({
      status: "RECEIVED",
      holdReason: "DRIVER_CAP",
      heldAmount: "9.00",
    });
    alreadyReturnedId = await mkReturn({
      status: "RECEIVED",
      holdReason: "ALREADY_RETURNED",
      heldAmount: "9.00",
    });
    plainReceivedId = await mkReturn({ status: "RECEIVED", holdReason: null });
    rejectedHoldId = await mkReturn({
      status: "REJECTED",
      holdReason: "DRIVER_CAP",
      heldAmount: "9.00",
    });
  }, 120_000);

  afterAll(async () => {
    await raw.returnItem.deleteMany({ where: { returnId: { in: returnIds } } });
    await raw.return.deleteMany({ where: { id: { in: returnIds } } });
    await raw.order.deleteMany({ where: { id: orderId } });
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("R-1: the screen's two holds, RECEIVED, are exactly the held returns", async () => {
    const res = await list({
      kind: "INLINE",
      status: "RECEIVED",
      holdReason: ["DRIVER_CAP", "ALREADY_RETURNED"],
    });
    expect(idsOf(res)).toEqual([driverCapId, alreadyReturnedId].sort());
    expect(res.meta.total).toBe(2);
  });

  it("one reason narrows to that hold", async () => {
    const res = await list({ kind: "INLINE", status: "RECEIVED", holdReason: ["DRIVER_CAP"] });
    expect(idsOf(res)).toEqual([driverCapId]);
  });

  it("guard: with no holdReason the RECEIVED list is unchanged, plain return included", async () => {
    const res = await list({ kind: "INLINE", status: "RECEIVED" });
    expect(idsOf(res)).toEqual([driverCapId, alreadyReturnedId, plainReceivedId].sort());
  });

  it("guard: a rejected hold is out of a RECEIVED list but findable by its status", async () => {
    const res = await list({ kind: "INLINE", status: "REJECTED", holdReason: ["DRIVER_CAP"] });
    expect(idsOf(res)).toEqual([rejectedHoldId]);
  });
});

/**
 * SA-1222 / SA-1226: the PO create never makes a silent duplicate, on REAL parallel connections.
 *
 *  - R7:  the same Idempotency-Key sent together -> ONE PO, both responses carry its id.
 *  - R9:  one `draftId` from two tabs with DIFFERENT keys -> ONE PO and one 409 PO_DRAFT_GONE, no orphan PO row, draft gone.
 *  - R10: no key, sent together -> two POs with distinct numbers and no 500 (the P2002 retry).
 * R8 (a sequential replay with a new draftId) stays on mocks: inventory.po-create-guard.spec.ts.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * Every tenant is a throwaway `qa-po-race-*` slug (assertTestTenant), acme data.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { IdempotencyService } from "../common/idempotency.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-po-race-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "inventory.po-create-race.db.spec.ts",
  );
};

describeDb("PO create: key, draft and number race: real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: InventoryService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        IdempotencyService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    const pos = await prisma.purchaseOrder.findMany({ where: { tenantId }, select: { id: true } });
    await prisma.purchaseOrderItem.deleteMany({ where: { poId: { in: pos.map((p) => p.id) } } });
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
    await prisma.saleDraft.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.supplier.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    userId: string;
    supplierId: string;
    productId: string;
  }

  async function seedWorld(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `Acme ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const supplier = await prisma.supplier.create({
      data: { name: "Acme Supply", tenantId: tenant.id },
    });
    const product = await prisma.product.create({
      data: {
        name: "Acme Widget",
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 0,
        averageCost: 0,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, userId: user.id, supplierId: supplier.id, productId: product.id };
  }

  const body = (w: World, extra: Record<string, unknown> = {}) =>
    ({
      supplierId: w.supplierId,
      items: [{ productId: w.productId, qty: 12, unitCost: 1.5 }],
      ...extra,
    }) as never;

  const create = (w: World, extra: Record<string, unknown>, key?: string) =>
    tenantCtx.run(w.tenantId, () => service.createPurchaseOrder(body(w, extra), w.userId, key));

  const poCount = (w: World) => prisma.purchaseOrder.count({ where: { tenantId: w.tenantId } });

  it("R7: the same Idempotency-Key sent together makes ONE PO and both responses carry its id", async () => {
    const w = await seedWorld("r7");
    const key = `r7-${randomUUID()}`;
    const [a, b] = await Promise.all([create(w, {}, key), create(w, {}, key)]);
    expect(b.id).toBe(a.id);
    expect(await poCount(w)).toBe(1);
  });

  it("R9: one draftId from two tabs with different keys makes ONE PO, one 409 PO_DRAFT_GONE, no orphan, draft gone", async () => {
    const w = await seedWorld("r9");
    const draft = await prisma.saleDraft.create({
      data: {
        tenantId: w.tenantId,
        userId: w.userId,
        kind: "PURCHASE_ORDER",
        payload: { v: 1, supplierId: w.supplierId },
      },
    });
    const settled = await Promise.allSettled([
      create(w, { draftId: draft.id }, `r9-a-${randomUUID()}`),
      create(w, { draftId: draft.id }, `r9-b-${randomUUID()}`),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0].reason as { response?: { code?: string } }).response?.code).toBe(
      API_ERROR_CODES.PO_DRAFT_GONE,
    );
    expect(await poCount(w)).toBe(1);
    expect(await prisma.purchaseOrderItem.count({ where: { tenantId: w.tenantId } })).toBe(1);
    expect(await prisma.saleDraft.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  it("R10: two creates with no key sent together make two POs with distinct numbers and no 500", async () => {
    const w = await seedWorld("r10");
    for (let round = 0; round < 3; round++) {
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.allSettled([create(w, {}), create(w, {})]);
      expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    }
    const pos = await prisma.purchaseOrder.findMany({ where: { tenantId: w.tenantId } });
    expect(pos).toHaveLength(6);
    expect(new Set(pos.map((p) => p.poNumber)).size).toBe(6);
  });
});

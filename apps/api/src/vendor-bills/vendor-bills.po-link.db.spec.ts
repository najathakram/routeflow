/**
 * LANE-U step 7 — DB-lane proof for a vendor bill linked to a purchase order.
 *
 * The mock-level spec (`vendor-bills.po-link.spec.ts`) locks the state table and the gate; only
 * a real Postgres can prove what mocks structurally cannot see (B571 was exactly this): the raise-a-PO
 * transaction under the tenant proxy (nested line create, `nextPoNumber(tx)`), the unique
 * `VendorBill.purchaseOrderId` link, rollback atomicity between the two documents, tenant isolation
 * of a PO id, and — the point of guard (e) — that the PO is the ONLY stock mover for a linked bill.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. Drives the REAL `VendorBillsService` and
 * `InventoryService` through a REAL `PrismaService` + `TenantContextService`
 * (pattern: inventory.po-edit.db.spec.ts / invoice-delete-credit.db.spec.ts).
 *
 * SAFETY: every tenant is a throwaway `qa-bill-po-<run>-<n>-<label>` slug approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows this run created, in FK order.
 *
 * NOT EXECUTED by the authoring session (no Postgres it owns) — posted to the board as NEED-DB.
 */

// VendorBillsService imports these at module scope for scanInvoice(); mock them so loading the
// service here never reaches a real SDK / native binary (same guard as the mock-level specs).
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn(() => ({ messages: { create: jest.fn() } })),
}));
jest.mock("sharp", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    rotate: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { VendorBillsService } from "./vendor-bills.service";
import { InventoryService } from "../inventory/inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-bill-po-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "vendor-bills.po-link.db.spec.ts",
  );
};

describeDb("vendor bill ↔ purchase order — real Postgres (LANE-U step 7)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let bills: VendorBillsService;
  let inventory: InventoryService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
        {
          provide: PlatformConfigService,
          useValue: {
            resolveAnthropicKey: jest.fn().mockResolvedValue(null),
            recordAiUsage: jest.fn(),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: DuplicateMatchService,
          useValue: {
            normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
            findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
            findScanDuplicate: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    bills = module.get(VendorBillsService);
    inventory = module.get(InventoryService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.billPayment.deleteMany({ where: { tenantId } });
    // bill items are nested-created (tenantId may be null) — delete through the parent
    const billRows = await prisma.vendorBill.findMany({
      where: { tenantId },
      select: { id: true },
    });
    await prisma.vendorBillItem.deleteMany({
      where: { vendorBillId: { in: billRows.map((b) => b.id) } },
    });
    await prisma.vendorBill.deleteMany({ where: { tenantId } });
    const pos = await prisma.purchaseOrder.findMany({ where: { tenantId }, select: { id: true } });
    await prisma.purchaseOrderItem.deleteMany({ where: { poId: { in: pos.map((p) => p.id) } } });
    await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
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
    const tenant = await prisma.tenant.create({ data: { slug, name: `Bill/PO ${slug}` } });
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
      data: { name: `Supplier ${slug}`, tenantId: tenant.id },
    });
    const product = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
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

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
  const productOf = (w: World) => prisma.product.findUniqueOrThrow({ where: { id: w.productId } });
  const movementCount = (w: World) =>
    prisma.stockMovement.count({ where: { tenantId: w.tenantId } });

  /** One case of 24 @ $30 == 24 pieces @ $1.25. */
  const caseLine = (w: World, o: Record<string, unknown> = {}) => ({
    productId: w.productId,
    description: "Widget 24pk",
    qty: 1,
    unitCost: 30,
    packSize: 24,
    sku: "W-24",
    ...o,
  });

  const billDto = (w: World, o: Record<string, unknown> = {}) => ({
    supplierId: w.supplierId,
    billDate: "2026-09-01",
    items: [caseLine(w)],
    ...o,
  });

  // ── 1. raise a draft PO from the bill's own lines ────────────────────────────────────────
  it("case 1: createPurchaseOrder raises a DRAFT PO from the bill's lines in one transaction and links it", async () => {
    const w = await seedWorld("c1");
    const bill: any = await inTenant(w, () =>
      bills.create(billDto(w, { createPurchaseOrder: true, notes: "Dock 3" })),
    );
    expect(bill.purchaseOrder).toMatchObject({ status: "DRAFT" });
    expect(bill.purchaseOrder.poNumber).toMatch(/^PO-\d{4}-\d{4}$/);

    const po = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: bill.purchaseOrder.id },
      include: { items: true },
    });
    expect(po.supplierId).toBe(w.supplierId);
    expect(po.status).toBe("DRAFT");
    expect(po.notes).toBe("Dock 3");
    expect(po.tenantId).toBe(w.tenantId);
    expect(po.totalAmount.toString()).toBe("30");
    expect(po.items).toHaveLength(1);
    // pieces + per-piece cost, supplier sku / pack size carried through
    expect(po.items[0].qtyOrdered.toString()).toBe("24");
    expect(po.items[0].unitCost.toString()).toBe("1.25");
    expect(po.items[0].sku).toBe("W-24");
    expect(po.items[0].packSize).toBe(24);
    expect(po.items[0].qtyReceived.toString()).toBe("0");
    // B571: the nested lines carry the tenant
    expect(po.items[0].tenantId).toBe(w.tenantId);

    const stored = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(stored.purchaseOrderId).toBe(po.id);
    // raising a draft PO moves no stock
    expect(Number((await productOf(w)).currentStock)).toBe(0);
    expect(await movementCount(w)).toBe(0);
  });

  // ── 2. the ruled flow: bill → PO → receive PO → bill receive (money only) ─────────────────
  it("case 2: the PO is the ONLY stock mover — receiving the PO stocks once, receiving the linked bill adds nothing", async () => {
    const w = await seedWorld("c2");
    const bill: any = await inTenant(w, () =>
      bills.create(billDto(w, { createPurchaseOrder: true })),
    );
    const poId: string = bill.purchaseOrder.id;
    const po = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: poId },
      include: { items: true },
    });

    await inTenant(w, () => inventory.sendPurchaseOrder(poId));
    await inTenant(w, () =>
      inventory.receivePurchaseOrder(
        poId,
        { items: [{ itemId: po.items[0].id, receivedQty: 24 }] },
        w.userId,
      ),
    );
    expect(Number((await productOf(w)).currentStock)).toBe(24);
    expect((await productOf(w)).averageCost!.toString()).toBe("1.25");
    const movementsAfterPo = await movementCount(w);
    const lotsAfterPo = await prisma.stockLot.count({ where: { tenantId: w.tenantId } });

    // now the (linked) bill is received — money only
    const received: any = await inTenant(w, () => bills.receive(bill.id, undefined, w.userId));
    expect(received.status).toBe("RECEIVED");
    expect(Number((await productOf(w)).currentStock)).toBe(24); // NOT 48 — never counted twice
    expect(await movementCount(w)).toBe(movementsAfterPo);
    expect(await prisma.stockLot.count({ where: { tenantId: w.tenantId } })).toBe(lotsAfterPo);
  });

  // ── 3. revert / void of a linked bill leave the PO's stock alone ─────────────────────────
  it("case 3: revertToDraft and voidBill of a linked, received bill reverse nothing", async () => {
    const w = await seedWorld("c3");
    const bill: any = await inTenant(w, () =>
      bills.create(billDto(w, { createPurchaseOrder: true })),
    );
    const poId: string = bill.purchaseOrder.id;
    const po = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: poId },
      include: { items: true },
    });
    await inTenant(w, () => inventory.sendPurchaseOrder(poId));
    await inTenant(w, () =>
      inventory.receivePurchaseOrder(
        poId,
        { items: [{ itemId: po.items[0].id, receivedQty: 24 }] },
        w.userId,
      ),
    );
    await inTenant(w, () => bills.receive(bill.id, undefined, w.userId));
    const movements = await movementCount(w);

    await inTenant(w, () => bills.revertToDraft(bill.id));
    expect(Number((await productOf(w)).currentStock)).toBe(24);
    expect(await movementCount(w)).toBe(movements);

    await inTenant(w, () => bills.receive(bill.id, undefined, w.userId));
    await inTenant(w, () => bills.voidBill(bill.id, w.userId));
    expect(Number((await productOf(w)).currentStock)).toBe(24);
    expect(await movementCount(w)).toBe(movements);
    expect((await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe(
      "VOID",
    );
  });

  // ── 4. CONTROL: an ordinary bill still posts stock ───────────────────────────────────────
  it("case 4 (control): an UNLINKED bill still posts its own stock on receive", async () => {
    const w = await seedWorld("c4");
    const bill: any = await inTenant(w, () => bills.create(billDto(w)));
    expect(bill.purchaseOrder).toBeNull();
    await inTenant(w, () => bills.receive(bill.id, undefined, w.userId));
    expect(Number((await productOf(w)).currentStock)).toBe(24);
    expect(await movementCount(w)).toBe(1);
  });

  // ── 5. the hard gate against an existing PO ──────────────────────────────────────────────
  it("case 5: a bill that exceeds its PO is refused (409) and no bill row is created; a matching one links", async () => {
    const w = await seedWorld("c5");
    const po = await inTenant(w, () =>
      inventory.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 24, unitCost: 1.25 }] },
        w.userId,
      ),
    );
    await expect(
      inTenant(
        w,
        () =>
          bills.create(billDto(w, { purchaseOrderId: po.id, items: [caseLine(w, { qty: 2 })] })), // 48 pcs
      ),
    ).rejects.toMatchObject({ response: { code: "BILL_EXCEEDS_PO" } });
    expect(await prisma.vendorBill.count({ where: { tenantId: w.tenantId } })).toBe(0);

    const ok: any = await inTenant(w, () => bills.create(billDto(w, { purchaseOrderId: po.id })));
    expect(ok.purchaseOrder.id).toBe(po.id);
    expect(
      (await prisma.vendorBill.findUniqueOrThrow({ where: { id: ok.id } })).purchaseOrderId,
    ).toBe(po.id);
  });

  // ── 6. one bill per PO — service check AND the DB unique constraint ──────────────────────
  it("case 6: a second bill for the same PO is refused (409 PO_ALREADY_BILLED) and the DB itself forbids two", async () => {
    const w = await seedWorld("c6");
    const po = await inTenant(w, () =>
      inventory.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 24, unitCost: 1.25 }] },
        w.userId,
      ),
    );
    await inTenant(w, () => bills.create(billDto(w, { purchaseOrderId: po.id })));
    await expect(
      inTenant(w, () =>
        bills.create(billDto(w, { purchaseOrderId: po.id, supplierInvoiceNumber: "INV-2" })),
      ),
    ).rejects.toMatchObject({ response: { code: "PO_ALREADY_BILLED" } });

    // the constraint itself, bypassing the service check
    await expect(
      prisma.vendorBill.create({
        data: {
          billNumber: `RAW-${RUN_SUFFIX}`,
          tenantId: w.tenantId,
          supplierId: w.supplierId,
          purchaseOrderId: po.id,
          totalOwed: 1,
          status: "DRAFT",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  // ── 7. atomicity: a failure after the PO is raised leaves NEITHER document ───────────────
  it("case 7: raise-a-PO is atomic — an unknown product rolls back both the bill and the PO", async () => {
    const w = await seedWorld("c7");
    await expect(
      inTenant(w, () =>
        bills.create(
          billDto(w, {
            createPurchaseOrder: true,
            items: [caseLine(w), caseLine(w, { productId: randomUUID(), description: "Ghost" })],
          }),
        ),
      ),
    ).rejects.toThrow(/not found/);
    expect(await prisma.vendorBill.count({ where: { tenantId: w.tenantId } })).toBe(0);
    expect(await prisma.purchaseOrder.count({ where: { tenantId: w.tenantId } })).toBe(0);
  });

  // ── 8. tenant isolation of a PO id ───────────────────────────────────────────────────────
  it("case 8: another tenant's PO id cannot be linked (404)", async () => {
    const a = await seedWorld("c8a");
    const b = await seedWorld("c8b");
    const foreignPo = await inTenant(b, () =>
      inventory.createPurchaseOrder(
        { supplierId: b.supplierId, items: [{ productId: b.productId, qty: 24, unitCost: 1.25 }] },
        b.userId,
      ),
    );
    await expect(
      inTenant(a, () => bills.create(billDto(a, { purchaseOrderId: foreignPo.id }))),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await prisma.vendorBill.count({ where: { tenantId: a.tenantId } })).toBe(0);
  });

  // ── 9. editing a linked draft bill stays within the PO ───────────────────────────────────
  it("case 9: a linked draft bill can't be edited past its PO, and its supplier can't be re-pointed", async () => {
    const w = await seedWorld("c9");
    const po = await inTenant(w, () =>
      inventory.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty: 24, unitCost: 1.25 }] },
        w.userId,
      ),
    );
    const bill: any = await inTenant(w, () => bills.create(billDto(w, { purchaseOrderId: po.id })));
    await expect(
      inTenant(w, () => bills.update(bill.id, { items: [caseLine(w, { qty: 3 })] })),
    ).rejects.toMatchObject({ response: { code: "BILL_EXCEEDS_PO" } });
    // the failed edit left the original line in place
    const items = await prisma.vendorBillItem.findMany({ where: { vendorBillId: bill.id } });
    expect(items).toHaveLength(1);
    expect(items[0].qty.toString()).toBe("1");

    const other = await prisma.supplier.create({ data: { name: "Other", tenantId: w.tenantId } });
    await expect(
      inTenant(w, () => bills.update(bill.id, { supplierId: other.id })),
    ).rejects.toThrow(/supplier can't be changed/);
  });
});

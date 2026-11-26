/**
 * SA-1268 / P-85 (real Postgres): `DELETE /settings/financial-data` deletes the tenant's vendor bills before its purchase
 * orders. `PurchaseOrderCharge.vendorBillId` is ON DELETE RESTRICT (the charge keeps its bill, SA-1215 set 4), so a tenant
 * holding ONE actual charge aborted the whole wipe on P2003 and rolled it back. The wipe now deletes the tenant's charges
 * first, matched through the parent PO (the allocations cascade with them), and ends with no charges, bills or POs.
 *
 * C7 (observe and report): a charge and its replacement (the self-RESTRICT `reversesChargeId`), and a receipt and its
 * reversal (`reversesReceiptId`, reached through the PO cascade), go in one wipe.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-wpc-<run>-<n>` slug (`assertTestTenant`).
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EmailService } from "../email/email.service";
import { quickKeysSettingsStubProvider } from "../testing/quick-keys-settings-stub";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-1268 C6/C7: clearFinancialData with PO charges (real Postgres)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let controller: SettingsController;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        quickKeysSettingsStubProvider,
      ],
    }).compile();
    controller = mod.get(SettingsController);
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const po = { po: { tenantId } };
      // replacements first: the self-RESTRICT links block a one-statement delete of a chain only if mis-ordered
      await prisma.purchaseOrderCharge
        .deleteMany({ where: { ...po, reversesChargeId: { not: null } } })
        .catch(swallow);
      await prisma.purchaseOrderCharge.deleteMany({ where: po }).catch(swallow);
      await prisma.purchaseOrderReceipt
        .deleteMany({ where: { tenantId, reversesReceiptId: { not: null } } })
        .catch(swallow);
      await prisma.purchaseOrderReceipt.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.vendorBill.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.purchaseOrderItem.deleteMany({ where: po }).catch(swallow);
      await prisma.purchaseOrder.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.product.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.supplier.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /**
   * A tenant with a supplier, a product, a PO with one line and a bill linked to it, and one ACTUAL charge on the bill with
   * one allocation. `chain` adds an ESTIMATE charge that the ACTUAL one replaces, and a receipt with its reversal.
   */
  async function seed(label: string, chain: boolean) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-wpc-${RUN}-${seq}-${label}`,
      "clear-financial-po-charge.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `wpc ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const supplier = await prisma.supplier.create({ data: { name: `s ${slug}`, tenantId } });
    const product = await prisma.product.create({
      data: { name: `p ${slug}`, unit: "Box", pricePerUnit: 10, tenantId },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-WPC-${RUN}-${seq}`,
        supplierId: supplier.id,
        totalAmount: 100,
        tenantId,
        items: {
          create: [
            { productId: product.id, qtyOrdered: 10, unitCost: 10, totalCost: 100, tenantId },
          ],
        },
      },
      include: { items: true },
    });
    const bill = await prisma.vendorBill.create({
      data: {
        billNumber: `BILL-WPC-${RUN}-${seq}`,
        supplierId: supplier.id,
        totalOwed: 120,
        tenantId,
        purchaseOrderId: po.id,
      },
    });
    const estimate = chain
      ? await prisma.purchaseOrderCharge.create({
          data: { tenantId, poId: po.id, kind: "ESTIMATE", amount: 100 },
        })
      : null;
    const actual = await prisma.purchaseOrderCharge.create({
      data: {
        tenantId,
        poId: po.id,
        vendorBillId: bill.id,
        kind: "ACTUAL",
        amount: 120,
        reversesChargeId: estimate?.id ?? null,
        allocations: { create: [{ tenantId, purchaseOrderItemId: po.items[0].id, amount: 120 }] },
      },
    });
    if (chain) {
      const receipt = await prisma.purchaseOrderReceipt.create({
        data: {
          tenantId,
          poId: po.id,
          lines: { create: [{ tenantId, purchaseOrderItemId: po.items[0].id, qtyArriving: 5 }] },
        },
      });
      await prisma.purchaseOrderReceipt.create({
        data: {
          tenantId,
          poId: po.id,
          reversesReceiptId: receipt.id,
          lines: { create: [{ tenantId, purchaseOrderItemId: po.items[0].id, qtyArriving: -5 }] },
        },
      });
    }
    return { tenantId, poId: po.id, billId: bill.id, actualId: actual.id };
  }

  const wipe = (tenantId: string) =>
    tenantCtx.run(tenantId, () =>
      controller.clearFinancialData({ confirmTenantId: tenantId } as any),
    );

  const counts = async (tenantId: string) => ({
    charges: await prisma.purchaseOrderCharge.count({ where: { tenantId } }),
    allocations: await prisma.purchaseOrderChargeAllocation.count({ where: { tenantId } }),
    bills: await prisma.vendorBill.count({ where: { tenantId } }),
    pos: await prisma.purchaseOrder.count({ where: { tenantId } }),
    receipts: await prisma.purchaseOrderReceipt.count({ where: { tenantId } }),
    receiptLines: await prisma.purchaseOrderReceiptLine.count({ where: { tenantId } }),
  });

  it("C6: a tenant with one ACTUAL charge on a bill wipes: no charges, bills or POs afterwards (master order: P2003 rollback)", async () => {
    const s = await seed("one", false);

    await wipe(s.tenantId);

    expect(await counts(s.tenantId)).toEqual({
      charges: 0,
      allocations: 0,
      bills: 0,
      pos: 0,
      receipts: 0,
      receiptLines: 0,
    });
  }, 60_000);

  it("C7: a charge with its replacement, and a receipt with its reversal, go in the same wipe", async () => {
    const s = await seed("chain", true);
    expect((await counts(s.tenantId)).charges).toBe(2);
    expect((await counts(s.tenantId)).receipts).toBe(2);

    await wipe(s.tenantId);

    expect(await counts(s.tenantId)).toEqual({
      charges: 0,
      allocations: 0,
      bills: 0,
      pos: 0,
      receipts: 0,
      receiptLines: 0,
    });
  }, 60_000);

  it("scope: the wipe deletes ONLY the calling tenant's charges", async () => {
    const mine = await seed("mine", false);
    const other = await seed("other", false);

    await wipe(mine.tenantId);

    expect(await counts(other.tenantId)).toEqual({
      charges: 1,
      allocations: 1,
      bills: 1,
      pos: 1,
      receipts: 0,
      receiptLines: 0,
    });
  }, 60_000);
});

/**
 * SA-1130 (amends SA-1124 PR-1b) - real Postgres. Every import write to an EXISTING invoice asks the offline price
 * review gate on the LOCKED row, inside the same transaction: a row whose invoice belongs to an order with an open
 * PRICE_CHANGED_OFFLINE flag is SKIPPED with one stated reason (never a failed file). Nothing is written on a
 * skipped row: no status change, no payment, the zoho-import placeholder stays, the flag stays open.
 *
 *   I-1  importPayments onto a flagged order: skipped, 0 payments, placeholder kept, invoice unchanged.
 *   I-2  source-number re-import (file says PAID) vs a flagged DRAFT: skipped, stays DRAFT, no payment.
 *   I-2b Invoice ID re-import whose prior carries a flagged order link: skipped, no status write, no synthetic payment.
 *   I-3  both of the above import normally once the flag is resolved.
 *   I-4  an invoice with no order link behaves as before, even while another order of the tenant is flagged.
 *   I-5  a NEW imported PAID invoice keeps its synthetic payment.
 *
 * Throwaway `qa-*` tenants (assertTestTenant); afterAll deletes what it made. Runs on the DB lane.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoiceStatus } from "@prisma/client";
import { ImportService } from "./import.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const YEAR = new Date().getFullYear();
const REASON = "This order has a price change to review. Review it, then import this row again.";

describeDb("SA-1130 the import honours the offline price-review gate (real Postgres)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let importService: ImportService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportService,
        NumberingService,
        ExternalRefService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ProductsService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: "prod-1" }),
            update: jest.fn().mockResolvedValue({ id: "prod-1" }),
            emitCatalogBulkChanged: jest.fn(),
            assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
            assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            judgeStaffWrite: jest.fn().mockResolvedValue({
              outcome: "ALLOW",
              reasons: [],
              breaches: [],
              basis: "CUSTOMER",
            }),
          },
        },
      ],
    }).compile();
    importService = module.get(ImportService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.orderReviewFlag.deleteMany(where).catch(swallow);
      await prisma.importExternalRef.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.numberingSequence.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-i1130-${RUN}-${seq}-${label}`,
      "import-review-gate.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `qa ${slug}` } });
    tenantIds.push(tenant.id);
    const idBase = `${tenant.id}-cust`.replace(/[^a-z0-9]+/gi, "_");
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "QA Import Co",
        contactName: "QA",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, customerId: customer.id };
  }

  /** An order with one line and an open PRICE_CHANGED_OFFLINE flag; returns the order and the flag id. */
  async function flaggedOrder(tenantId: string, customerId: string) {
    const product = await prisma.product.create({
      data: { tenantId, name: `p ${RUN}-${(seq += 1)}`, unit: "each", pricePerUnit: 100 },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId,
        fulfillPath: "ROUTE",
        status: "CONFIRMED",
        subtotal: 100,
        tax: 0,
        total: 100,
      },
    });
    const li = await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: product.id,
        qty: 1,
        unitPrice: 100,
        subtotal: 100,
      },
    });
    const flag = await prisma.orderReviewFlag.create({
      data: {
        tenantId,
        orderId: order.id,
        orderItemId: li.id,
        kind: "PRICE_CHANGED_OFFLINE",
        detail: { quotedUnitPrice: 90, currentUnitPrice: 100 },
      },
    });
    return { orderId: order.id, flagId: flag.id };
  }

  const resolve = (flagId: string) =>
    prisma.orderReviewFlag.update({
      where: { id: flagId },
      data: { resolvedAt: new Date(), resolution: "price reviewed" },
    });
  const openFlags = (orderId: string) =>
    prisma.orderReviewFlag.count({ where: { orderId, resolvedAt: null } });

  async function seedInvoice(
    tenantId: string,
    customerId: string,
    number: string,
    status: InvoiceStatus,
    orderId: string | null,
  ) {
    return prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId,
        invoiceNumber: number,
        status,
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        issueDate: new Date(),
      } as any,
    });
  }

  /** The importInvoices placeholder an earlier PAID/PARTIAL import wrote. */
  const seedPlaceholder = (tenantId: string, invoiceId: string) =>
    prisma.invoicePayment.create({
      data: {
        tenantId,
        invoiceId,
        amount: 100,
        method: "OTHER",
        reference: "zoho-import",
        notes: "Imported from Zoho",
      },
    });

  const state = async (invoiceId: string) => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const payments = await prisma.invoicePayment.findMany({ where: { invoiceId } });
    return {
      status: inv.status,
      payments: payments.length,
      references: payments.map((p) => p.reference).sort(),
    };
  };

  const numberedCsv = (number: string) =>
    `Invoice Number,Customer Name,Total,Balance Due,Invoice Status\n${number},QA Import Co,100,0,Paid\n`;
  const numberlessCsv = (ref: string, balance: string, status: string) =>
    `Invoice ID,Customer Name,Total,Balance Due,Invoice Status\n${ref},QA Import Co,100,${balance},${status}\n`;
  const paymentsCsv = (number: string) =>
    `Invoice Number,Amount Applied to Invoice,Mode,Date\n${number},100,Cash,${YEAR}-01-02\n`;
  const importInvoices = (tenantId: string, csv: string) =>
    tenantCtx.run(tenantId, () => importService.importInvoices(Buffer.from(csv), "user-1"));
  const importPayments = (tenantId: string, csv: string) =>
    tenantCtx.run(tenantId, () => importService.importPayments(Buffer.from(csv), "user-1"));

  it("I-1: importPayments onto a flagged order's invoice is skipped with the reason: 0 new payments, placeholder kept, invoice unchanged, flag open", async () => {
    const { tenantId, customerId } = await seedTenant("i1");
    const { orderId } = await flaggedOrder(tenantId, customerId);
    const number = `INV-${YEAR}-8001`;
    const inv = await seedInvoice(tenantId, customerId, number, InvoiceStatus.DRAFT, orderId);
    await seedPlaceholder(tenantId, inv.id);

    const r = await importPayments(tenantId, paymentsCsv(number));

    expect(r.errors).toEqual([`Payment for ${number}: ${REASON}`]);
    expect({ imported: r.imported, skipped: r.skipped }).toEqual({ imported: 0, skipped: 1 });
    expect(await state(inv.id)).toEqual({
      status: InvoiceStatus.DRAFT,
      payments: 1,
      references: ["zoho-import"],
    });
    expect(await openFlags(orderId)).toBe(1);
  }, 30_000);

  it("I-2: a source-number PAID re-import vs a flagged DRAFT is skipped with the reason and stays DRAFT", async () => {
    const { tenantId, customerId } = await seedTenant("i2");
    const { orderId } = await flaggedOrder(tenantId, customerId);
    const number = `INV-${YEAR}-8101`;
    const inv = await seedInvoice(tenantId, customerId, number, InvoiceStatus.DRAFT, orderId);

    const r = await importInvoices(tenantId, numberedCsv(number));

    expect(r.errors).toEqual([`${number}: ${REASON}`]);
    expect({ updated: r.updated, skipped: r.skipped }).toEqual({ updated: 0, skipped: 1 });
    expect(await state(inv.id)).toEqual({
      status: InvoiceStatus.DRAFT,
      payments: 0,
      references: [],
    });
    expect(await openFlags(orderId)).toBe(1);
  }, 30_000);

  it("I-2b: an Invoice ID re-import whose prior carries a flagged order link is skipped: no status write, no synthetic payment", async () => {
    const { tenantId, customerId } = await seedTenant("i2b");
    const ref = `zoho-${RUN}-i2b`;
    const r1 = await importInvoices(tenantId, numberlessCsv(ref, "100", "Sent"));
    expect(r1.imported).toBe(1);
    const inv = (await prisma.invoice.findMany({ where: { tenantId } }))[0];
    const { orderId } = await flaggedOrder(tenantId, customerId);
    await prisma.invoice.update({ where: { id: inv.id }, data: { orderId } });

    const r = await importInvoices(tenantId, numberlessCsv(ref, "0", "Paid"));

    expect(r.errors).toEqual([`import-ref ${ref}: ${REASON}`]);
    expect({ updated: r.updated, imported: r.imported }).toEqual({ updated: 0, imported: 0 });
    expect((await state(inv.id)).status).toBe(InvoiceStatus.SENT);
    expect((await state(inv.id)).payments).toBe(0);
    expect(await prisma.invoice.count({ where: { tenantId } })).toBe(1); // never re-minted
    expect(await openFlags(orderId)).toBe(1);
  }, 30_000);

  it("I-3: after the flag is resolved the same rows import normally (one payment replaces the placeholder; the DRAFT syncs to PAID)", async () => {
    const { tenantId, customerId } = await seedTenant("i3");
    const a = await flaggedOrder(tenantId, customerId);
    const payNumber = `INV-${YEAR}-8201`;
    const payInv = await seedInvoice(
      tenantId,
      customerId,
      payNumber,
      InvoiceStatus.DRAFT,
      a.orderId,
    );
    await seedPlaceholder(tenantId, payInv.id);
    const b = await flaggedOrder(tenantId, customerId);
    const syncNumber = `INV-${YEAR}-8202`;
    const syncInv = await seedInvoice(
      tenantId,
      customerId,
      syncNumber,
      InvoiceStatus.DRAFT,
      b.orderId,
    );

    expect((await importPayments(tenantId, paymentsCsv(payNumber))).imported).toBe(0);
    expect((await importInvoices(tenantId, numberedCsv(syncNumber))).updated).toBe(0);
    await resolve(a.flagId);
    await resolve(b.flagId);

    const rp = await importPayments(tenantId, paymentsCsv(payNumber));
    const ri = await importInvoices(tenantId, numberedCsv(syncNumber));

    expect(rp.errors).toEqual([]);
    expect(rp.imported).toBe(1);
    expect(await state(payInv.id)).toEqual({
      status: InvoiceStatus.DRAFT, // a DRAFT is never auto-flipped by the payment sweep
      payments: 1,
      references: [null],
    });
    expect(ri.errors).toEqual([]);
    expect(ri.updated).toBe(1);
    expect((await state(syncInv.id)).status).toBe(InvoiceStatus.PAID);
  }, 60_000);

  it("I-4: an invoice with no order link behaves as before while another order of the tenant is flagged", async () => {
    const { tenantId, customerId } = await seedTenant("i4");
    const { orderId } = await flaggedOrder(tenantId, customerId);
    const ref = `zoho-${RUN}-i4`;
    const r1 = await importInvoices(tenantId, numberlessCsv(ref, "100", "Sent"));
    expect(r1.imported).toBe(1);
    const inv = (await prisma.invoice.findMany({ where: { tenantId } }))[0];
    expect(inv.orderId).toBeNull();

    const r = await importInvoices(tenantId, numberlessCsv(ref, "0", "Paid"));

    expect(r.errors).toEqual([]);
    expect(r.updated).toBe(1);
    expect(await state(inv.id)).toEqual({
      status: InvoiceStatus.PAID,
      payments: 1,
      references: ["zoho-import"],
    });
    expect(await openFlags(orderId)).toBe(1);
  }, 30_000);

  it("I-5: a new PAID import keeps its synthetic payment", async () => {
    const { tenantId } = await seedTenant("i5");
    const number = `INV-${YEAR}-8501`;

    const r = await importInvoices(tenantId, numberedCsv(number));

    expect(r.errors).toEqual([]);
    expect(r.imported).toBe(1);
    const inv = await prisma.invoice.findFirstOrThrow({
      where: { tenantId, invoiceNumber: number },
    });
    expect(await state(inv.id)).toEqual({
      status: InvoiceStatus.PAID,
      payments: 1,
      references: ["zoho-import"],
    });
  }, 30_000);
});

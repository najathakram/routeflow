/**
 * SA-1060 amendment A-4: the CAPTURE rows for NS-7 and NS-8, through the real OrdersService.updateOrderItems().
 *
 * The sibling spec (inline-returns-never-sold.a4.db.spec.ts) proves what the screen (the quote with `editingOrderId`) and the
 * note (the dry run) say. This one proves what the edit WRITES: the real order edit, the real revert of the order's linked
 * invoices (`revertLinkedInvoicesToDraft`, the function the invoice service calls), and the real in-transaction capture. Each
 * row quotes first (the screen, with `editingOrderId`), then runs the edit, and compares the credit note, the return line and
 * the stock to the quote.
 *
 * Fixture: 10 at $10.00 with an 8% tenant tax rate, return 3. NS-7: the order's own unpaid SENT invoice is the customer's only
 * sale of the product, so the edit reverts it to a DRAFT of an undelivered order and the goods were never sold: $30.00, no tax,
 * no stock movement. NS-8: a paid sale on another invoice exists too: $32.40 with $2.40 tax, and a RETURN stock movement.
 *
 * Run via `npm run local:test:db` (compose Postgres) - collected only by jest.db.config.js.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { OrdersService } from "../orders/orders.service";
import { revertLinkedInvoicesToDraft } from "../invoices/order-edit-revert-set";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1060 A-4 - the order edit's capture matches the quote, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let quoteService: InlineReturnsQuoteService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-sa1060a4c-${run}`,
    "inline-returns-never-sold.capture.a4.db.spec.ts",
  );
  let tenantId = "";
  let operatorId = "";
  const orderIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];
  const invoiceIds: string[] = [];
  let seq = 0;

  const staff = (): JwtPayload =>
    ({
      sub: operatorId,
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  /** An invoice of 10 at $10.00 with 8% tax, one line of the product. */
  async function invoice(p: {
    customerId: string;
    productId: string;
    orderId: string | null;
    status: string;
  }) {
    const inv = await raw.invoice.create({
      data: {
        tenantId,
        customerId: p.customerId,
        orderId: p.orderId,
        invoiceNumber: `INV-A4C-${run}-${++seq}`,
        status: p.status as any,
        subtotal: "100.00",
        taxAmount: "8.00",
        total: "108.00",
        issueDate: new Date(Date.now() - 10 * 86_400_000),
      },
    });
    invoiceIds.push(inv.id);
    await raw.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: inv.id,
        productId: p.productId,
        description: "Widget",
        qty: 10,
        unitPrice: "10.00",
        subtotal: "100.00",
        taxRate: "0.08",
      },
    });
    return inv.id;
  }

  /** A customer, a product, and a CONFIRMED order (one line of 10) whose own SENT invoice is being edited. */
  async function editedOrder(tag: string) {
    const product = await raw.product.create({
      data: {
        name: `${tag} product ${run} ${++seq}`,
        unit: "each",
        pricePerUnit: "10.00",
        currentStock: "1000",
        tenantId,
      },
    });
    productIds.push(product.id);
    const u = await raw.user.create({
      data: {
        email: `${tag}-${run}-${++seq}@example.test`,
        username: `${tag}-${run}-${seq}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(u.id);
    const c = await raw.customer.create({
      data: { userId: u.id, businessName: `${tag} co`, contactName: "A4 Tester", tenantId },
    });
    customerIds.push(c.id);
    const order = await raw.order.create({
      data: {
        customerId: c.id,
        tenantId,
        status: "CONFIRMED",
        subtotal: "100.00",
        total: "100.00",
        lineItems: {
          create: [
            { productId: product.id, qty: 10, unitPrice: "10.00", subtotal: "100.00", tenantId },
          ],
        },
      },
    });
    orderIds.push(order.id);
    const own = await invoice({
      customerId: c.id,
      productId: product.id,
      orderId: order.id,
      status: "SENT",
    });
    return { customerId: c.id, productId: product.id, orderId: order.id, ownInvoiceId: own };
  }

  /** The screen: POST /returns/inline/quote from the order edit, which names the order it is editing. */
  const quote = (f: { customerId: string; productId: string; orderId: string }) =>
    tenantCtx.run(tenantId, () =>
      quoteService.quote(
        {
          customerId: f.customerId,
          editingOrderId: f.orderId,
          items: [{ productId: f.productId, boxes: 0, pieces: 3 }],
        } as any,
        staff(),
      ),
    );

  /** The edit: the real updateOrderItems, items unchanged, with the 3-piece return. */
  const edit = (f: { productId: string; orderId: string }, key: string) =>
    tenantCtx.run(tenantId, () =>
      orders.updateOrderItems(
        f.orderId,
        {
          items: [{ productId: f.productId, qty: 10 }],
          inlineReturn: {
            items: [{ productId: f.productId, boxes: 0, pieces: 3 }],
            returnKey: key,
          },
        },
        staff(),
      ),
    );

  /** What the edit wrote for this customer's one return: the credit note, the return line and the stock movements. */
  async function written(f: { customerId: string; productId: string }) {
    const cns = await raw.creditNote.findMany({ where: { customerId: f.customerId } });
    const rets = await raw.return.findMany({ where: { customerId: f.customerId } });
    const items = await raw.returnItem.findMany({
      where: { returnId: { in: rets.map((r) => r.id) } },
    });
    const movements = await raw.stockMovement.count({
      where: { productId: f.productId, type: "RETURN" },
    });
    return { cns, rets, items, movements };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const idempotency = new IdempotencyService();
    const numbering = new NumberingService(prisma);
    const ledger = new RegulatedLedgerService(prisma);
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    const featureConfig = { getEffectiveMode: async () => "ship" };
    quoteService = new (InlineReturnsQuoteService as any)(
      prisma,
      systemConfig,
      undefined,
      featureConfig,
    );
    const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      commissionEngine: {
        syncInvoiceCommissionSafe: async () => undefined,
        syncOrderInvoices: async () => undefined,
        removeInvoiceCommission: async () => undefined,
      },
      numbering,
      logger: new Logger(CreditNotesService.name),
    });
    const inlineSvc: any = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService,
      idempotency,
    });
    const invoicesService = {
      // The REAL revert selection and write (the function InvoicesService.revertLinkedInvoicesForOrderEdit calls).
      revertLinkedInvoicesForOrderEdit: async (orderId: string, tx?: any, opts?: any) =>
        revertLinkedInvoicesToDraft(tx ?? prisma.forTenant(), orderId, opts),
      resyncOrderInvoicesForEdit: async () => [],
      ...INVOICE_EDIT_STUBS,
      reconcileOrderDraftInvoice: async () => undefined,
    };
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
      systemConfig,
      featureConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        assertLinesSellable: async () => undefined,
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      creditNotes,
      ledger,
      tenantCtx,
      invoicesService,
      logger: new Logger(OrdersService.name),
      inlineReturns: inlineSvc,
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `A4C ${slug}` } })).id;
    const op = await raw.user.create({
      data: {
        email: `a4c-op-${run}@example.test`,
        username: `a4c-op-${run}`,
        role: "OPERATOR",
        tenantId,
      },
    });
    userIds.push(op.id);
    operatorId = op.id;
    await raw.systemConfig.create({ data: { tenantId, key: "settings.taxRate", value: "8" } });
  }, 120_000);

  afterAll(async () => {
    await raw.orderCreditNote.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.returnItem.deleteMany({ where: { return: { orderId: { in: orderIds } } } });
    await raw.return.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.creditNoteItem.deleteMany({ where: { creditNote: { tenantId } } });
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.creditNote.deleteMany({ where: { tenantId } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await raw.orderRevision.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.systemConfig.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  it("NS-7 capture: the order's own unpaid SENT invoice is the only sale -> the edit credits $30.00 with no tax, adds nothing to stock, and matches the quote", async () => {
    const f = await editedOrder("ns7c");
    const q = await quote(f);
    expect({
      total: q.total,
      tax: q.taxAmount,
      neverSold: q.chunks.map((c) => c.neverSold),
    }).toEqual({
      total: 30,
      tax: 0,
      neverSold: [true],
    });

    await edit(f, `ns7c-${run}`);

    // the real revert ran: the SENT invoice is now a DRAFT of the undelivered order, which is what made the goods never sold
    expect((await raw.invoice.findUniqueOrThrow({ where: { id: f.ownInvoiceId } })).status).toBe(
      "DRAFT",
    );
    const w = await written(f);
    expect(w.cns).toHaveLength(1);
    expect(Number(w.cns[0].amount)).toBe(q.total);
    expect(w.items).toHaveLength(1);
    expect(Number(w.items[0].taxAmount)).toBe(q.taxAmount);
    expect(Number(w.items[0].subtotal)).toBe(30);
    expect(w.items[0].restock).toBe(false);
    expect(w.movements).toBe(0);
  }, 90_000);

  it("NS-8 capture: plus a paid sale on another invoice -> the edit credits $32.40 with $2.40 tax, puts 3 back to stock, and matches the quote", async () => {
    const f = await editedOrder("ns8c");
    await invoice({
      customerId: f.customerId,
      productId: f.productId,
      orderId: null,
      status: "PAID",
    });
    const q = await quote(f);
    expect({
      total: q.total,
      tax: q.taxAmount,
      neverSold: q.chunks.map((c) => c.neverSold),
    }).toEqual({
      total: 32.4,
      tax: 2.4,
      neverSold: [false],
    });

    await edit(f, `ns8c-${run}`);

    expect((await raw.invoice.findUniqueOrThrow({ where: { id: f.ownInvoiceId } })).status).toBe(
      "DRAFT",
    );
    const w = await written(f);
    expect(w.cns).toHaveLength(1);
    expect(Number(w.cns[0].amount)).toBe(q.total);
    expect(w.items).toHaveLength(1);
    expect(Number(w.items[0].taxAmount)).toBe(q.taxAmount);
    expect(Number(w.items[0].subtotal)).toBe(30);
    expect(w.items[0].restock).toBe(true);
    expect(w.movements).toBe(1);
  }, 90_000);
});

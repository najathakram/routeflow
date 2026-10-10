/**
 * B949 (HIGH money; real Postgres): the SOURCE_DELETED restore guard, proved THROUGH THE SERVICES that call it (the primitive-level
 * cases are restore-source-gone.db.spec.ts):
 *   (a) OrdersService.changeStatus -> CANCELLED on an order whose invoice holds a marked note's application. The cancel writes its
 *       CANCELLED claim and the stock return BEFORE it reaches the credit release, so this proves the ROLLBACK: the 409 leaves the
 *       order not cancelled, its lines live, the product stock unchanged, the invoice PAID and the payment and note untouched.
 *   (b) InvoicesService.voidInvoice end to end: the same 409, the invoice stays PAID, nothing moves.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-b949s-<run>` slug approved by `assertTestTenant`.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "./credit-notes.service";
import { OrdersService } from "../orders/orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "B949: the restore guard through OrdersService cancel and InvoicesService.voidInvoice: real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: OrdersService;
    let invoices: InvoicesService;
    const tenantIds: string[] = [];
    let seq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      // Object.create bypasses Nest DI (the sa218-lock-order.db.spec.ts pattern): prisma is the REAL connected service, so each
      // method runs its real transaction. Unknown collaborators answer any method with a no-op (never `then`).
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const creditNotes = new CreditNotesService(
        prisma,
        anyMethod as any,
        anyMethod as any,
        { syncInvoiceCommissionSafe: async () => undefined } as any,
        anyMethod as any,
      );
      invoices = Object.assign(Object.create(InvoicesService.prototype), {
        prisma,
        creditNotes,
        ledger: anyMethod,
        gateway: anyMethod,
        commissionEngine: anyMethod,
        logger: new Logger("b949s-invoices"),
      });
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        creditNotes,
        invoicesService: invoices,
        gateway: anyMethod,
        authGuard: anyMethod,
        sellingRestrictions: anyMethod,
        logger: new Logger("b949s-orders"),
      });
    });

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.stockMovement.deleteMany(where).catch(swallow);
        await prisma.invoicePayment.deleteMany(where).catch(swallow);
        await prisma.creditNoteApplyBlock.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
        await prisma.invoiceItem.deleteMany(where).catch(swallow);
        await prisma.invoice.deleteMany(where).catch(swallow);
        await prisma.orderItem.deleteMany(where).catch(swallow);
        await prisma.order.deleteMany(where).catch(swallow);
        await prisma.product.deleteMany(where).catch(swallow);
        await prisma.customer.deleteMany(where).catch(swallow);
        await prisma.user.deleteMany(where).catch(swallow);
        await prisma.auditLog.deleteMany(where).catch(swallow);
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
      }
      await prisma?.$disconnect();
    });

    /** A PENDING order (1 line, 2 pieces, stock 10) with ONE PAID invoice funded by a SOURCE_DELETED note's $100 application. */
    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-b949s-${RUN}-${seq}-${label}`,
        "restore-source-gone-services.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `b949s ${slug}` } });
      tenantIds.push(tenant.id);
      const tenantId = tenant.id;
      const user = await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
      });
      const customer = await prisma.customer.create({
        data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
      });
      const product = await prisma.product.create({
        data: { tenantId, name: `P ${slug}`, unit: "each", pricePerUnit: 50, currentStock: 10 },
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-B949S-${RUN}-${seq}`,
          subtotal: 100,
          tax: 0,
          total: 100,
          status: "PENDING",
        } as any,
      });
      const item = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          qty: 2,
          unitPrice: 50,
          subtotal: 100,
        } as any,
      });
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-B949S-${RUN}-${seq}`,
          status: "PAID",
          subtotal: 100,
          taxAmount: 0,
          total: 100,
        },
      });
      const note = await prisma.creditNote.create({
        data: {
          tenantId,
          customerId: customer.id,
          creditNoteNumber: `CN-B949S-${RUN}-${seq}`,
          amount: 100,
          amountUsed: 100,
          status: "APPLIED",
          appliedToInvoiceId: invoice.id,
        },
      });
      await prisma.auditLog.create({
        data: { tenantId, action: "SOURCE_DELETED", entityType: "CreditNote", entityId: note.id },
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          amount: 100,
          method: "CREDIT_NOTE",
          status: "PAID",
          creditNoteId: note.id,
          paymentNumber: `PAY-B949S-${RUN}-${seq}`,
        } as any,
      });
      const jwt = {
        sub: user.id,
        username: slug,
        role: "OPERATOR" as any,
        status: "ACTIVE" as any,
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      };
      return { tenantId, order, item, product, invoice, note, jwt };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;

    /** Everything the refused operation must NOT have changed. */
    async function snapshot(s: Seed) {
      const [order, item, product, invoice, payments, note] = await Promise.all([
        prisma.order.findUnique({ where: { id: s.order.id } }),
        prisma.orderItem.findUnique({ where: { id: s.item.id } }),
        prisma.product.findUnique({ where: { id: s.product.id } }),
        prisma.invoice.findUnique({ where: { id: s.invoice.id } }),
        prisma.invoicePayment.count({ where: { invoiceId: s.invoice.id, method: "CREDIT_NOTE" } }),
        prisma.creditNote.findUnique({ where: { id: s.note.id } }),
      ]);
      return {
        orderStatus: order!.status,
        itemStatus: item!.status,
        stock: Number(product!.currentStock),
        invoiceStatus: invoice!.status,
        payments,
        noteStatus: note!.status,
        noteUsed: Number(note!.amountUsed),
      };
    }

    it("(a) cancelling the order is REFUSED 409 CREDIT_NOTE_SOURCE_GONE and the WHOLE cancel rolls back: not CANCELLED, lines live, stock unchanged, invoice PAID, payment and note untouched", async () => {
      const s = await seed("cancel");
      const before = await snapshot(s);
      const err: any = await tenantCtx
        .run(s.tenantId, () =>
          orders.changeStatus(s.order.id, { status: "CANCELLED" } as any, s.jwt as any),
        )
        .catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: "CREDIT_NOTE_SOURCE_GONE" });
      expect(err.getResponse().message).toMatch(/Void that credit note first/);
      const after = await snapshot(s);
      expect(after).toEqual(before);
      expect(after.orderStatus).toBe("PENDING"); // the CANCELLED claim was rolled back
      expect(after.stock).toBe(10); // the stock return was rolled back
      expect(after.noteUsed).toBe(100);
    }, 120_000);

    it("(b) voidInvoice end to end is REFUSED 409 CREDIT_NOTE_SOURCE_GONE: the invoice stays PAID, the payment and the note are untouched", async () => {
      const s = await seed("void");
      const before = await snapshot(s);
      const err: any = await tenantCtx
        .run(s.tenantId, () => invoices.voidInvoice(s.invoice.id))
        .catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: "CREDIT_NOTE_SOURCE_GONE" });
      expect(err.getResponse().message).toMatch(/Void that credit note first/);
      expect(await snapshot(s)).toEqual(before);
      expect((await snapshot(s)).invoiceStatus).toBe("PAID");
    }, 120_000);
  },
);

/**
 * SA-773: rows for the refundable-remainder DB specs - one throwaway tenant per case with an order, its invoices (paid in full
 * in cash, so a cash refund is allowed), their lines at a given qty / net subtotal / tax rate, and builders for credit notes and
 * returns. Every tenant slug goes through `assertTestTenant` (`qa-*`), and `cleanupSeeded` deletes exactly the tenants a run
 * created. Never imported by production code (this folder is outside src and the build; eslint and the source scanners do not walk it).
 */
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs") as {
  assertTestTenant: (slug: string, file: string) => string;
};

export interface SeedLine {
  /** a key of the order's products; the same key on two lines is one product sold on two lines */
  product: string;
  qty: number;
  /** net (pre-tax) line subtotal */
  subtotal: number;
  taxRate?: number;
  categoryTaxAmount?: number;
}
export interface SeedInvoice {
  lines: SeedLine[];
  /** defaults to the sum of the lines' gross values */
  total?: number;
}
export interface Seeded {
  tenantId: string;
  userId: string;
  customerId: string;
  orderId: string;
  products: Record<string, string>;
  invoices: Array<{
    id: string;
    lines: Array<{ id: string; productId: string; orderItemId: string }>;
  }>;
}

let seq = 0;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function seedRefundable(
  prisma: any,
  tenantIds: string[],
  opts: { run: string; spec: string; label: string; invoices: SeedInvoice[] },
): Promise<Seeded> {
  seq += 1;
  const slug = assertTestTenant(
    `qa-sa773-${opts.run}-${seq}-${opts.label}`.slice(0, 60),
    opts.spec,
  );
  const tenant = await prisma.tenant.create({ data: { slug, name: `sa773 ${slug}` } });
  tenantIds.push(tenant.id);
  const tenantId = tenant.id;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
  });
  const customer = await prisma.customer.create({
    data: {
      userId: user.id,
      businessName: `c ${opts.label}`,
      contactName: `c ${opts.label}`,
      tenantId,
    },
  });
  const gross = (l: SeedLine) =>
    round2(l.subtotal + round2(l.subtotal * (l.taxRate ?? 0)) + (l.categoryTaxAmount ?? 0));
  const grandTotal = opts.invoices.reduce(
    (t, inv) => t + (inv.total ?? inv.lines.reduce((s, l) => s + gross(l), 0)),
    0,
  );
  const order = await prisma.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      orderNumber: `ORD-SA773-${opts.run}-${seq}`,
      subtotal: grandTotal,
      tax: 0,
      total: grandTotal,
      status: "PENDING",
    },
  });
  const products: Record<string, string> = {};
  const productOf = async (key: string): Promise<string> => {
    if (!products[key]) {
      const p = await prisma.product.create({
        data: { tenantId, name: `${key} ${slug}`, unit: "each", pricePerUnit: 10 },
      });
      products[key] = p.id;
    }
    return products[key];
  };
  const invoices: Seeded["invoices"] = [];
  for (let i = 0; i < opts.invoices.length; i++) {
    const spec = opts.invoices[i];
    const total = spec.total ?? spec.lines.reduce((s, l) => s + gross(l), 0);
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-SA773-${opts.run}-${seq}-${i}`,
        status: "PAID",
        subtotal: spec.lines.reduce((s, l) => s + l.subtotal, 0),
        taxAmount: 0,
        total,
      },
    });
    const lines: Seeded["invoices"][number]["lines"] = [];
    for (const l of spec.lines) {
      const productId = await productOf(l.product);
      const orderItem = await prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId,
          name: l.product,
          qty: l.qty,
          unitPrice: l.qty > 0 ? round2(l.subtotal / l.qty) : 0,
          subtotal: l.subtotal,
        },
      });
      const item = await prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          orderItemId: orderItem.id,
          productId,
          description: l.product,
          qty: l.qty,
          unitPrice: l.qty > 0 ? round2(l.subtotal / l.qty) : 0,
          subtotal: l.subtotal,
          taxRate: l.taxRate ?? 0,
          categoryTaxAmount: l.categoryTaxAmount ?? 0,
        },
      });
      lines.push({ id: item.id, productId, orderItemId: orderItem.id });
    }
    await prisma.invoicePayment.create({
      data: { tenantId, invoiceId: invoice.id, amount: total, method: "CASH", status: "PAID" },
    });
    invoices.push({ id: invoice.id, lines });
  }
  return {
    tenantId,
    userId: user.id,
    customerId: customer.id,
    orderId: order.id,
    products,
    invoices,
  };
}

/** A credit note on invoice `invoice`; with `items` it is item-bearing (amount = their sum), else amount-only. */
export async function addCreditNote(
  prisma: any,
  s: Seeded,
  opts: {
    number: string;
    invoice?: number;
    amount?: number;
    status?: "ISSUED" | "APPLIED" | "VOID";
    items?: Array<{
      invoice?: number;
      line: number;
      amount: number;
      qty: number;
      categoryTax?: number;
    }>;
  },
) {
  const items = opts.items ?? [];
  const amount = opts.amount ?? round2(items.reduce((t, i) => t + i.amount, 0));
  const invoiceId =
    opts.invoice === undefined && items.length === 0 ? null : s.invoices[opts.invoice ?? 0].id;
  const cn = await prisma.creditNote.create({
    data: {
      tenantId: s.tenantId,
      creditNoteNumber: opts.number,
      customerId: s.customerId,
      invoiceId,
      amount,
      status: opts.status ?? "ISSUED",
      reason: "SA-773 spec",
    },
  });
  for (const it of items) {
    await prisma.creditNoteItem.create({
      data: {
        tenantId: s.tenantId,
        creditNoteId: cn.id,
        invoiceItemId: s.invoices[it.invoice ?? opts.invoice ?? 0].lines[it.line].id,
        amount: it.amount,
        qty: it.qty,
        categoryTax: it.categoryTax ?? 0,
      },
    });
  }
  return cn;
}

/** A STANDARD return of the order (items in the order line's unit; no item money is stored for a STANDARD return). */
export async function addStandardReturn(
  prisma: any,
  s: Seeded,
  opts: {
    number: string;
    status: string;
    items: Array<{ product: string; qty: number }>;
    creditNoteId?: string | null;
    refundMethod?: string | null;
    refundAmount?: number | null;
  },
) {
  return prisma.return.create({
    data: {
      tenantId: s.tenantId,
      orderId: s.orderId,
      customerId: s.customerId,
      reason: "DAMAGED",
      status: opts.status,
      returnNumber: opts.number,
      creditNoteId: opts.creditNoteId ?? null,
      refundMethod: opts.refundMethod ?? null,
      refundAmount: opts.refundAmount ?? null,
      items: {
        create: opts.items.map((i) => ({
          tenantId: s.tenantId,
          productId: s.products[i.product],
          qty: i.qty,
        })),
      },
    },
  });
}

/** An INLINE return sourced from the order's lines: qty in pieces and the stored item money. */
export async function addInlineReturn(
  prisma: any,
  s: Seeded,
  opts: {
    number: string;
    status: string;
    refundMethod?: string | null;
    /** the credit note this return's store credit was minted as (its own note) */
    creditNoteId?: string | null;
    /** a driver-cap / already-returned hold awaiting approval: the held credit */
    hold?: { reason: "DRIVER_CAP" | "ALREADY_RETURNED"; amount: number };
    items: Array<{
      invoice?: number;
      line: number;
      qty: number;
      subtotal: number;
      taxAmount?: number;
      categoryTax?: number;
    }>;
  },
) {
  const lineOf = (i: { invoice?: number; line: number }) =>
    s.invoices[i.invoice ?? 0].lines[i.line];
  return prisma.return.create({
    data: {
      tenantId: s.tenantId,
      orderId: s.orderId,
      customerId: s.customerId,
      reason: "DAMAGED",
      status: opts.status,
      kind: "INLINE",
      returnNumber: opts.number,
      refundMethod: opts.refundMethod ?? null,
      creditNoteId: opts.creditNoteId ?? null,
      holdReason: opts.hold?.reason ?? null,
      heldAmount: opts.hold?.amount ?? null,
      // the priced total, split as the capture stores it (the refund answers with exactly this figure)
      creditSubtotal: round2(opts.items.reduce((t, i) => t + i.subtotal, 0)),
      creditTax: round2(opts.items.reduce((t, i) => t + (i.taxAmount ?? 0), 0)),
      creditCategoryTax: round2(opts.items.reduce((t, i) => t + (i.categoryTax ?? 0), 0)),
      items: {
        create: opts.items.map((i) => ({
          tenantId: s.tenantId,
          productId: lineOf(i).productId,
          qty: i.qty,
          sourceOrderId: s.orderId,
          sourceInvoiceItemId: lineOf(i).id,
          sourceOrderItemId: lineOf(i).orderItemId,
          unitPrice: i.qty > 0 ? round2(i.subtotal / i.qty) : 0,
          subtotal: i.subtotal,
          taxAmount: i.taxAmount ?? 0,
          categoryTax: i.categoryTax ?? 0,
        })),
      },
    },
  });
}

/** Deletes exactly the tenants a run created, children first. */
export async function cleanupSeeded(prisma: any, tenantIds: string[]): Promise<void> {
  const swallow = () => undefined;
  for (const tenantId of tenantIds) {
    const where = { where: { tenantId } };
    await prisma.auditLog.deleteMany(where).catch(swallow);
    await prisma.returnItem.deleteMany(where).catch(swallow);
    await prisma.return.deleteMany(where).catch(swallow);
    await prisma.creditNoteItem.deleteMany(where).catch(swallow);
    await prisma.orderCreditNote.deleteMany(where).catch(swallow);
    await prisma.creditNote.deleteMany(where).catch(swallow);
    await prisma.invoicePayment.deleteMany(where).catch(swallow);
    await prisma.invoiceItem.deleteMany(where).catch(swallow);
    await prisma.invoice.deleteMany(where).catch(swallow);
    await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
    await prisma.orderItem.deleteMany(where).catch(swallow);
    await prisma.order.deleteMany(where).catch(swallow);
    await prisma.product.deleteMany(where).catch(swallow);
    await prisma.customer.deleteMany(where).catch(swallow);
    await prisma.user.deleteMany(where).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
  }
}

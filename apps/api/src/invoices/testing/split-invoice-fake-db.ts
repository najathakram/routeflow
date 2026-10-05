/**
 * SA-681 test harness: a tiny STATEFUL in-memory stand-in for the four tables an order's
 * invoicing touches (Order, OrderItem, Invoice, InvoiceItem), installed over `createMockPrisma()`.
 *
 * It exists so the pins run the REAL writers end to end (createPartialFromOrder,
 * createInvoiceFromOrder, reconcileOrderDraftInvoice, buildInvoiceItemData and its telescoping
 * proration) and read the money back out of the rows they wrote, instead of asserting on
 * hand-typed numbers. It implements only the where/include shapes those writers use; anything it
 * does not understand throws, so a drifted query fails loudly rather than matching nothing.
 */
import type { MockPrisma } from "../../testing/prisma-mock";
import { INVOICE_LINE_CAS_FIELDS } from "../partial-invoice-cas";

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const cur = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const ops = Object.keys(cond);
      for (const op of ops) {
        const val = (cond as Row)[op];
        if (op === "not") {
          if (val === null ? cur == null : cur === val) return false;
        } else if (op === "in") {
          if (!val.includes(cur)) return false;
        } else if (op === "notIn") {
          if (val.includes(cur)) return false;
        } else {
          throw new Error(`split-invoice-fake-db: unsupported where operator "${op}" on "${key}"`);
        }
      }
    } else if (cur !== cond) {
      return false;
    }
  }
  return true;
}

const clone = <T>(v: T): T => structuredClone(v);
/** Invoice statuses a "live" listing leaves out (kept as a set so no hand-rolled status filter). */
const ENDED = new Set(["VOID"]);

export class SplitInvoiceFakeDb {
  orders = new Map<string, Row>();
  orderItems: Row[] = [];
  invoices: Row[] = [];
  invoiceItems: Row[] = [];
  /** `trackedCategory.findMany` result (regulated pins); empty by default. */
  trackedCategories: Row[] = [];
  invoiceUpdateCalls: Row[] = [];
  private seq = 0;

  addOrder(order: Row, lines: Row[]): void {
    this.orders.set(order.id, { tenantId: "test-tenant", status: "CONFIRMED", ...order });
    for (const li of lines) this.orderItems.push({ orderId: order.id, ...li });
  }

  /** The order's invoices, oldest first, each with its items (cloned). */
  invoicesOf(orderId: string, opts: { includeVoid?: boolean } = {}): Row[] {
    return this.invoices
      .filter((i) => i.orderId === orderId && (opts.includeVoid || !ENDED.has(i.status)))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((i) => this.hydrate(i, { items: true }));
  }

  /**
   * The two row effects of a replace-all order edit (orders.service `orderItem.deleteMany` then
   * `orderItem.create` per line), for a spec that wires them to the real updateOrderItems: a
   * deleted line takes InvoiceItem.orderItemId to null (onDelete SetNull), and a re-created line
   * is a NEW id with invoicedQty back at its schema default 0.
   */
  deleteOrderLines(orderId: string): { count: number } {
    const gone = this.orderItems.filter((l) => l.orderId === orderId);
    this.orderItems = this.orderItems.filter((l) => l.orderId !== orderId);
    for (const l of gone) {
      for (const it of this.invoiceItems) if (it.orderItemId === l.id) it.orderItemId = null;
    }
    return { count: gone.length };
  }

  createOrderLine(data: Row): Row {
    const row = { ...fakeOrderLine(), ...clone(data), id: `oi-new-${++this.seq}`, invoicedQty: 0 };
    this.orderItems.push(row);
    return clone(row);
  }

  line(id: string): Row {
    return this.orderItems.find((l) => l.id === id)!;
  }

  private hydrate(inv: Row, include?: Row): Row {
    const out = clone(inv);
    out.items = clone(this.invoiceItems.filter((it) => it.invoiceId === inv.id));
    out.payments = [];
    out.customer = include?.customer ? { id: inv.customerId, businessName: "Acme" } : undefined;
    return out;
  }

  private orderWithLines(order: Row, include?: Row): Row {
    const out = clone(order);
    if (include?.lineItems) {
      const w = include.lineItems.where;
      out.lineItems = clone(this.orderItems.filter((l) => l.orderId === order.id && matches(l, w)));
    }
    return out;
  }

  private applyItemWrites(invoiceId: string, items: Row | undefined): void {
    for (const data of items?.create ?? []) {
      this.invoiceItems.push({ ...clone(data), id: `ii-${++this.seq}`, invoiceId });
    }
  }

  install(prisma: MockPrisma): void {
    const p = prisma as any;
    p.customer.findFirst.mockResolvedValue({
      isTaxExempt: false,
      defaultPaymentTerms: null,
      defaultDepositPercent: null,
    });
    p.customer.findUnique.mockResolvedValue({ isTaxExempt: false });
    p.deliveryMutation.findMany.mockResolvedValue([]);
    p.tenantConfig.findUnique.mockResolvedValue(null);
    p.trackedCategory.findMany.mockImplementation(async () => clone(this.trackedCategories));

    const findOrder = async (args: Row) => {
      const o = [...this.orders.values()].find((x) => matches(x, args.where));
      return o ? this.orderWithLines(o, args.include) : null;
    };
    p.order.findUnique.mockImplementation(findOrder);
    p.order.findFirst.mockImplementation(findOrder);

    p.orderItem.findMany.mockImplementation(async (args: Row) =>
      clone(this.orderItems.filter((l) => matches(l, args.where))),
    );
    p.orderItem.update.mockImplementation(async (args: Row) => {
      const l = this.orderItems.find((x) => matches(x, args.where));
      if (!l) throw new Error("orderItem.update: not found");
      Object.assign(l, args.data);
      return clone(l);
    });
    p.orderItem.updateMany.mockImplementation(async (args: Row) => {
      const hit = this.orderItems.filter((l) => matches(l, args.where));
      for (const l of hit) {
        for (const [k, v] of Object.entries(args.data as Row)) {
          l[k] =
            v && typeof v === "object" && "increment" in v ? Number(l[k] ?? 0) + v.increment : v;
        }
      }
      return { count: hit.length };
    });

    const sortAsc = (rows: Row[], orderBy?: Row) =>
      orderBy?.createdAt === "desc"
        ? [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        : [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    p.invoice.findMany.mockImplementation(async (args: Row) =>
      sortAsc(
        this.invoices.filter((i) => matches(i, args.where)),
        args.orderBy,
      ).map((i) => this.hydrate(i, args.include)),
    );
    p.invoice.findFirst.mockImplementation(async (args: Row) => {
      const hit = sortAsc(
        this.invoices.filter((i) => matches(i, args.where)),
        args.orderBy,
      )[0];
      return hit ? this.hydrate(hit, args.include) : null;
    });
    p.invoice.create.mockImplementation(async (args: Row) => {
      const { items, ...scalars } = args.data as Row;
      const inv: Row = {
        deliveryBatchId: null,
        depositPercent: null,
        discount: 0,
        shippingFee: 0,
        id: `inv-${++this.seq}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.seq)),
        ...scalars,
      };
      this.invoices.push(inv);
      this.applyItemWrites(inv.id, items);
      return this.hydrate(inv, args.include);
    });
    p.invoice.update.mockImplementation(async (args: Row) => {
      this.invoiceUpdateCalls.push(clone(args));
      const inv = this.invoices.find((i) => matches(i, args.where));
      if (!inv) throw new Error("invoice.update: not found");
      const { items, ...scalars } = args.data as Row;
      Object.assign(inv, scalars);
      this.applyItemWrites(inv.id, items);
      return this.hydrate(inv, args.include);
    });
    p.invoice.aggregate.mockImplementation(async (args: Row) => ({
      _sum: {
        shippingFee: this.invoices
          .filter((i) => matches(i, args.where))
          .reduce((s, i) => s + Number(i.shippingFee ?? 0), 0),
      },
    }));

    p.invoiceItem.findMany.mockImplementation(async (args: Row) =>
      clone(this.invoiceItems.filter((it) => matches(it, args.where))),
    );
    p.invoiceItem.deleteMany.mockImplementation(async (args: Row) => {
      const keep = this.invoiceItems.filter((it) => !matches(it, args.where));
      const count = this.invoiceItems.length - keep.length;
      this.invoiceItems = keep;
      return { count };
    });
  }
}

/** A fully-populated boxed (or plain) order line — every CAS basis column present. */
export function fakeOrderLine(over: Row = {}): Row {
  // The four category-tax columns come from the CAS list (all null: an unregulated line), not literals.
  const categoryTax = Object.fromEntries(
    INVOICE_LINE_CAS_FIELDS.filter(
      (f) => f.startsWith("categoryTax") || f === "categoryPriceIncludesTax",
    ).map((f) => [f, null]),
  );
  return {
    ...categoryTax,
    id: "oi-1",
    productId: "p-1",
    qty: 120,
    invoicedQty: 0,
    boxes: 10,
    pieces: 0,
    unitsPerBox: 12,
    unitPrice: 2.35,
    subtotal: 282,
    status: "PENDING",
    promoFreeUnits: null,
    unitLabel: null,
    originalPrice: null,
    priceType: "STANDARD",
    name: null,
    notes: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    components: [],
    product: {
      name: "Widget",
      unitsPerBox: 12,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
    },
    ...over,
  };
}

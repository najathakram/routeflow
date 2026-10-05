import { NotFoundException, BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoiceStatus, UserRole } from "@prisma/client";
import { BACKING_ORDER_STATUSES } from "../invoices/credit-exposure";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  CustomerPriceHistoryService,
  canSeeCost,
  clampHistoryLimit,
} from "./customer-price-history.service";

const D = (n: number | string) => n; // Prisma Decimal stand-in: Number() accepts it

const CUSTOMER = { id: "c1", businessName: "Acme Foods" };
const PRODUCT: Record<string, unknown> = {
  id: "p1",
  name: "Widget",
  unit: "pc",
  unitsPerBox: null,
  averageCost: D("3.0000"),
};

const invLine = (o: Record<string, unknown> = {}) => ({
  id: "ii1",
  qty: D(1),
  unitPrice: D("10.00"),
  priceType: "STANDARD",
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  ...o,
});
const invoice = (o: Record<string, unknown> = {}) => ({
  id: "inv1",
  invoiceNumber: "INV-1",
  issueDate: new Date("2026-06-10T12:00:00Z"),
  orderId: "o1",
  order: { orderNumber: "ORD-1" },
  items: [invLine()],
  ...o,
});
const openItem = (o: Record<string, unknown> = {}) => ({
  id: "oi1",
  qty: D(2),
  invoicedQty: D(0),
  unitPrice: D("11.00"),
  priceType: "MANUAL",
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  ...o,
});
const openOrder = (o: Record<string, unknown> = {}) => ({
  id: "o9",
  orderNumber: "ORD-9",
  orderDate: null,
  createdAt: new Date("2026-07-01T09:00:00Z"),
  lineItems: [openItem()],
  ...o,
});
const mv = (iso: string, avg: string) => ({
  productId: "p1",
  effectiveAt: new Date(iso),
  avgCostAfter: D(avg),
});

// A tiny invoice store that honours the status filter, so billed-qty behaviour is exercised
// (not just the query shape). `rows` answers the row read; `billed` answers the billed-qty read
// (the one filtered on items.some.orderItemId), after applying `status.notIn`.
const mockInvoiceStore = (
  prisma: { invoice: { findMany: jest.Mock } },
  o: {
    rows?: unknown[];
    billed?: { status: InvoiceStatus; items: { orderItemId: string; qty: unknown }[] }[];
  },
) => {
  prisma.invoice.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.items?.some?.orderItemId) {
      const excluded: InvoiceStatus[] = args.where.status?.notIn ?? [];
      return (o.billed ?? [])
        .filter((i) => !excluded.includes(i.status))
        .map((i) => ({ items: i.items }));
    }
    return o.rows ?? [];
  });
};

describe("CustomerPriceHistoryService", () => {
  let service: CustomerPriceHistoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue(CUSTOMER);
    prisma.product.findFirst.mockResolvedValue(PRODUCT);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    prisma.stockMovement.findMany.mockResolvedValue([]);
    prisma.stockMovement.findFirst.mockResolvedValue(null);
    const mod = await Test.createTestingModule({
      providers: [CustomerPriceHistoryService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CustomerPriceHistoryService);
  });

  const run = (o: { limit?: unknown; role?: UserRole } = {}) =>
    service.getHistory("c1", "p1", { limit: o.limit as any, role: o.role ?? UserRole.OPERATOR });

  describe("tenant isolation", () => {
    it("scopes customer, product, invoice and order reads to the request tenant", async () => {
      await run();
      expect(prisma.customer.findFirst.mock.calls[0][0].where).toEqual({
        id: "c1",
        tenantId: "test-tenant",
      });
      expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
        id: "p1",
        tenantId: "test-tenant",
      });
      const iw = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(iw).toMatchObject({
        tenantId: "test-tenant",
        customerId: "c1",
        items: { some: { productId: "p1" } },
      });
      const ow = prisma.order.findMany.mock.calls[0][0].where;
      expect(ow).toMatchObject({ tenantId: "test-tenant", customerId: "c1" });
    });

    it("404s another tenant's (unfound) customer and never reads sales", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(run()).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it("404s another tenant's (unfound) product", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(run()).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    });

    it("refuses a tenant-less context", async () => {
      prisma.getTenantId.mockReturnValue(null);
      await expect(run()).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("status filters", () => {
    it("reads issued invoices (no DRAFT / VOID; a WRITTEN_OFF invoice was billed) and backing orders", async () => {
      await run();
      const iw = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(iw.status).toEqual({
        notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID],
      });
      const ow = prisma.order.findMany.mock.calls[0][0].where;
      expect(ow.status).toEqual({
        in: [...BACKING_ORDER_STATUSES],
      });
      // cancelled order LINES are excluded too
      expect(prisma.order.findMany.mock.calls[0][0].select.lineItems.where).toMatchObject({
        productId: "p1",
        status: { not: "CANCELLED" },
      });
    });
  });

  describe("rows", () => {
    it("maps an invoice line to an INVOICE row (unitPrice, not subtotal) with order + invoice ids", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        invoice({ items: [invLine({ unitPrice: D("10.01"), qty: D(3), priceType: "SPECIAL" })] }),
      ]);
      const res = await run();
      expect(res).toMatchObject({
        customerId: "c1",
        customerName: "Acme Foods",
        productId: "p1",
        productName: "Widget",
        costVisible: true,
      });
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({
        source: "INVOICE",
        date: "2026-06-10T12:00:00.000Z",
        unitPrice: 10.01,
        unitLabel: "pc",
        unitsPerBox: null,
        qty: 3,
        invoiceId: "inv1",
        invoiceNumber: "INV-1",
        orderId: "o1",
        orderNumber: "ORD-1",
        priceType: "SPECIAL",
      });
    });

    it("labels an open order line OPEN_ORDER with no invoice and the order date", async () => {
      prisma.order.findMany.mockResolvedValue([
        openOrder({ orderDate: new Date("2026-06-30T00:00:00Z") }),
      ]);
      const res = await run();
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({
        source: "OPEN_ORDER",
        date: "2026-06-30T00:00:00.000Z",
        invoiceId: null,
        invoiceNumber: null,
        orderId: "o9",
        orderNumber: "ORD-9",
        unitPrice: 11,
        qty: 2,
        priceType: "MANUAL",
      });
    });

    it("an open order line that is fully invoiced is skipped (appears once, as INVOICE)", async () => {
      mockInvoiceStore(prisma, {
        rows: [invoice({ orderId: "o9", order: { orderNumber: "ORD-9" } })],
        billed: [{ status: InvoiceStatus.SENT, items: [{ orderItemId: "oi1", qty: D(2) }] }],
      });
      prisma.order.findMany.mockResolvedValue([
        openOrder({ lineItems: [openItem({ qty: D(2) })] }),
      ]);
      const res = await run();
      expect(res.rows.map((r) => r.source)).toEqual(["INVOICE"]);
    });

    it("a partially invoiced open line shows only its not-yet-invoiced remainder", async () => {
      prisma.order.findMany.mockResolvedValue([
        openOrder({ lineItems: [openItem({ qty: D(5) })] }),
      ]);
      mockInvoiceStore(prisma, {
        billed: [{ status: InvoiceStatus.SENT, items: [{ orderItemId: "oi1", qty: D(2) }] }],
      });
      const res = await run();
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({
        source: "OPEN_ORDER",
        qty: 3,
        boxes: null,
        pieces: null,
      });
    });

    it("a line billed only on a DRAFT or VOID invoice still shows as OPEN_ORDER", async () => {
      prisma.order.findMany.mockResolvedValue([
        openOrder({ lineItems: [openItem({ qty: D(2), invoicedQty: D(2) })] }),
      ]);
      mockInvoiceStore(prisma, {
        billed: [
          { status: InvoiceStatus.DRAFT, items: [{ orderItemId: "oi1", qty: D(2) }] },
          { status: InvoiceStatus.VOID, items: [{ orderItemId: "oi1", qty: D(2) }] },
        ],
      });
      const res = await run();
      expect(res.rows.map((r) => [r.source, r.qty])).toEqual([["OPEN_ORDER", 2]]);
    });

    it("a line billed on a WRITTEN_OFF invoice counts as billed (shown once, as INVOICE)", async () => {
      prisma.order.findMany.mockResolvedValue([
        openOrder({ status: "DELIVERED", lineItems: [openItem({ qty: D(2) })] }),
      ]);
      mockInvoiceStore(prisma, {
        rows: [invoice({ orderId: "o9", order: { orderNumber: "ORD-9" } })],
        billed: [{ status: InvoiceStatus.WRITTEN_OFF, items: [{ orderItemId: "oi1", qty: D(2) }] }],
      });
      const res = await run();
      expect(res.rows.map((r) => r.source)).toEqual(["INVOICE"]);
    });

    it("reads billed qty THROUGH Invoice (a NULL-tenant InvoiceItem must not be dropped)", async () => {
      prisma.order.findMany.mockResolvedValue([openOrder()]);
      await run();
      expect(prisma.invoiceItem.findMany).not.toHaveBeenCalled();
      const billedCall = prisma.invoice.findMany.mock.calls[1][0];
      expect(billedCall.where).toMatchObject({
        tenantId: "test-tenant",
        status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID] },
        items: { some: { orderItemId: { in: ["oi1"] } } },
      });
    });

    it("a DELIVERED order with no issued invoice shows as not invoiced yet", async () => {
      prisma.order.findMany.mockResolvedValue([openOrder({ status: "DELIVERED" })]);
      const res = await run();
      expect(res.rows.map((r) => r.source)).toEqual(["OPEN_ORDER"]);
    });

    it("merges newest first across invoices and open orders", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        invoice({ id: "a", invoiceNumber: "A", issueDate: new Date("2026-06-01T00:00:00Z") }),
        invoice({ id: "b", invoiceNumber: "B", issueDate: new Date("2026-06-20T00:00:00Z") }),
      ]);
      prisma.order.findMany.mockResolvedValue([openOrder()]); // 2026-07-01
      const res = await run();
      expect(res.rows.map((r) => r.invoiceNumber ?? "open")).toEqual(["open", "B", "A"]);
    });

    it("an invoice with no order carries empty order refs (contract fields are strings)", async () => {
      prisma.invoice.findMany.mockResolvedValue([invoice({ orderId: null, order: null })]);
      const res = await run();
      expect(res.rows[0]).toMatchObject({ orderId: "", orderNumber: "" });
    });
  });

  describe("hunt2 F6: the order being edited is not its own history (excludeOrderId)", () => {
    // stores that honour the two exclusion filters, so the RESULT is pinned, not just the query
    const arrange = () => {
      const editing = openOrder({
        id: "o-edit",
        orderNumber: "ORD-EDIT",
        createdAt: new Date("2026-08-01T09:00:00Z"), // newest: today it shows as "Last"
        lineItems: [openItem({ id: "oi-edit", unitPrice: D("99.00") })],
      });
      const older = openOrder();
      prisma.order.findMany.mockImplementation(async (args: any) =>
        [editing, older].filter((o) => o.id !== args.where.id?.not),
      );
      const own = invoice({ id: "inv-own", orderId: "o-edit", items: [invLine({ id: "ii-own" })] });
      const loose = invoice({ id: "inv-loose", orderId: null, order: null });
      const other = invoice();
      prisma.invoice.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.items?.some?.orderItemId) return [];
        const ex = args.where.OR?.[1]?.orderId?.not;
        return [own, loose, other].filter((i) => !ex || i.orderId !== ex);
      });
    };

    it("drops the edited order's open line and its invoices; an invoice with no order stays", async () => {
      arrange();
      const out = await service.getHistory("c1", "p1", {
        role: UserRole.OPERATOR,
        excludeOrderId: "o-edit",
      });
      const ids = out.rows.map((r) => r.orderId);
      expect(ids).not.toContain("o-edit");
      expect(out.rows.map((r) => r.invoiceId)).toEqual(
        expect.arrayContaining(["inv-loose", "inv1"]),
      );
      expect(out.rows[0].unitPrice).not.toBe(99); // "Last" is never the price being edited
    });

    it("without it (order entry, a new order) every row stays, as today", async () => {
      arrange();
      const out = await run();
      expect(out.rows[0]).toMatchObject({ orderId: "o-edit", unitPrice: 99 });
    });
  });

  describe("avg cost at the sale date", () => {
    it("uses the latest movement at or before each sale, null before the first", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([
        mv("2026-03-01T00:00:00Z", "1.0000"),
        mv("2026-06-05T00:00:00Z", "2.0000"),
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        invoice({ id: "late", issueDate: new Date("2026-06-10T00:00:00Z") }),
        invoice({ id: "mid", issueDate: new Date("2026-04-01T00:00:00Z") }),
        invoice({ id: "early", issueDate: new Date("2026-01-01T00:00:00Z") }),
      ]);
      const res = await run();
      const byId = Object.fromEntries(res.rows.map((r) => [r.invoiceId, r.avgCostAtSale]));
      expect(byId).toEqual({ late: 2, mid: 1, early: null }); // before any movement: unknown
    });

    it("uses the opening snapshot (latest movement before the oldest row) and bounds the movement read", async () => {
      prisma.stockMovement.findFirst.mockResolvedValue(mv("2025-01-01T00:00:00Z", "4.0000"));
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      const res = await run();
      expect(res.rows[0].avgCostAtSale).toBe(4);
      const w = prisma.stockMovement.findMany.mock.calls[0][0].where;
      expect(w.effectiveAt).toEqual({
        gte: new Date("2026-06-10T12:00:00Z"),
        lte: new Date("2026-06-10T12:00:00Z"),
      });
      expect(prisma.stockMovement.findFirst.mock.calls[0][0].where.effectiveAt).toEqual({
        lt: new Date("2026-06-10T12:00:00Z"),
      });
    });

    it("STANDARD costing falls back to standardCost before any movement; otherwise null (never current averageCost)", async () => {
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      expect((await run()).rows[0].avgCostAtSale).toBeNull();
      prisma.product.findFirst.mockResolvedValue({
        ...PRODUCT,
        costingMethod: "STANDARD",
        standardCost: D("2.5000"),
      });
      expect((await run()).rows[0].avgCostAtSale).toBe(2.5);
    });

    it("a zero or negative snapshot is unknown (null)", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([mv("2026-01-01T00:00:00Z", "0.0000")]);
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      expect((await run()).rows[0].avgCostAtSale).toBeNull();
    });

    it("boxed split line: cost per case = piece cost x unitsPerBox, in the row's unit", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([mv("2026-01-01T00:00:00Z", "1.2500")]);
      prisma.invoice.findMany.mockResolvedValue([
        invoice({
          items: [
            invLine({
              unitLabel: "Case",
              unitsPerBox: 12,
              boxes: 2,
              pieces: 6,
              qty: D(30),
              unitPrice: D("20.00"),
            }),
          ],
        }),
      ]);
      const res = await run();
      expect(res.rows[0]).toMatchObject({
        unitLabel: "Case",
        unitsPerBox: 12,
        avgCostAtSale: 15, // 1.25 x 12
        qty: 2.5, // 30 pieces / 12 per case
        boxes: 2,
        pieces: 6,
      });
    });

    it("a factor-1 unit line on a boxed product costs one piece", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([mv("2026-01-01T00:00:00Z", "1.2500")]);
      prisma.invoice.findMany.mockResolvedValue([
        invoice({ items: [invLine({ unitLabel: "Each", unitsPerBox: 1, qty: D(4) })] }),
      ]);
      const res = await run();
      expect(res.rows[0]).toMatchObject({ unitLabel: "Each", avgCostAtSale: 1.25, qty: 4 });
    });

    it("an ambiguous legacy boxed line (no split, pack > 1) gets no cost rather than a guess", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([mv("2026-01-01T00:00:00Z", "1.2500")]);
      prisma.invoice.findMany.mockResolvedValue([
        invoice({ items: [invLine({ unitsPerBox: 12, qty: D(2) })] }),
      ]);
      const res = await run();
      expect(res.rows[0].avgCostAtSale).toBeNull();
    });
  });

  describe("cost visibility", () => {
    it("a role that cannot see cost gets costVisible:false, null costs, and no cost query", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([mv("2026-01-01T00:00:00Z", "1.0000")]);
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      prisma.order.findMany.mockResolvedValue([openOrder()]);
      const res = await run({ role: UserRole.DRIVER });
      expect(res.costVisible).toBe(false);
      expect(res.rows.length).toBe(2);
      expect(res.rows.every((r) => r.avgCostAtSale === null)).toBe(true);
      expect(res.summaries.every((s) => s.currentAvgCost === null)).toBe(true);
      expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
      expect(JSON.stringify(res)).not.toMatch(/"avgCostAtSale":[0-9]/);
    });

    it("canSeeCost: staff yes; driver, customer and unknown no", () => {
      expect(canSeeCost(UserRole.OPERATOR)).toBe(true);
      expect(canSeeCost(UserRole.TENANT_ADMIN)).toBe(true);
      expect(canSeeCost(UserRole.SUPER_ADMIN)).toBe(true);
      expect(canSeeCost(UserRole.DRIVER)).toBe(false);
      expect(canSeeCost(UserRole.CUSTOMER)).toBe(false);
      expect(canSeeCost(undefined)).toBe(false);
    });
  });

  describe("summaries", () => {
    it("one summary per unitLabel, never mixing units", async () => {
      prisma.stockMovement.findMany.mockResolvedValue([mv("2026-01-01T00:00:00Z", "1.0000")]);
      const caseLine = (price: string, boxes: number) =>
        invLine({
          unitLabel: "Case",
          unitsPerBox: 12,
          boxes,
          pieces: 0,
          qty: D(boxes * 12),
          unitPrice: D(price),
        });
      prisma.invoice.findMany.mockResolvedValue([
        invoice({
          id: "i3",
          issueDate: new Date("2026-06-30T00:00:00Z"),
          items: [caseLine("14.00", 1)],
        }),
        invoice({
          id: "i2",
          issueDate: new Date("2026-06-20T00:00:00Z"),
          items: [caseLine("12.00", 3)],
        }),
        invoice({
          id: "i1",
          issueDate: new Date("2026-06-10T00:00:00Z"),
          items: [invLine({ unitLabel: "Each", unitsPerBox: 1, qty: D(5), unitPrice: D("1.50") })],
        }),
      ]);
      prisma.order.findMany.mockResolvedValue([
        openOrder({
          createdAt: new Date("2026-07-02T00:00:00Z"),
          lineItems: [
            openItem({
              unitLabel: "Case",
              unitsPerBox: 12,
              boxes: 1,
              pieces: 0,
              qty: D(12),
              unitPrice: D("16.00"),
            }),
          ],
        }),
      ]);
      const res = await run();
      expect(res.summaries).toHaveLength(2);
      const caseS = res.summaries.find((s) => s.unitLabel === "Case");
      const eachS = res.summaries.find((s) => s.unitLabel === "Each");
      // last/low/high include the open order's $16 (newest); qtySold = invoice rows only (1 + 3)
      expect(caseS).toEqual({
        unitLabel: "Case",
        last: 16,
        low: 12,
        high: 16,
        qtySold: 4,
        currentAvgCost: 36, // product.averageCost 3 x 12
      });
      expect(eachS).toEqual({
        unitLabel: "Each",
        last: 1.5,
        low: 1.5,
        high: 1.5,
        qtySold: 5,
        currentAvgCost: 3,
      });
    });

    it("currentAvgCost uses the first row in the unit group with a known pack", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        invoice({
          id: "new",
          issueDate: new Date("2026-06-20T00:00:00Z"),
          items: [invLine({ unitLabel: "Case", unitsPerBox: 12, qty: D(2) })], // ambiguous: pack unknown
        }),
        invoice({
          id: "old",
          issueDate: new Date("2026-06-10T00:00:00Z"),
          items: [invLine({ unitLabel: "Case", unitsPerBox: 12, boxes: 1, pieces: 0, qty: D(12) })],
        }),
      ]);
      const res = await run();
      expect(res.summaries).toHaveLength(1);
      expect(res.summaries[0].currentAvgCost).toBe(36);
    });

    it("no history -> empty rows and summaries", async () => {
      const res = await run();
      expect(res.rows).toEqual([]);
      expect(res.summaries).toEqual([]);
    });
  });

  describe("limit", () => {
    it("clampHistoryLimit: default 25, max 100, min 1, junk -> default", () => {
      expect(clampHistoryLimit(undefined)).toBe(25);
      expect(clampHistoryLimit("abc")).toBe(25);
      expect(clampHistoryLimit("500")).toBe(100);
      expect(clampHistoryLimit(0)).toBe(1);
      expect(clampHistoryLimit("-3")).toBe(1);
      expect(clampHistoryLimit("40")).toBe(40);
    });

    it("caps the returned rows and the invoice read at the limit", async () => {
      const many = Array.from({ length: 30 }, (_, i) =>
        invoice({
          id: `i${i}`,
          invoiceNumber: `N${i}`,
          issueDate: new Date(Date.UTC(2026, 0, 1 + i)),
        }),
      );
      prisma.invoice.findMany.mockResolvedValue(many);
      const res = await run({ limit: "5" });
      expect(res.rows).toHaveLength(5);
      expect(res.rows[0].invoiceNumber).toBe("N29"); // newest of the mock
      expect(prisma.invoice.findMany.mock.calls[0][0].take).toBe(5);
    });

    it("a request above 100 reads at most 100", async () => {
      await run({ limit: "1000" });
      expect(prisma.invoice.findMany.mock.calls[0][0].take).toBe(100);
    });
  });
});

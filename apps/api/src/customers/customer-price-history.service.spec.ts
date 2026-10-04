import { NotFoundException, BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoiceStatus, OrderStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  CustomerPriceHistoryService,
  canSeeCost,
  clampHistoryLimit,
} from "./customer-price-history.service";

const D = (n: number | string) => n; // Prisma Decimal stand-in: Number() accepts it

const CUSTOMER = { id: "c1", businessName: "Acme Foods" };
const PRODUCT = {
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
  items: [openItem()],
  ...o,
});
const mv = (iso: string, avg: string) => ({
  productId: "p1",
  effectiveAt: new Date(iso),
  avgCostAfter: D(avg),
});

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
    it("reads only real invoices (no DRAFT / VOID / WRITTEN_OFF) and only open orders", async () => {
      await run();
      const iw = prisma.invoice.findMany.mock.calls[0][0].where;
      expect(iw.status).toEqual({
        notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
      });
      const ow = prisma.order.findMany.mock.calls[0][0].where;
      expect(ow.status).toEqual({
        in: [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.OUT_FOR_DELIVERY],
      });
      // cancelled order LINES are excluded too
      expect(prisma.order.findMany.mock.calls[0][0].select.items.where).toMatchObject({
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
      prisma.invoice.findMany.mockResolvedValue([
        invoice({ orderId: "o9", order: { orderNumber: "ORD-9" } }),
      ]);
      prisma.order.findMany.mockResolvedValue([
        openOrder({ items: [openItem({ qty: D(2), invoicedQty: D(2) })] }),
      ]);
      const res = await run();
      expect(res.rows.map((r) => r.source)).toEqual(["INVOICE"]);
    });

    it("a partially invoiced open line shows only its not-yet-invoiced remainder", async () => {
      prisma.order.findMany.mockResolvedValue([
        openOrder({ items: [openItem({ qty: D(5), invoicedQty: D(2) })] }),
      ]);
      const res = await run();
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({
        source: "OPEN_ORDER",
        qty: 3,
        boxes: null,
        pieces: null,
      });
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

  describe("avg cost at the sale date", () => {
    it("uses the latest movement at or before each sale, falling back to current averageCost before the first", async () => {
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
      expect(byId).toEqual({ late: 2, mid: 1, early: 3 }); // early: no movement yet -> averageCost 3
    });

    it("is null when there is neither a movement nor a current average cost", async () => {
      prisma.product.findFirst.mockResolvedValue({ ...PRODUCT, averageCost: null });
      prisma.invoice.findMany.mockResolvedValue([invoice()]);
      const res = await run();
      expect(res.rows[0].avgCostAtSale).toBeNull();
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
          items: [
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

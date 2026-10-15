/**
 * SA-740 §1 (row 190): source-sale pinning for counter returns.
 *
 * A walk-in has ONE shared customer row, so the customer-scoped matching set let a return from
 * receipt B be allocated to the NEWEST sale A (priced at A's line, and judged on A's tender). The
 * server now pins the matching set to a source sale: the walk-in is decided server-side from
 * `customer.isWalkIn`, the quote REQUIRES the source, the capture defaults it to the carrying
 * order, and a walk-in never gets an unreferenced (no-source-line) chunk. A named customer keeps
 * the cross-order spill unless a source is sent.
 *
 * The pricing arithmetic itself is covered by inline-returns-pricing.spec.ts; these tests drive the
 * REAL quote service over a fake store that honours the `where` of the reads that matter.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { SOURCE_SALE_ERROR_CODES } from "./inline-returns-source-sale";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const OPERATOR = {
  sub: "user-op-1",
  role: "OPERATOR",
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

const WALK_IN = { id: "walk", pricingTier: 1, isTaxExempt: false, isWalkIn: true };
const NAMED = { id: "named", pricingTier: 1, isTaxExempt: false, isWalkIn: false };

/** Sale A: the NEWEST (paid in cash, $10/unit). Sale B: older, paid with store credit ($8/unit). */
const ORDERS: Record<string, any> = {
  ordA: { id: "ordA", customerId: "walk", status: "DELIVERED", counterSale: true },
  ordB: { id: "ordB", customerId: "walk", status: "DELIVERED", counterSale: true },
  ordOther: { id: "ordOther", customerId: "someone-else", status: "DELIVERED", counterSale: true },
  ordPending: { id: "ordPending", customerId: "walk", status: "PENDING", counterSale: false },
  ordCancelled: { id: "ordCancelled", customerId: "walk", status: "CANCELLED", counterSale: true },
  ordDeliveredOffice: {
    id: "ordDeliveredOffice",
    customerId: "walk",
    status: "DELIVERED",
    counterSale: false,
  },
  namedA: { id: "namedA", customerId: "named", status: "DELIVERED", counterSale: false },
  namedB: { id: "namedB", customerId: "named", status: "DELIVERED", counterSale: false },
};

const invoiceFor = (orderId: string, invId: string, itemId: string, unit: number) => ({
  id: invId,
  orderId,
  subtotal: unit * 2,
  discount: 0,
  taxAmount: 0,
  items: [
    {
      id: itemId,
      orderItemId: `oi-${itemId}`,
      productId: "prod-1",
      qty: 2,
      unitPrice: unit,
      subtotal: unit * 2,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      promoFreeUnits: null,
      taxRate: 0,
      categoryTaxAmount: 0,
    },
  ],
});

describe("SA-740 §1: counter return source-sale pinning", () => {
  let service: InlineReturnsQuoteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: any;
  let invoiceWheres: any[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    db = prisma.forTenant();
    invoiceWheres = [];
    const moduleRef = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    service = moduleRef.get(InlineReturnsQuoteService);

    const customers: Record<string, any> = { walk: WALK_IN, named: NAMED };
    db.customer.findFirst.mockImplementation(async ({ where }: any) => customers[where.id] ?? null);
    db.customerPrice.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        pricePerUnit: 12,
        priceTier2: 12,
        priceTier3: 12,
        priceTier4: 12,
        priceTier5: 12,
        unitsPerBox: null,
      },
    ]);
    db.return.findMany.mockResolvedValue([]);
    db.returnItem.findMany.mockResolvedValue([]);
    // the source-sale lookup: honours id + customerId (a foreign id/customer reads as null)
    db.order.findFirst.mockImplementation(async ({ where }: any) => {
      const o = ORDERS[where.id];
      if (!o) return null;
      if (where.customerId !== undefined && o.customerId !== where.customerId) return null;
      return o;
    });
    // The matching set (honours where.orderId) vs the payments read of loadSourceInvoicesState
    db.invoice.findMany.mockImplementation(async ({ where }: any) => {
      if (where.id?.in) {
        // loadSourceInvoicesState: inv-A paid in cash, inv-B paid with store credit
        return where.id.in.map((id: string) => ({
          id,
          status: "PAID",
          total: id === "inv-A" ? 20 : 16,
          payments: [
            {
              amount: id === "inv-A" ? 20 : 16,
              status: "PAID",
              method: id === "inv-A" ? "CASH" : "CREDIT_NOTE",
            },
          ],
        }));
      }
      invoiceWheres.push(where);
      const all =
        where.customerId === "named"
          ? [
              invoiceFor("namedA", "inv-nA", "item-nA", 10),
              invoiceFor("namedB", "inv-nB", "item-nB", 8),
            ]
          : [invoiceFor("ordA", "inv-A", "item-A", 10), invoiceFor("ordB", "inv-B", "item-B", 8)];
      return typeof where.orderId === "string"
        ? all.filter((i) => i.orderId === where.orderId)
        : all;
    });
    db.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
      where.id.in.map((id: string) => ({
        id,
        invoiceId: id === "item-A" ? "inv-A" : id === "item-B" ? "inv-B" : `inv-${id}`,
      })),
    );
  });

  const walkReq = (over: Record<string, unknown> = {}) => ({
    customerId: "walk",
    items: [{ productId: "prod-1", boxes: 0, pieces: 1 }],
    ...over,
  });
  const codeOf = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: any) => e?.getResponse?.()?.code ?? null,
    );

  it("1. a walk-in return from the OLDER receipt B is priced at B's line and judged on B's tender, never allocated to the newest sale A", async () => {
    const q = await service.quote(walkReq({ sourceOrderId: "ordB" }) as any, OPERATOR);
    expect(q.chunks).toHaveLength(1);
    expect(q.chunks[0]).toMatchObject({ sourceOrderId: "ordB", sourceInvoiceItemId: "item-B" });
    expect(q.total).toBe(8); // B's $8 line, not A's $10
    // F4: B was paid with store credit, so a cash refund is not offered
    expect(q.paidWithStoreCredit).toBe(true);
    expect(q.canRefund).toBe(false);
    // the matching set was pinned in the query itself
    expect(invoiceWheres[0]).toMatchObject({ customerId: "walk", orderId: "ordB" });
  });

  it("1b. the same return from sale A (cash) is refundable", async () => {
    const q = await service.quote(walkReq({ sourceOrderId: "ordA" }) as any, OPERATOR);
    expect(q.chunks[0]).toMatchObject({ sourceOrderId: "ordA" });
    expect(q.total).toBe(10);
    expect(q.canRefund).toBe(true);
  });

  it("2. a walk-in quote with no sourceOrderId is a 400 SOURCE_SALE_REQUIRED", async () => {
    const p = service.quote(walkReq() as any, OPERATOR);
    await expect(p).rejects.toThrow(BadRequestException);
    expect(await codeOf(service.quote(walkReq() as any, OPERATOR))).toBe("SOURCE_SALE_REQUIRED");
  });

  it("3. a walk-in CAPTURE pricing with no sourceOrderId defaults to the carrying order", async () => {
    const priced = await service.priceInlineReturn(walkReq() as any, OPERATOR, db, {
      defaultSourceOrderId: "ordB",
    });
    expect(priced.chunks[0]).toMatchObject({ sourceOrderId: "ordB" });
    expect(priced.total).toBe(8);
    // ...and the walk-in decision is the server's: a client-sent flag changes nothing
    expect(invoiceWheres[0]).toMatchObject({ orderId: "ordB" });
  });

  it("4. a walk-in return of more than the sale had is a 409 RETURN_EXCEEDS_SALE, never an unreferenced chunk", async () => {
    const req = walkReq({
      sourceOrderId: "ordA",
      items: [{ productId: "prod-1", boxes: 0, pieces: 3 }], // the sale had 2
    });
    await expect(service.quote(req as any, OPERATOR)).rejects.toThrow(ConflictException);
    expect(await codeOf(service.quote(req as any, OPERATOR))).toBe("RETURN_EXCEEDS_SALE");
  });

  it("4b. a walk-in return of exactly what the sale had is priced (the boundary)", async () => {
    const q = await service.quote(
      walkReq({
        sourceOrderId: "ordA",
        items: [{ productId: "prod-1", boxes: 0, pieces: 2 }],
      }) as any,
      OPERATOR,
    );
    expect(q.total).toBe(20);
    expect(q.chunks.every((c) => c.sourceOrderId === "ordA")).toBe(true);
  });

  it("4c. goods ALREADY returned from the sale count against it (the pin does not reset the supply)", async () => {
    db.returnItem.findMany.mockResolvedValue([{ productId: "prod-1", qty: 2 }]);
    const req = walkReq({ sourceOrderId: "ordA" });
    expect(await codeOf(service.quote(req as any, OPERATOR))).toBe("RETURN_EXCEEDS_SALE");
  });

  describe("5. the source sale must be this walk-in's own counter sale or delivered order", () => {
    it.each([
      ["another customer's order", "ordOther"],
      ["an id that does not exist in this tenant", "ord-foreign-tenant"],
      ["an order that is still PENDING (not a counter sale, not delivered)", "ordPending"],
      ["a CANCELLED order", "ordCancelled"],
    ])("%s is a 400 SOURCE_SALE_INVALID", async (_label, sourceOrderId) => {
      const req = walkReq({ sourceOrderId });
      await expect(service.quote(req as any, OPERATOR)).rejects.toThrow(BadRequestException);
      expect(await codeOf(service.quote(req as any, OPERATOR))).toBe("SOURCE_SALE_INVALID");
    });

    it("a DELIVERED non-counter order of the walk-in is an acceptable source", async () => {
      // no invoice on it in the fixture, so the return is over the sale: the source itself passed
      expect(
        await codeOf(
          service.quote(walkReq({ sourceOrderId: "ordDeliveredOffice" }) as any, OPERATOR),
        ),
      ).toBe("RETURN_EXCEEDS_SALE");
    });

    it("the lookup is tenant-scoped through the client and keyed on the customer", async () => {
      await service.quote(walkReq({ sourceOrderId: "ordA" }) as any, OPERATOR);
      expect(db.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "ordA", customerId: "walk" }),
        }),
      );
    });

    it("a named customer's pinned source of ANOTHER customer is a 400 too", async () => {
      const req = {
        customerId: "named",
        sourceOrderId: "ordA",
        items: [{ productId: "prod-1", boxes: 0, pieces: 1 }],
      };
      expect(await codeOf(service.quote(req as any, OPERATOR))).toBe("SOURCE_SALE_INVALID");
    });
  });

  describe("6/7. a named customer", () => {
    const namedReq = (over: Record<string, unknown> = {}) => ({
      customerId: "named",
      items: [{ productId: "prod-1", boxes: 0, pieces: 3 }],
      ...over,
    });

    it("6. without sourceOrderId keeps the cross-order spill (characterization, unchanged)", async () => {
      const q = await service.quote(namedReq() as any, OPERATOR);
      expect(q.chunks.map((c) => [c.sourceOrderId, c.pieces])).toEqual([
        ["namedA", 2],
        ["namedB", 1],
      ]);
      expect(invoiceWheres[0].orderId).toEqual({ not: null });
    });

    it("7. with sourceOrderId is pinned: B only, the overage is the unreferenced chunk", async () => {
      const q = await service.quote(namedReq({ sourceOrderId: "namedB" }) as any, OPERATOR);
      expect(q.chunks.map((c) => [c.sourceOrderId ?? null, c.pieces])).toEqual([
        ["namedB", 2],
        [null, 1],
      ]);
      expect(invoiceWheres[0]).toMatchObject({ orderId: "namedB" });
    });
  });
});

describe("SA-740: the refusal codes the mobile capture classifier settles on", () => {
  it("the mobile SOURCE_SALE_REFUSAL_CODES are exactly the three codes this service throws", () => {
    const mobile = readFileSync(
      join(__dirname, "..", "..", "..", "mobile", "lib", "inline-return-submit-key.ts"),
      "utf8",
    );
    const decl = /SOURCE_SALE_REFUSAL_CODES[^=]*=\s*\[([\s\S]*?)\]/.exec(mobile);
    expect(decl).not.toBeNull();
    const mobileKeys = [...decl![1]!.matchAll(/API_ERROR_CODES\.([A-Z_]+)/g)]
      .map((m) => m[1]!)
      .sort();
    expect(mobileKeys).toEqual([
      "RETURN_EXCEEDS_SALE",
      "SOURCE_SALE_INVALID",
      "SOURCE_SALE_REQUIRED",
    ]);
    expect(Object.values(SOURCE_SALE_ERROR_CODES).sort()).toEqual(mobileKeys);
  });
});

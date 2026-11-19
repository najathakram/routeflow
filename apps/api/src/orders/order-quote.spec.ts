/**
 * B304 / SA-1172: the buyer cart quote IS create()'s own number, taken through B1209's `beforeWrite` and refused from
 * writing anything. Real OrdersService, mocked Prisma (tests 1, 2, 4, 5, 6, 7, 13, 20 of the ruling).
 */
import { InternalServerErrorException, Logger } from "@nestjs/common";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { PromotionsService } from "../promotions/promotions.service";
import { buildOrdersService, customerPayload } from "./testing/orders-service-harness";
import { quoteForBuyer } from "./order-quote";
import { reserveInlineReturnNumber as reserveReturnNo } from "./order-inline-return";
import { nextOrderNumberFor } from "./order-number";
import { resolveOversellAllowed } from "./oversell-policy";

// Real implementations, wrapped so a test can assert a quote never reaches them.
jest.mock("./order-inline-return", () => {
  const a = jest.requireActual("./order-inline-return");
  return { ...a, reserveInlineReturnNumber: jest.fn(a.reserveInlineReturnNumber) };
});
jest.mock("./order-number", () => {
  const a = jest.requireActual("./order-number");
  return { ...a, nextOrderNumberFor: jest.fn(a.nextOrderNumberFor) };
});
jest.mock("./oversell-policy", () => {
  const a = jest.requireActual("./oversell-policy");
  return { ...a, resolveOversellAllowed: jest.fn(a.resolveOversellAllowed) };
});

// qty 2 x $15.60, 8.25% sales tax, $18 per case excise: subtotal 31.20, tax 2.57, levy 36.00, total 69.77 (the reported bug's own figures).
const PRODUCT = {
  id: "p-12pack",
  name: "Acme 12-pack",
  pricePerUnit: 15.6,
  unit: "case",
  unitsPerBox: 0,
  trackedCategoryId: "cat-levy",
  trackedSubcategoryId: null,
};
const LEVY = {
  id: "cat-levy",
  name: "Acme levy",
  taxType: "EXCISE_PER_UNIT",
  rate: 18,
  unitBasis: "pack",
  priceIncludesTax: false,
};
const ITEMS = [{ productId: "p-12pack", qty: 2 }];

async function setup(over: { exempt?: boolean; product?: object } = {}) {
  const h = await buildOrdersService();
  const p = h.prisma;
  p.customer.findFirst.mockResolvedValue({ id: "cust-1", isTaxExempt: over.exempt === true });
  p.customer.findUnique.mockResolvedValue({
    id: "cust-1",
    pricingTier: 1,
    user: { status: "ACTIVE" },
  });
  p.customerPrice.findMany.mockResolvedValue([]);
  p.product.findMany.mockResolvedValue([{ ...PRODUCT, ...over.product }]);
  p.trackedCategory.findMany.mockResolvedValue([LEVY]);
  p.order.create.mockResolvedValue({
    id: "ord-1",
    customerId: "cust-1",
    status: "PENDING",
    total: 0,
    urgent: false,
    createdAt: new Date(),
    customer: { businessName: "Acme Buyer" },
    lineItems: [],
  });
  (h.service as any).systemConfig.get.mockImplementation((k: string) =>
    k === "settings.taxRate" ? "8.25" : null,
  );
  return h;
}

const quote = (h: Awaited<ReturnType<typeof setup>>, items = ITEMS) =>
  quoteForBuyer(h.service, items, undefined, customerPayload as never);

describe("quoteForBuyer is create()'s own number", () => {
  it("1: the quote carries tax and the per-unit levy", async () => {
    const h = await setup();
    await expect(quote(h)).resolves.toEqual({
      subtotal: 31.2,
      tax: 2.57,
      levy: 36,
      total: 69.77,
      taxExempt: false,
    });
  });

  it("2: the quote equals what create() stores for the same cart", async () => {
    const h = await setup();
    const q = await quote(h);
    await h.service.create({ items: ITEMS } as never, customerPayload as never);
    const data = (h.prisma.order.create.mock.calls[0][0] as any).data;
    const levy = data.lineItems.create.reduce((n: number, l: any) => n + l.categoryTaxAmount, 0);
    expect([q.subtotal, q.tax, q.levy, q.total]).toEqual([
      data.subtotal,
      data.tax,
      levy,
      data.total,
    ]);
  });

  it("4: a tax-exempt buyer is quoted tax 0 and no levy", async () => {
    const h = await setup({ exempt: true });
    await expect(quote(h)).resolves.toEqual({
      subtotal: 31.2,
      tax: 0,
      levy: 0,
      total: 31.2,
      taxExempt: true,
    });
  });

  it("5: a quantity-break promotion is netted in the quoted subtotal", async () => {
    const h = await setup();
    (h.module.get(PromotionsService).activeForCatalog as jest.Mock).mockResolvedValue([
      {
        id: "promo-1",
        type: "QTY_BREAK",
        value: 10,
        minQty: 10,
        scope: "ALL",
        category: null,
        productIds: [],
      },
    ] as never);
    const q = await quote(h, [{ productId: "p-12pack", qty: 10 }]);
    expect(q.subtotal).toBe(140.4); // 10 x 15.60 less 10% (full price would be 156.00)
  });

  it("6: a quote writes nothing and reaches no gate, lock or number", async () => {
    const h = await setup();
    jest.clearAllMocks();
    const creditGate = jest.spyOn(h.service as never, "creditGate" as never);
    await quote(h);
    const p = h.prisma as any;
    expect(p.order.create).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
    expect(p.orderItem.createMany).not.toHaveBeenCalled();
    expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
    expect(h.authGuard.assertAuthorizedOrThrow).not.toHaveBeenCalled();
    // no order number, return number, credit gate or oversell read either (each sits after the fence)
    expect(reserveReturnNo).not.toHaveBeenCalled();
    expect(nextOrderNumberFor).not.toHaveBeenCalled();
    expect(creditGate).not.toHaveBeenCalled();
    expect(resolveOversellAllowed).not.toHaveBeenCalled();
  });

  it("7: a line create refuses gets create's refusal, never a partial quote", async () => {
    const h = await setup();
    h.prisma.product.findMany.mockResolvedValue([]); // the product is gone / hidden
    await expect(quote(h)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("13: a quote adds no SA-982 census line, while create on the same line adds one", async () => {
    const boxed = { unitsPerBox: 12, pricePerUnit: 1.3 };
    const lines = [{ productId: "p-12pack", qty: 24 }]; // a bare qty on a boxed line
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const census = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes("site=orders.create.lines")).length;
    try {
      const h = await setup({ product: boxed });
      await quote(h, lines);
      const afterQuote = census();
      await h.service.create(
        { items: [{ productId: "p-12pack", qty: 24 }] } as never,
        customerPayload as never,
      );
      expect(afterQuote).toBe(0);
      expect(census()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("20: a quote whose hook does not throw meets the fence and writes nothing", async () => {
    const h = await setup();
    await expect(
      h.service.create({ items: ITEMS } as never, customerPayload as never, {
        quote: true,
        skipAutoMerge: true,
        beforeWrite: () => undefined,
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(h.prisma.order.create).not.toHaveBeenCalled();
    expect((h.prisma as any).$transaction).not.toHaveBeenCalled();
  });
});

describe("16: the quote is the cart alone; a fold is priced on the combined qty", () => {
  const BOGO = {
    id: "promo-bogo",
    type: "BUY_N_GET_M",
    value: 1,
    minQty: 5,
    scope: "ALL",
    category: null,
    productIds: [],
  };
  it("an open order holding 3 of a buy-5-get-1 product plus 3 in the cart: the fold total is not old + quote", async () => {
    const h = await setup();
    (h.module.get(PromotionsService).activeForCatalog as jest.Mock).mockResolvedValue([
      BOGO,
    ] as never);
    const oldOrder = await quote(h, [{ productId: "p-12pack", qty: 3 }]); // what the open order holds
    const cartOnly = await quote(h, [{ productId: "p-12pack", qty: 3 }]); // what the quote shows for the cart
    const folded = await quote(h, [{ productId: "p-12pack", qty: 6 }]); // the fold re-earns BOGO on the combined 6
    expect(oldOrder.subtotal + cartOnly.subtotal).toBe(93.6);
    expect(folded.subtotal).toBe(78); // 5 x 15.60: the 6th is free
    expect(folded.subtotal).not.toBe(oldOrder.subtotal + cartOnly.subtotal);
    expect(folded.total).not.toBe(oldOrder.total + cartOnly.total);
  });
});

describe("the quote seam is pinned", () => {
  const SRC = join(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  const prod = walk(SRC).filter((p) => !/\.(spec|test)\.ts$/.test(p));
  const rel = (p: string) =>
    p
      .slice(SRC.length + 1)
      .split("\\")
      .join("/");

  it("3a: `quote: true` is set in order-quote.ts and nowhere else in apps/api/src", () => {
    const setters = prod.filter((p) => /\bquote:\s*true\b/.test(readFileSync(p, "utf8"))).map(rel);
    expect(setters).toEqual(["orders/order-quote.ts"]);
  });

  it("3b: the fence sits right after the beforeWrite hook, before the license gate", () => {
    const src = readFileSync(join(__dirname, "orders.service.ts"), "utf8");
    const hook = src.indexOf("options.beforeWrite?.(");
    const fence = src.indexOf("if (options.quote) throw");
    const gate = src.indexOf("// W6: license guard");
    expect(hook).toBeGreaterThan(0);
    expect(fence).toBeGreaterThan(hook);
    expect(gate).toBeGreaterThan(fence);
  });

  it("3c: the quote path computes no figure of its own", () => {
    for (const f of ["orders/order-quote.ts", "buyer/buyer-quote.controller.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const banned of [
        /orderTotalsOf\(/,
        /sumInvoiceTotals\(/,
        /computeCategoryTax\(/,
        /saleTotals\(/,
        /\*\s*taxRate/,
      ]) {
        expect(src).not.toMatch(banned);
      }
    }
  });
});

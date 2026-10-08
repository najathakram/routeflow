/**
 * B905 (SA-576 follow-up, SA-758 CR-1): a line returned in several slices must credit EXACTLY its billed amount in total.
 * `priceMatchedChunk` priced each slice from scratch (roundMoney(S x c / P)), so three one-piece slices of a $10.00 line of
 * 3 pieces credited 3.33 x 3 = $9.99 (a cent of drift per line, in the customer's favour or against it depending on the
 * split). The chunk is now TELESCOPED over the pieces the line already had credited by earlier inline returns
 * (`priorPieces`): credit(prior + now) - credit(prior), on the same linear cumulative basis, so the slices sum to the whole.
 */
import { Test } from "@nestjs/testing";
import { priceMatchedChunk, type CandidateInvoiceLine } from "./inline-returns-pricing";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

function line(o: Partial<CandidateInvoiceLine> = {}): CandidateInvoiceLine {
  const base = {
    sourceOrderId: "order-1",
    sourceInvoiceItemId: "item-1",
    sourceOrderItemId: "oi-1",
    productId: "prod-1",
    qty: 3,
    unitPrice: 10 / 3,
    subtotal: 10,
    boxes: null as number | null,
    pieces: null as number | null,
    unitsPerBox: null as number | null,
    promoFreeUnits: null as number | null,
    taxRate: 0,
    categoryTax: null,
    invoiceSubtotal: 10,
    invoiceDiscount: 0,
    invoiceTaxAmount: 0,
    ...o,
  };
  return { ...base, piecesQty: base.boxes != null ? base.qty : base.qty * (base.unitsPerBox || 1) };
}

const sliced = (
  l: CandidateInvoiceLine,
  slices: number[],
  field: "subtotal" | "taxAmount" | "categoryTax",
) => {
  let prior = 0;
  const out: number[] = [];
  for (const s of slices) {
    out.push(priceMatchedChunk({ ...l, priorPieces: prior }, s, false)[field]);
    prior += s;
  }
  return out;
};
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe("B905: priceMatchedChunk telescopes over the pieces already credited", () => {
  it("three one-piece slices of a $10.00 / 3-piece line credit exactly $10.00 (3.33 + 3.34 + 3.33), not $9.99", () => {
    const out = sliced(line(), [1, 1, 1], "subtotal");
    expect(out).toEqual([3.33, 3.34, 3.33]);
    expect(sum(out)).toBe(10);
  });

  it("with no priorPieces (or 0) a first slice prices exactly as before", () => {
    expect(priceMatchedChunk(line(), 1, false).subtotal).toBe(3.33);
    expect(priceMatchedChunk(line({ priorPieces: 0 }), 1, false).subtotal).toBe(3.33);
  });

  it("the tax telescopes on the same cumulative basis: slices sum to the whole line's tax", () => {
    const l = line({
      subtotal: 10.01,
      taxRate: 0.0875,
      invoiceTaxAmount: 0.88,
      invoiceSubtotal: 10.01,
    });
    const whole = priceMatchedChunk(l, 3, false).taxAmount;
    expect(sum(sliced(l, [1, 1, 1], "taxAmount"))).toBe(whole);
    expect(sum(sliced(l, [2, 1], "taxAmount"))).toBe(whole);
  });

  it("the category (excise) tax telescopes too", () => {
    const l = line({ categoryTax: 1 });
    expect(sum(sliced(l, [1, 1, 1], "categoryTax"))).toBe(1);
  });

  it("the invoice discount share telescopes: the net slices sum to the whole line's net", () => {
    const l = line({ invoiceSubtotal: 20, invoiceDiscount: 3.33 });
    const whole = priceMatchedChunk(l, 3, true).subtotal;
    expect(sum(sliced(l, [1, 1, 1], "subtotal"))).toBe(whole);
  });

  it("a boxed (selling-unit) line telescopes on its own axis: 12-pack, S=$10.00 for 3 boxes, one box at a time", () => {
    const l = line({ qty: 3, unitsPerBox: 12, subtotal: 10, boxes: null });
    expect(sum(sliced(l, [12, 12, 12], "subtotal"))).toBe(10);
  });

  it("a prior past the line never pushes a slice negative or past the line", () => {
    const out = priceMatchedChunk(line({ priorPieces: 3 }), 1, false);
    expect(out.subtotal).toBe(0);
  });
});

describe("B905: the quote reads the line's earlier inline returns", () => {
  const OPERATOR = {
    sub: "user-op-1",
    role: "OPERATOR",
    tenantId: "t1",
    tenantSlug: "acme",
    username: "admin",
    status: "ACTIVE",
  } as JwtPayload;

  async function quoteWithPrior(priorPieces: number) {
    const prisma = createMockPrisma();
    const db: any = prisma.forTenant();
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();
    const svc = mod.get(InlineReturnsQuoteService);
    db.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: true,
      isWalkIn: false,
    });
    db.customerPrice.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        pricePerUnit: 4,
        priceTier2: 4,
        priceTier3: 4,
        priceTier4: 4,
        priceTier5: 4,
        unitsPerBox: null,
      },
    ]);
    db.invoice.findMany.mockResolvedValue([
      {
        orderId: "ord-1",
        subtotal: 10,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "item-1",
            orderItemId: "oi-1",
            productId: "prod-1",
            qty: 3,
            unitPrice: 3.33,
            subtotal: 10,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            promoFreeUnits: null,
            taxRate: 0,
            categoryTaxAmount: 0,
          },
        ],
      },
    ]);
    db.return.findMany.mockResolvedValue([]);
    // the same table answers the per-order prior-returned read and the per-LINE credited read
    db.returnItem.findMany.mockImplementation(async (args: any) => {
      if (priorPieces === 0) return [];
      if (args?.where?.sourceInvoiceItemId)
        return [{ sourceInvoiceItemId: "item-1", qty: priorPieces }];
      if (args?.where?.sourceOrderId) return [{ productId: "prod-1", qty: priorPieces }];
      return [];
    });
    return svc.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", boxes: 0, pieces: 1 }] } as any,
      OPERATOR,
    );
  }

  it("the third one-piece return of a $10.00 / 3-piece line (two already credited) is $3.33; the second is $3.34", async () => {
    expect((await quoteWithPrior(0)).total).toBe(3.33);
    expect((await quoteWithPrior(1)).total).toBe(3.34);
    expect((await quoteWithPrior(2)).total).toBe(3.33);
  });
});

/**
 * #2716c / SA-592 — the order -> invoice / revision / merge copiers carry `priceType` and
 * `originalPrice` VERBATIM, so a below-list edit stored DISCOUNTED + list reaches the next
 * invoice, the revision snapshot, the merge winner and the replaceAll rebuild unchanged (none of
 * them re-classifies or re-prices). Sibling of staff-override-consumers.spec.ts.
 */
import { PriceType } from "@prisma/client";
import { InvoicesService } from "../invoices/invoices.service";
import { appendOrderRevision } from "./order-revisions";
import { collectUnlistedLoserItems } from "./merge-unlisted-lines";
import { buildBogoCounterpart, buildExistingLineMaps } from "./replace-all-line-build";

// buildInvoiceItemData is pure (reads no `this.*`), so a bare instance is enough.
const service = new (InvoicesService as any)();
const buildInvoiceLine = (li: any) => (service as any).buildInvoiceItemData(li, li.qty, "t-1");

const orderLine = (over: Record<string, unknown>) => ({
  id: "oi-1",
  productId: "p-1",
  qty: 3,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitPrice: 4,
  subtotal: 12,
  product: { name: "Widget", unitsPerBox: 0 },
  ...over,
});

describe("order -> invoice line copier (invoices.service buildInvoiceItemData)", () => {
  it("DISCOUNTED at 4 with list 6 lands on the invoice as DISCOUNTED, originalPrice 6, discount 0", () => {
    const line = buildInvoiceLine(orderLine({ priceType: "DISCOUNTED", originalPrice: 6 }));
    expect(line).toMatchObject({
      unitPrice: 4,
      priceType: "DISCOUNTED",
      originalPrice: 6,
      discount: 0,
    });
  });

  it("SPECIAL keeps its list, STANDARD keeps a null original", () => {
    expect(
      buildInvoiceLine(orderLine({ priceType: "SPECIAL", originalPrice: 6, unitPrice: 5 })),
    ).toMatchObject({ priceType: "SPECIAL", originalPrice: 6 });
    expect(
      buildInvoiceLine(orderLine({ priceType: "STANDARD", originalPrice: null, unitPrice: 6 })),
    ).toMatchObject({ priceType: "STANDARD", originalPrice: null });
  });
});

describe("order revision snapshot copier (order-revisions appendOrderRevision)", () => {
  it("snapshots priceType + originalPrice verbatim per line", async () => {
    const create = jest.fn();
    const tx = {
      orderRevision: {
        aggregate: jest.fn().mockResolvedValue({ _max: { revisionNumber: 2 } }),
        create,
      },
    };
    const prisma = {
      getTenantId: () => "t-1",
      forTenant: () => ({
        orderItem: {
          findMany: jest.fn().mockResolvedValue([
            orderLine({ priceType: "DISCOUNTED", originalPrice: 6, status: "PENDING" }),
            orderLine({
              id: "oi-2",
              priceType: "STANDARD",
              originalPrice: null,
              status: "PENDING",
            }),
          ]),
        },
      }),
      tenantTransaction: async (fn: (t: unknown) => Promise<void>) => fn(tx),
    };
    await appendOrderRevision(
      prisma as any,
      "ord-1",
      undefined,
      { subtotal: 12, tax: 0, total: 12 },
      "EDIT",
    );
    const { lineItems } = create.mock.calls[0][0].data.snapshot;
    expect(lineItems[0]).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6, unitPrice: 4 });
    expect(lineItems[1]).toMatchObject({ priceType: "STANDARD", originalPrice: null });
  });
});

describe("merge loser copier (merge-unlisted-lines collectUnlistedLoserItems)", () => {
  it("an unlisted loser line keeps priceType + originalPrice verbatim", () => {
    const items = collectUnlistedLoserItems([
      {
        lineItems: [
          {
            productId: null,
            name: "Custom",
            qty: 2,
            unitPrice: 4,
            priceType: PriceType.DISCOUNTED,
            originalPrice: 6,
            overrideReason: "promo",
            overriddenBy: "u-1",
            notes: null,
          },
        ],
      },
    ]);
    expect(items[0]).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6, unitPrice: 4 });
  });
});

describe("replaceAll existing-line map (replace-all-line-build buildExistingLineMaps)", () => {
  it("carries the stored priceType + originalPrice (as numbers) and the reason attribution", () => {
    const { existingLineById } = buildExistingLineMaps(
      [
        {
          id: "oi-1",
          productId: "p-1",
          status: "PENDING",
          unitPrice: "4.0000",
          priceType: PriceType.DISCOUNTED,
          originalPrice: "6.0000",
          overrideReason: "promo",
          overriddenBy: "u-1",
        },
      ],
      new Map([["p-1", 1]]),
      new Map([["p-1", 1]]),
    );
    expect(existingLineById.get("oi-1")).toEqual({
      unitPrice: 4,
      priceType: "DISCOUNTED",
      originalPrice: 6,
      overrideReason: "promo",
      overriddenBy: "u-1",
    });
  });
});

describe("replaceAll BOGO counterpart snapshot (replace-all-line-build buildBogoCounterpart)", () => {
  it("carries priceType + originalPrice verbatim from an edited below-list line, with attribution", () => {
    expect(
      buildBogoCounterpart({
        qty: "3",
        boxes: 3,
        unitPrice: "4.0000",
        priceType: PriceType.DISCOUNTED,
        originalPrice: "6.0000",
        overrideReason: "promo",
        overriddenBy: "u-1",
        promoFreeUnits: "1",
      }),
    ).toEqual({
      qty: 3,
      boxes: 3,
      unitPrice: 4,
      priceType: "DISCOUNTED",
      originalPrice: 6,
      overrideReason: "promo",
      overriddenBy: "u-1",
      promoFreeUnits: 1,
    });
  });

  it("a STANDARD line keeps a null original and null attribution", () => {
    expect(
      buildBogoCounterpart({ qty: 1, unitPrice: 6, priceType: "STANDARD", promoFreeUnits: 2 }),
    ).toMatchObject({ priceType: "STANDARD", originalPrice: null, overrideReason: null });
  });
});

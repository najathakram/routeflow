import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { InvoiceStatus } from "@prisma/client";
import { loadResyncInputs } from "./resync-plan";
import { reconcileSplitOrderDrafts } from "./split-draft-reconcile";
import { planPartialPriceFollow } from "./partial-price-follow";
import { ORDER_LINE_PRODUCT_SELECT } from "./invoice-line-name";
import { buildEditedLines, matchEditLines, type StoredEditRow } from "./invoice-edit-plan";

/**
 * review-a F1 / F2 (#4098). An order edit after delivery rebuilds the order's invoices through `buildInvoiceItemData`, which
 * composes "<Family> - <Variant>" from the product's family fields. A loader that hand-types the order line's product select
 * leaves those fields out, so the rebuild stores the BARE name over a line that was stored composed and marks an untouched
 * sent invoice "changed since sent". Every order read that feeds the builder must use ORDER_LINE_PRODUCT_SELECT.
 */

/** The `product` select the order read asked for, captured from a db double that stops right after it. */
const captured = () => {
  const findUnique = jest.fn().mockResolvedValue(null);
  return {
    findUnique,
    select: () => findUnique.mock.calls[0][0].include.lineItems.include.product.select,
  };
};

describe("the order reads behind an order-edit rebuild ask for the family (F1)", () => {
  it("loadResyncInputs (post-delivery re-sync)", async () => {
    const c = captured();
    const db = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([{ id: "i1", items: [{ orderItemId: "oi1" }] }]),
      },
      order: { findUnique: c.findUnique },
    };
    await loadResyncInputs(db, "o1");
    expect(c.select()).toEqual(ORDER_LINE_PRODUCT_SELECT);
  });

  it("reconcileSplitOrderDrafts (split drafts)", async () => {
    const c = captured();
    const draft = (id: string) => ({
      id,
      status: InvoiceStatus.DRAFT,
      deliveryBatchId: null,
      items: [],
    });
    const db = {
      invoice: { findMany: jest.fn().mockResolvedValue([draft("d1"), draft("d2")]) },
      order: { findUnique: c.findUnique },
    };
    await reconcileSplitOrderDrafts({} as any, "o1", "order", db);
    expect(c.select()).toEqual(ORDER_LINE_PRODUCT_SELECT);
  });

  it("planPartialPriceFollow (partial-invoice price follow)", async () => {
    const c = captured();
    const db = {
      invoice: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: "i1", status: InvoiceStatus.DRAFT, items: [] }]),
      },
      order: { findUnique: c.findUnique },
    };
    await planPartialPriceFollow({} as any, db, "o1").catch(() => undefined);
    expect(c.select()).toEqual(ORDER_LINE_PRODUCT_SELECT);
  });
});

/**
 * The sweep: no non-spec file under src/ may hand-type a `product: { select: { ... } }` that carries the order line's pack and
 * category facts (the shape `buildInvoiceItemData` reads). A new loader into the builder either uses the shared select or is
 * red here, so none can miss the family fields the way the two above did.
 */
describe("sweep: no hand-typed order-line product select anywhere in src/", () => {
  const SRC = join(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (/\.ts$/.test(n) && !/\.(spec|test|fake-tx)\.ts$|\.d\.ts$/.test(n)) out.push(f);
    }
    return out;
  };

  it("every `product: { select: { ... unitsPerBox ... trackedCategoryId ... } }` is the shared select", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/product:\s*\{\s*select:\s*\{([^}]*)\}/g)) {
        if (/unitsPerBox/.test(m[1]) && /trackedCategoryId/.test(m[1])) {
          offenders.push(relative(SRC, f).split("\\").join("/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("a no-change save of a legacy bare line keeps its stored text (F2)", () => {
  const variantRow = {
    id: "p-variant",
    name: "Classic",
    variantName: "Classic",
    parentProductId: "p-family",
    parent: { name: "Acme Family" },
    kind: "SIMPLE",
    unitsPerBox: 0,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
  };
  const stored = {
    id: "row-1",
    invoiceId: "inv-1",
    productId: "p-variant",
    description: "Classic",
    qty: 12,
    unitPrice: 8,
    discount: 0,
    taxRate: 0,
    subtotal: 96,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    promoFreeUnits: null,
    notes: null,
    orderItemId: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    categoryTaxAmount: 0,
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
  } as StoredEditRow;
  // the editor posts back the words findOne showed it, with the money exactly as stored
  const save = (description: string) => {
    const items = [
      { id: "row-1", productId: "p-variant", description, qty: 12, unitPrice: 8, discount: 0 },
    ];
    return buildEditedLines({
      items,
      stored: [stored],
      matches: matchEditLines(items as any, [stored]),
      productMap: new Map([["p-variant", variantRow]]),
      categoryMap: new Map(),
      clampFreeUnits: (free: number | undefined) => free ?? 0,
      warn: jest.fn(),
    } as any)[0];
  };

  it("posting the composed words the screen showed keeps the stored bare text, so the sent invoice stays unchanged", () => {
    const line = save("Acme Family - Classic");
    expect(line.untouched).toBe(true);
    expect(line.data.description).toBe("Classic");
  });

  it("posting the stored words changes nothing", () => {
    expect(save("Classic").data.description).toBe("Classic");
  });

  it("a description someone typed over the name is stored as typed", () => {
    expect(save("Classic, gift").data.description).toBe("Classic, gift");
  });
});

import { sanitizeSnapshot } from "@/lib/invoice-draft-storage";
import { checkDraftReferences } from "./invoice-draft-restore";

const snap = (lines: Array<Record<string, unknown>>, customer = true) =>
  sanitizeSnapshot({
    basis: "standalone",
    customer: customer ? { id: "c-1", businessName: "Acme Co" } : null,
    lines,
  })!;
const line = (productId: string) => ({
  productId,
  description: productId,
  qty: 1,
  unitPrice: 5,
  discount: 0,
  taxable: false,
});

type Res = { data?: unknown } | { reject: unknown };
function getter(map: Record<string, Res>) {
  return (url: string) => {
    const r = map[url] ?? { data: {} };
    return "reject" in r ? Promise.reject(r.reject) : Promise.resolve(r);
  };
}
const status = (s: number) => ({ reject: { response: { status: s } } });

describe("checkDraftReferences: what counts as gone (ROW 447)", () => {
  it("an inactive product is dropped", async () => {
    const r = await checkDraftReferences(
      snap([line("p-off"), line("p-on")]),
      getter({
        "/products/p-off": { data: { id: "p-off", isActive: false } },
        "/products/p-on": { data: { id: "p-on", isActive: true } },
      }),
    );
    expect(r.snapshot.lines.map((l) => l.productId)).toEqual(["p-on"]);
    expect(r.droppedLines).toBe(1);
  });

  it("a soft-deleted or archived product is dropped", async () => {
    const r = await checkDraftReferences(
      snap([line("p-del"), line("p-arc")]),
      getter({
        "/products/p-del": { data: { id: "p-del", deletedAt: "2026-01-01T00:00:00Z" } },
        "/products/p-arc": { data: { id: "p-arc", archivedAt: "2026-01-01T00:00:00Z" } },
      }),
    );
    expect(r.snapshot.lines).toHaveLength(0);
    expect(r.droppedLines).toBe(2);
  });

  it.each([403, 404, 410])("a %i on a product drops the line", async (s) => {
    const r = await checkDraftReferences(
      snap([line("p-x")]),
      getter({ "/products/p-x": status(s) }),
    );
    expect(r.droppedLines).toBe(1);
  });

  it("a soft-deleted customer is cleared", async () => {
    const r = await checkDraftReferences(
      snap([line("p-1")]),
      getter({
        "/customers/c-1": { data: { id: "c-1", businessName: "Acme Co", deletedAt: "2026-01-01" } },
      }),
    );
    expect(r.customerCleared).toBe(true);
    expect(r.snapshot.customer).toBeNull();
    expect(r.snapshot.lines).toHaveLength(1);
  });

  it("an inactive customer is cleared", async () => {
    const r = await checkDraftReferences(
      snap([]),
      getter({
        "/customers/c-1": { data: { id: "c-1", businessName: "Acme Co", isActive: false } },
      }),
    );
    expect(r.customerCleared).toBe(true);
  });

  it.each([403, 404, 410])("a %i on the customer clears it", async (s) => {
    const r = await checkDraftReferences(snap([]), getter({ "/customers/c-1": status(s) }));
    expect(r.customerCleared).toBe(true);
  });

  it("a network failure keeps both the customer and the line", async () => {
    const off = { reject: new Error("offline") };
    const r = await checkDraftReferences(
      snap([line("p-1")]),
      getter({ "/customers/c-1": off, "/products/p-1": off }),
    );
    expect(r.customerCleared).toBe(false);
    expect(r.droppedLines).toBe(0);
    expect(r.snapshot.customer?.id).toBe("c-1");
  });

  it("a live product and customer are kept", async () => {
    const r = await checkDraftReferences(
      snap([line("p-1")]),
      getter({
        "/customers/c-1": { data: { id: "c-1", businessName: "Acme Co", deletedAt: null } },
        "/products/p-1": { data: { id: "p-1", isActive: true, deletedAt: null } },
      }),
    );
    expect(r.droppedLines).toBe(0);
    expect(r.customerCleared).toBe(false);
  });
});

describe("checkDraftReferences: prices are re-resolved, not trusted (ROW 447)", () => {
  const product = (over: Record<string, unknown> = {}) => ({
    data: {
      id: "p-1",
      isActive: true,
      name: "Widget",
      pricePerUnit: "10",
      priceTier2: "9",
      priceTier3: "7.5",
      averageCost: "4",
      category: "Snacks",
      unit: "each",
      ...over,
    },
  });
  const stored = (over: Record<string, unknown> = {}) => ({ ...line("p-1"), ...over });
  const run = (
    lines: Array<Record<string, unknown>>,
    map: Record<string, Res>,
    customer: Record<string, unknown> = {},
  ) =>
    checkDraftReferences(
      sanitizeSnapshot({
        basis: "standalone",
        customer: { id: "c-1", businessName: "Acme Co", ...customer },
        lines,
      })!,
      getter({ "/products/p-1": product(), ...map }),
    );

  it("a stored price that was not typed is replaced by the fresh list price, and counted", async () => {
    const r = await run([stored({ unitPrice: 5 })], {});
    expect(r.snapshot.lines[0].unitPrice).toBe(10);
    expect(r.snapshot.lines[0].priceType).toBe("STANDARD");
    expect(r.pricesUpdated).toBe(1);
  });

  it("a price the user typed (priceEdited) is kept and not counted", async () => {
    const r = await run([stored({ unitPrice: 5, priceEdited: true, priceType: "MANUAL" })], {});
    expect(r.snapshot.lines[0].unitPrice).toBe(5);
    expect(r.snapshot.lines[0].priceEdited).toBe(true);
    expect(r.pricesUpdated).toBe(0);
  });

  it("a catalog price change between save and restore is picked up", async () => {
    const r = await run([stored({ unitPrice: 10 })], {
      "/products/p-1": product({ pricePerUnit: "12" }),
    });
    expect(r.snapshot.lines[0].unitPrice).toBe(12);
    expect(r.pricesUpdated).toBe(1);
  });

  it("an unchanged price shows no update", async () => {
    const r = await run([stored({ unitPrice: 10 })], {});
    expect(r.snapshot.lines[0].unitPrice).toBe(10);
    expect(r.pricesUpdated).toBe(0);
  });

  it("a tier customer is priced on their ladder, as a fresh add would be", async () => {
    const r = await run([stored({ unitPrice: 10 })], {}, { pricingTier: 3 });
    const l = r.snapshot.lines[0];
    expect(l.unitPrice).toBe(7.5);
    expect(l.isSpecialPrice).toBe(true);
    expect(l.regularPrice).toBe(10);
    expect(l.priceType).toBe("SPECIAL");
    expect(l.pricing).toMatchObject({ tierPrice: 7.5, listPrice: 10, isSpecialTier: true });
    expect(r.pricesUpdated).toBe(1);
  });

  it("the customer's own price row wins over the ladder", async () => {
    const r = await run([stored({ unitPrice: 10 })], {
      "/customers/c-1/prices": {
        data: [{ productId: "p-1", pricingTier: 2, product: product().data }],
      },
    });
    expect(r.snapshot.lines[0].unitPrice).toBe(9);
    expect(r.snapshot.lines[0].isSpecialPrice).toBe(true);
  });

  it("the cost used for the margin hint is the fresh one", async () => {
    const r = await run([stored({ unitPrice: 10 })], {
      "/products/p-1": product({ averageCost: "6" }),
    });
    expect(r.snapshot.lines[0].avgCost).toBe(6);
  });

  it("a product payload with no price cannot be re-resolved: the stored line is kept, uncounted", async () => {
    const r = await run([stored({ unitPrice: 5 })], { "/products/p-1": { data: { id: "p-1" } } });
    expect(r.snapshot.lines[0].unitPrice).toBe(5);
    expect(r.pricesUpdated).toBe(0);
  });

  it("a network failure keeps the stored line unchanged", async () => {
    const r = await run([stored({ unitPrice: 5 })], {
      "/products/p-1": { reject: new Error("offline") },
    });
    expect(r.snapshot.lines[0].unitPrice).toBe(5);
    expect(r.pricesUpdated).toBe(0);
  });

  describe("unit-level lines keep their unit and quantity (units_v1)", () => {
    const level = (over: Record<string, unknown> = {}) => ({
      id: "u-1",
      label: "Half case",
      factorToBase: 6,
      price: "55",
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      isDefaultSelling: false,
      sortOrder: 1,
      ...over,
    });
    const unitLine = (over: Record<string, unknown> = {}) =>
      stored({
        unitPrice: 50,
        unitLabel: "Half case",
        unit: "Half case",
        qty: 3,
        listPrice: 50,
        packBase: { unit: "each", qty: 1, listPrice: 10, unitPrice: 10, priceType: "STANDARD" },
        ...over,
      });

    it("the unit and the typed count are kept, only the price is re-resolved from the ladder", async () => {
      const r = await run([unitLine()], { "/products/p-1/units": { data: [level()] } });
      const l = r.snapshot.lines[0];
      expect(l.qty).toBe(3); // not the pack's old count
      expect(l.unitLabel).toBe("Half case");
      expect(l.unit).toBe("Half case");
      expect(l.unitPrice).toBe(55);
      expect(l.listPrice).toBe(55);
      expect(r.pricesUpdated).toBe(1);
    });

    it("a typed unit price is kept", async () => {
      const r = await run([unitLine({ priceEdited: true, priceType: "MANUAL", unitPrice: 48 })], {
        "/products/p-1/units": { data: [level()] },
      });
      expect(r.snapshot.lines[0].unitPrice).toBe(48);
      expect(r.snapshot.lines[0].qty).toBe(3);
      expect(r.pricesUpdated).toBe(0);
    });

    it("a unit the product no longer offers drops the line and is counted", async () => {
      const r = await run([unitLine(), stored()], {
        "/products/p-1/units": { data: [level({ label: "Quarter case" })] },
      });
      expect(r.snapshot.lines).toHaveLength(1);
      expect(r.snapshot.lines[0].unitLabel).toBeUndefined();
      expect(r.unitsDropped).toBe(1);
      expect(r.droppedLines).toBe(0); // it is not a missing product
    });

    it("a refused ladder read (units switched off) drops the unit line too", async () => {
      const r = await run([unitLine()], { "/products/p-1/units": status(403) });
      expect(r.snapshot.lines).toHaveLength(0);
      expect(r.unitsDropped).toBe(1);
    });

    it("a network failure on the ladder keeps the unit line as stored", async () => {
      const r = await run([unitLine()], {
        "/products/p-1/units": { reject: new Error("offline") },
      });
      expect(r.snapshot.lines[0].unitPrice).toBe(50);
      expect(r.snapshot.lines[0].qty).toBe(3);
      expect(r.unitsDropped).toBe(0);
      expect(r.pricesUpdated).toBe(0);
    });
  });
});

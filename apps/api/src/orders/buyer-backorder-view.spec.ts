import {
  BuyerBackorderViewResolver,
  NO_BACKORDER_VIEW,
  derivedBackordered,
  maskStockForBuyer,
  parseBackorderVisibility,
  type StockTriple,
} from "./buyer-backorder-view";

/**
 * OOS PR2 (SA-714 R2/R3): what a buyer may do and be told about out-of-stock items. The visibility
 * rule is a pure function; the resolver reads each policy at most once per call, and the visibility
 * policy ONLY where the buyer can backorder (no masking for a buyer who cannot).
 */
const OOS: StockTriple = { inStock: false, stockStatus: "OUT_OF_STOCK", stockLeft: null };
const LOW: StockTriple = { inStock: true, stockStatus: "LOW", stockLeft: 3 };
const IN: StockTriple = { inStock: true, stockStatus: "IN_STOCK", stockLeft: null };
const MASKED: StockTriple = { inStock: true, stockStatus: "IN_STOCK", stockLeft: null };

describe("parseBackorderVisibility", () => {
  it('only the exact string "hide" hides; everything else is the truthful "show"', () => {
    expect(parseBackorderVisibility("hide")).toBe("hide");
    for (const v of ["show", "HIDE", "Hide", "yes", "", null, undefined, 1, true, ["hide"]]) {
      expect(parseBackorderVisibility(v)).toBe("show");
    }
  });
});

describe("maskStockForBuyer", () => {
  it.each([
    ["OUT_OF_STOCK", OOS],
    ["LOW", LOW],
    ["IN_STOCK", IN],
  ])("hide + can backorder: a %s item looks in stock and leaks no count", (_n, stock) => {
    expect(maskStockForBuyer(stock, { canBackorder: true, visibility: "hide" })).toEqual(MASKED);
  });

  it.each([
    ["show + can backorder", { canBackorder: true, visibility: "show" as const }],
    ["hide + CANNOT backorder", { canBackorder: false, visibility: "hide" as const }],
    ["show + cannot backorder", { canBackorder: false, visibility: "show" as const }],
  ])("%s: the truthful triple is returned untouched", (_n, view) => {
    for (const stock of [OOS, LOW, IN]) expect(maskStockForBuyer(stock, view)).toBe(stock);
  });
});

describe("derivedBackordered", () => {
  it("under hide the flag is ABSENT (undefined), whatever the line carries", () => {
    expect(derivedBackordered("hide", { backorderPieces: 5 })).toBeUndefined();
    expect(derivedBackordered("hide", {})).toBeUndefined();
  });

  it("under show it is true for a backordered line and false for a line with an empty marker", () => {
    expect(derivedBackordered("show", { backorderPieces: 5 })).toBe(true);
    expect(derivedBackordered("show", { backorderPieces: "2.5" })).toBe(true);
    expect(derivedBackordered("show", { backorderPieces: 0 })).toBe(false);
    expect(derivedBackordered("show", { backorderPieces: null })).toBe(false);
  });

  it("a line with no marker at all (today: the column does not exist yet) derives nothing, even under show", () => {
    expect(derivedBackordered("show", {})).toBeUndefined();
  });
});

describe("BuyerBackorderViewResolver", () => {
  function build(oversellRaw: unknown, visibilityRaw: unknown = "show") {
    const oversell = { read: jest.fn(async () => oversellRaw) };
    const policies = { resolve: jest.fn(async () => visibilityRaw) };
    return {
      oversell,
      policies,
      resolver: new BuyerBackorderViewResolver(oversell as never, policies as never),
    };
  }
  const args = { tenantId: "t1", customerId: "c1" };

  it("can backorder (policy exactly backorder) + the seller's visibility", async () => {
    const { resolver, oversell, policies } = build("backorder", "hide");
    expect(await resolver.resolve(args)).toEqual({ canBackorder: true, visibility: "hide" });
    expect(oversell.read).toHaveBeenCalledTimes(1);
    expect(oversell.read).toHaveBeenCalledWith({ tenantId: "t1", customerId: "c1" });
    expect(policies.resolve).toHaveBeenCalledTimes(1);
    expect(policies.resolve).toHaveBeenCalledWith("t1", "orders.buyerBackorderVisibility", {});
  });

  it("a buyer who cannot backorder is truthful and the visibility policy is NOT even read", async () => {
    const { resolver, policies } = build("off", "hide");
    expect(await resolver.resolve(args)).toEqual(NO_BACKORDER_VIEW);
    expect(policies.resolve).not.toHaveBeenCalled();
  });

  it.each([["BACKORDER"], ["yes"], [null], [undefined], [1]])(
    "an invalid oversell value (%p) fails closed: cannot backorder",
    async (raw) => {
      const { resolver } = build(raw, "hide");
      expect(await resolver.resolve(args)).toEqual(NO_BACKORDER_VIEW);
    },
  );

  it("a throwing oversell reader fails closed; a throwing visibility read falls back to show", async () => {
    const a = build("backorder");
    a.oversell.read.mockRejectedValueOnce(new Error("db down"));
    expect(await a.resolver.resolve(args)).toEqual(NO_BACKORDER_VIEW);

    const b = build("backorder");
    b.policies.resolve.mockRejectedValueOnce(new Error("db down"));
    expect(await b.resolver.resolve(args)).toEqual({ canBackorder: true, visibility: "show" });
  });

  it.each([
    [{ tenantId: null, customerId: "c1" }],
    [{ tenantId: "t1", customerId: null }],
    [{ tenantId: undefined, customerId: undefined }],
  ])("no tenant or no customer (%j): truthful, nothing read", async (a) => {
    const { resolver, oversell, policies } = build("backorder", "hide");
    expect(await resolver.resolve(a)).toEqual(NO_BACKORDER_VIEW);
    expect(oversell.read).not.toHaveBeenCalled();
    expect(policies.resolve).not.toHaveBeenCalled();
  });
});

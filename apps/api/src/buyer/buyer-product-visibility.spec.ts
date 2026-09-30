import {
  buyerVisibleProductByIdWhere,
  buyerVisibleProductWhere,
  firstNewHiddenProduct,
  isBuyerVisibleProduct,
  NO_BUYER_RESTRICTIONS,
} from "./buyer-product-visibility";
import { sellableProductWhere } from "../products/sellable-product-where";

const BASE = [
  { AND: [{ isActive: true }, { kind: { not: "FAMILY" } }] },
  { portalVisible: true },
  { OR: [{ parentProductId: null }, { parent: { portalVisible: true } }] },
];

describe("buyerVisibleProductWhere", () => {
  it("is sellable (active, not a FAMILY) AND portal-visible AND (standalone OR visible parent)", () => {
    expect(buyerVisibleProductWhere(NO_BUYER_RESTRICTIONS)).toEqual({ AND: BASE });
  });

  it("composes the ONE sellable builder, not a copy", () => {
    const w = buyerVisibleProductWhere(NO_BUYER_RESTRICTIONS) as { AND: unknown[] };
    expect(w.AND[0]).toEqual(sellableProductWhere());
  });

  it("excludes the buyer's blocked ids; an empty set adds no clause (switch off)", () => {
    const w = buyerVisibleProductWhere({ restrictedIds: new Set(["b1", "b2"]) }) as {
      AND: unknown[];
    };
    expect(w.AND).toContainEqual({ id: { notIn: ["b1", "b2"] } });
    expect(buyerVisibleProductWhere({ restrictedIds: new Set() })).toEqual({ AND: BASE });
  });

  it("AND-merges extra as its own trailing clause", () => {
    expect(buyerVisibleProductWhere(NO_BUYER_RESTRICTIONS, { category: "Drinks" })).toEqual({
      AND: [...BASE, { category: "Drinks" }],
    });
  });

  it("extra can never override portalVisible/isActive (nested, not spread)", () => {
    const w = buyerVisibleProductWhere(NO_BUYER_RESTRICTIONS, {
      portalVisible: false,
      isActive: false,
    }) as { AND: unknown[] };
    expect(w).not.toHaveProperty("portalVisible");
    expect(w).not.toHaveProperty("isActive");
    expect(w.AND.slice(0, 3)).toEqual(BASE);
    expect(w.AND[3]).toEqual({ portalVisible: false, isActive: false });
  });

  it("id helper is the builder with { id }", () => {
    expect(buyerVisibleProductByIdWhere(NO_BUYER_RESTRICTIONS, "p1")).toEqual(
      buyerVisibleProductWhere(NO_BUYER_RESTRICTIONS, { id: "p1" }),
    );
  });
});

describe("isBuyerVisibleProduct (in-memory twin)", () => {
  const row = {
    id: "p1",
    isActive: true,
    kind: "STANDARD",
    portalVisible: true,
    parent: null as { portalVisible: boolean } | null,
  };

  it("visible only when sellable, not hidden, parent not hidden, not blocked", () => {
    expect(isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, row)).toBe(true);
    expect(isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, { ...row, isActive: false })).toBe(false);
    expect(isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, { ...row, portalVisible: false })).toBe(
      false,
    );
    expect(
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, { ...row, parent: { portalVisible: false } }),
    ).toBe(false);
    expect(
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, { ...row, parent: { portalVisible: true } }),
    ).toBe(true);
  });

  it("a FAMILY container is never visible", () => {
    expect(isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, { ...row, kind: "FAMILY" })).toBe(false);
  });

  it("a blocked id is not visible", () => {
    expect(isBuyerVisibleProduct({ restrictedIds: new Set(["p1"]) }, row)).toBe(false);
  });

  it("every field is REQUIRED: a partial select is a compile error, not a silently visible product", () => {
    // Compile-time pin only: the calls live in a function that is never invoked.
    const compileOnly = () => {
      // @ts-expect-error portalVisible missing — used to count as visible (fail-open)
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, {
        id: "p",
        isActive: true,
        kind: "STANDARD",
        parent: null,
      });
      // @ts-expect-error kind missing
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, {
        id: "p",
        isActive: true,
        portalVisible: true,
        parent: null,
      });
      // @ts-expect-error parent missing (null = standalone must be explicit)
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, {
        id: "p",
        isActive: true,
        kind: "STANDARD",
        portalVisible: true,
      });
    };
    expect(typeof compileOnly).toBe("function");
  });
});

describe("firstNewHiddenProduct (buyer replace-all gate)", () => {
  const hidden = { id: "h", isActive: true, portalVisible: false };
  const underHidden = { id: "v", isActive: true, parent: { portalVisible: false } };
  const ok = { id: "o", isActive: true, portalVisible: true };

  it("returns a hidden or hidden-parent product the order does not already hold", () => {
    expect(firstNewHiddenProduct([ok, hidden], new Set())).toBe(hidden);
    expect(firstNewHiddenProduct([underHidden], new Set())).toBe(underHidden);
  });

  it("lets a line the order already holds be echoed, and ignores visible products", () => {
    expect(firstNewHiddenProduct([hidden, underHidden], new Set(["h", "v"]))).toBeUndefined();
    expect(firstNewHiddenProduct([ok], new Set())).toBeUndefined();
  });

  it("does not turn an archived product into a refusal (archive rules stay as they were)", () => {
    expect(firstNewHiddenProduct([{ id: "a", isActive: false }], new Set())).toBeUndefined();
  });
});

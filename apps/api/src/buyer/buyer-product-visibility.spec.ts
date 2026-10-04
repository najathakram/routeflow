import { ConflictException } from "@nestjs/common";
import {
  buyerVisibleProductByIdWhere,
  buyerVisibleProductWhere,
  assertBuyerMayOrder,
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
      const noFlag = { id: "p", isActive: true, kind: "STANDARD", parent: null };
      const noKind = { id: "p", isActive: true, portalVisible: true, parent: null };
      const noParent = { id: "p", isActive: true, kind: "STANDARD", portalVisible: true };
      // @ts-expect-error portalVisible missing: used to count as visible (fail-open)
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, noFlag);
      // @ts-expect-error kind missing
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, noKind);
      // @ts-expect-error parent missing (null = standalone must be explicit)
      isBuyerVisibleProduct(NO_BUYER_RESTRICTIONS, noParent);
    };
    expect(typeof compileOnly).toBe("function");
  });
});

describe("assertBuyerMayOrder (WS6 refusal: 409 SELLING_RESTRICTED, reason HIDDEN_FROM_PORTAL)", () => {
  const ok = {
    id: "o",
    name: "Ok Item",
    isActive: true,
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
  };
  const hidden = { ...ok, id: "h", name: "Hidden One", portalVisible: false };
  const underHidden = { ...ok, id: "v", name: "Variant Two", parent: { portalVisible: false } };
  const family = { ...ok, id: "f", name: "Family", kind: "FAMILY" };
  const bodyOf = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as ConflictException).getResponse() as Record<string, any>;
    }
    return null;
  };

  it("every field is REQUIRED: a partial select is a compile error, not a silently orderable product (SA-612)", () => {
    // Compile-time pin only: the calls live in a function that is never invoked.
    const compileOnly = () => {
      const noFlag = { id: "p", name: "n", isActive: true, kind: "STANDARD", parent: null };
      const noKind = { id: "p", name: "n", isActive: true, portalVisible: true, parent: null };
      const noParent = {
        id: "p",
        name: "n",
        isActive: true,
        kind: "STANDARD",
        portalVisible: true,
      };
      // @ts-expect-error portalVisible missing
      assertBuyerMayOrder([noFlag], new Set());
      // @ts-expect-error kind missing
      assertBuyerMayOrder([noKind], new Set());
      // @ts-expect-error parent missing (null = standalone must be explicit)
      assertBuyerMayOrder([noParent], new Set());
    };
    expect(typeof compileOnly).toBe("function");
  });

  it("a visible product passes", () => {
    expect(() => assertBuyerMayOrder([ok], new Set())).not.toThrow();
  });

  it("names EVERY new hidden product in the existing buyer envelope, with reason only HIDDEN_FROM_PORTAL", () => {
    const body = bodyOf(() => assertBuyerMayOrder([ok, hidden, underHidden, family], new Set()));
    expect(body).toMatchObject({ code: "SELLING_RESTRICTED" });
    expect(body!.blockedLines).toEqual([
      { productId: "h", productName: "Hidden One", reason: "HIDDEN_FROM_PORTAL" },
      { productId: "v", productName: "Variant Two", reason: "HIDDEN_FROM_PORTAL" },
      { productId: "f", productName: "Family", reason: "HIDDEN_FROM_PORTAL" },
    ]);
    expect(typeof body!.message).toBe("string");
    expect(body!.message).not.toMatch(/archived/i);
    expect(Object.keys(body!.blockedLines[0]).sort()).toEqual([
      "productId",
      "productName",
      "reason",
    ]);
  });

  it("is a 409 ConflictException, not a 400", () => {
    expect(() => assertBuyerMayOrder([hidden], new Set())).toThrow(ConflictException);
  });

  it("a line the order already holds can be echoed (replace-all keeps held hidden lines)", () => {
    expect(() => assertBuyerMayOrder([hidden, underHidden], new Set(["h", "v"]))).not.toThrow();
  });

  it("archived products are not judged here (the archived 400 rules stay as they were)", () => {
    expect(() =>
      assertBuyerMayOrder([{ ...ok, id: "a", isActive: false }], new Set()),
    ).not.toThrow();
  });
});

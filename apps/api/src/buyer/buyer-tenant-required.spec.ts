import { ConflictException } from "@nestjs/common";
import {
  assertBuyerLines,
  buyerVisibleProductWhere,
  isBuyerVisibleProduct,
  noBuyerRestrictions,
} from "./buyer-product-visibility";
import { isSellableProduct, sellableProductWhere } from "../products/sellable-product-where";

/**
 * B1211 (Opus re-review of #3322): the tenant behind the sellable-parent filter is REQUIRED everywhere, never an
 * optional argument a call site can forget. A missing tenant fails CLOSED (a variant is not sellable / the builder
 * refuses to build), never open (an unscoped parent link followed).
 */
type LoadedParent = { portalVisible: boolean; isActive: boolean; tenantId: string | null };
// `undefined` = a select that forgot the column (a runtime hazard the type forbids; cast to model it).
const variant = (parentTenant: string | null | undefined) => ({
  id: "v1",
  isActive: true,
  kind: "VARIANT",
  portalVisible: true,
  parent: {
    portalVisible: true,
    isActive: true,
    ...(parentTenant === undefined ? {} : { tenantId: parentTenant }),
  } as LoadedParent,
});
const noTenant = undefined as unknown as string;

describe("the sellable predicates require a tenant (B1211)", () => {
  it("sellableProductWhere refuses to build without a tenant", () => {
    expect(() => sellableProductWhere(undefined, noTenant)).toThrow(/tenant/i);
    expect(() => sellableProductWhere(undefined, "")).toThrow(/tenant/i);
  });

  it("isSellableProduct is false for a variant when no tenant is known", () => {
    expect(isSellableProduct(variant("t-1"), noTenant)).toBe(false);
    expect(isSellableProduct(variant(undefined), noTenant)).toBe(false);
  });

  it("isSellableProduct still judges a parent of the right tenant sellable and another tenant not", () => {
    expect(isSellableProduct(variant("t-1"), "t-1")).toBe(true);
    expect(isSellableProduct(variant("t-2"), "t-1")).toBe(false);
    expect(isSellableProduct(variant(undefined), "t-1")).toBe(false);
  });
});

describe("the buyer visibility context requires a tenant (B1211)", () => {
  it("noBuyerRestrictions needs a tenant id and carries it", () => {
    expect(() => noBuyerRestrictions(noTenant)).toThrow(/tenant/i);
    expect(() => noBuyerRestrictions("")).toThrow(/tenant/i);
    expect(noBuyerRestrictions("t-1")).toMatchObject({ tenantId: "t-1" });
    expect(noBuyerRestrictions("t-1").restrictedIds.size).toBe(0);
  });

  it("buyerVisibleProductWhere refuses a context without a tenant", () => {
    const ctx = { restrictedIds: new Set<string>() } as unknown as Parameters<
      typeof buyerVisibleProductWhere
    >[0];
    expect(() => buyerVisibleProductWhere(ctx)).toThrow(/tenant/i);
  });

  it("the where always scopes the parent filters to the context tenant", () => {
    const w = buyerVisibleProductWhere(noBuyerRestrictions("t-1")) as {
      AND: Array<{ AND?: unknown[]; OR?: unknown[] }>;
    };
    expect(w.AND[0].AND?.[2]).toEqual({
      OR: [{ parentProductId: null }, { parent: { isActive: true, tenantId: "t-1" } }],
    });
    expect(w.AND[2]).toEqual({
      OR: [{ parentProductId: null }, { parent: { portalVisible: true, tenantId: "t-1" } }],
    });
  });

  it("the twin refuses a variant with a cross-tenant or tenantless parent, and the same tenant passes", () => {
    const ctx = noBuyerRestrictions("t-1");
    expect(isBuyerVisibleProduct(ctx, variant("t-2"))).toBe(false);
    expect(isBuyerVisibleProduct(ctx, variant(undefined))).toBe(false);
    expect(isBuyerVisibleProduct(ctx, variant("t-1"))).toBe(true);
  });
});

describe("the buyer order-write gate is tenant-scoped (B1211)", () => {
  const order = (parent: { tenantId: string | null }) => ({
    id: "v1",
    name: "Variant",
    isActive: true,
    kind: "VARIANT",
    portalVisible: true,
    parent: { portalVisible: true, isActive: true, ...parent },
  });
  const buyer = { role: "CUSTOMER", tenantId: "t-1" };

  it("a variant under a parent of another tenant is refused with the buyer 409", () => {
    expect(() => assertBuyerLines(buyer, [order({ tenantId: "t-2" })])).toThrow(ConflictException);
  });

  it("a variant under a same-tenant parent passes", () => {
    expect(() => assertBuyerLines(buyer, [order({ tenantId: "t-1" })])).not.toThrow();
  });

  it("a buyer with no tenant on the token fails closed", () => {
    expect(() =>
      assertBuyerLines({ role: "CUSTOMER", tenantId: null }, [order({ tenantId: "t-1" })]),
    ).toThrow();
  });

  it("staff are untouched, with or without a tenant", () => {
    const staff = { role: "OPERATOR", tenantId: null };
    expect(() => assertBuyerLines(staff, [order({ tenantId: "t-2" })])).not.toThrow();
  });
});

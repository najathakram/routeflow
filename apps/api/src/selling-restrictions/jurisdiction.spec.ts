import {
  resolveSaleJurisdiction,
  salePathForOrder,
  usesStoreState,
  type SalePath,
} from "./jurisdiction";
import { resolveGoverningState, type CustomerAddressFacts } from "./selling-restrictions.core";

/**
 * Row 510 (lead ruling Q5): the ONE answer to "which state is this sale judged in?". COUNTER / POS and every PICKUP use
 * the store's state for a named customer or not; DELIVERY and SHIP use the customer's governing address under the
 * tenant's existing precedence (the resolver is REUSED, never forked), and the system walk-in is judged at the store on
 * any path.
 */
const addr = (over: Partial<CustomerAddressFacts> = {}): CustomerAddressFacts => ({
  isDefault: true,
  addressType: "BILLING",
  stateCode: "TX",
  stateNeedsReview: false,
  ...over,
});
const tenant = (
  businessState: string | null,
  addressPrecedence: "BILLING_FIRST" | "SHIPPING_FIRST" = "BILLING_FIRST",
) => ({
  businessState,
  addressPrecedence,
});

describe("resolveSaleJurisdiction", () => {
  it.each<SalePath>(["COUNTER", "POS", "PICKUP"])(
    "%s is judged by the STORE's state, whatever address the named customer has on file",
    (path) => {
      expect(
        resolveSaleJurisdiction({
          path,
          customer: { addresses: [addr({ stateCode: "TX" })] },
          tenant: tenant("CA"),
        }),
      ).toEqual({ state: "CA", basis: "STORE" });
    },
  );

  it.each<SalePath>(["DELIVERY", "SHIP"])(
    "%s is judged by the CUSTOMER's governing address, not the store",
    (path) => {
      expect(
        resolveSaleJurisdiction({
          path,
          customer: { addresses: [addr({ stateCode: "TX" })] },
          tenant: tenant("CA"),
        }),
      ).toEqual({ state: "TX", basis: "CUSTOMER" });
    },
  );

  it("a store with no usable business state is unresolved (null), never the customer's", () => {
    expect(
      resolveSaleJurisdiction({
        path: "PICKUP",
        customer: { addresses: [addr()] },
        tenant: tenant(null),
      }),
    ).toEqual({ state: null, basis: "STORE" });
    expect(
      resolveSaleJurisdiction({ path: "COUNTER", customer: null, tenant: tenant("not a state") }),
    ).toEqual({ state: null, basis: "STORE" });
  });

  it("the store state is normalised ('tx' and 'Texas' both mean TX)", () => {
    expect(
      resolveSaleJurisdiction({ path: "PICKUP", customer: null, tenant: tenant("tx") }).state,
    ).toBe("TX");
    expect(
      resolveSaleJurisdiction({ path: "PICKUP", customer: null, tenant: tenant("Texas") }).state,
    ).toBe("TX");
  });

  it("the system walk-in is judged at the store on a DELIVERY too (it has no address of its own)", () => {
    expect(
      resolveSaleJurisdiction({
        path: "DELIVERY",
        customer: { isWalkIn: true, addresses: [addr({ stateCode: "TX" })] },
        tenant: tenant("CA"),
      }),
    ).toEqual({ state: "CA", basis: "STORE" });
  });

  it("a delivery with no customer is unresolved on the CUSTOMER basis", () => {
    expect(
      resolveSaleJurisdiction({ path: "DELIVERY", customer: null, tenant: tenant("CA") }),
    ).toEqual({ state: null, basis: "CUSTOMER" });
  });

  describe("reuses the governing-address resolver (a fork would drift)", () => {
    const sets: CustomerAddressFacts[][] = [
      [],
      [addr()],
      [
        addr({ addressType: "BILLING", stateCode: "TX" }),
        addr({ addressType: "SHIPPING", stateCode: "FL" }),
      ],
      [addr({ isDefault: false, stateCode: "TX" }), addr({ isDefault: false, stateCode: "FL" })],
      [addr({ stateCode: null })],
      [addr({ stateNeedsReview: true })],
    ];
    it.each(sets.map((a, i) => [i, a] as const))(
      "address set #%i: DELIVERY and SHIP equal resolveGoverningState under both precedences",
      (_i, addresses) => {
        for (const precedence of ["BILLING_FIRST", "SHIPPING_FIRST"] as const) {
          const expected = resolveGoverningState(addresses, precedence);
          for (const path of ["DELIVERY", "SHIP"] as const) {
            expect(
              resolveSaleJurisdiction({
                path,
                customer: { addresses },
                tenant: tenant("CA", precedence),
              }).state,
            ).toBe(expected.resolved ? expected.state : null);
          }
        }
      },
    );
  });
});

describe("usesStoreState", () => {
  it("is true for COUNTER / POS / PICKUP and for the system walk-in on any path", () => {
    expect(usesStoreState("COUNTER")).toBe(true);
    expect(usesStoreState("POS")).toBe(true);
    expect(usesStoreState("PICKUP")).toBe(true);
    expect(usesStoreState("DELIVERY")).toBe(false);
    expect(usesStoreState("SHIP")).toBe(false);
    expect(usesStoreState("DELIVERY", { isWalkIn: true })).toBe(true);
    expect(usesStoreState("DELIVERY", { isWalkIn: false })).toBe(false);
    expect(usesStoreState("DELIVERY", null)).toBe(false);
  });
});

describe("salePathForOrder", () => {
  it("maps what the order says: counter flag, then the stored fulfil path", () => {
    expect(salePathForOrder({ counterSale: true, fulfillPath: "ROUTE" })).toBe("COUNTER");
    expect(salePathForOrder({ fulfillPath: "PICKUP" })).toBe("PICKUP");
    expect(salePathForOrder({ fulfillPath: "SHIP" })).toBe("SHIP");
    expect(salePathForOrder({ fulfillPath: "ROUTE" })).toBe("DELIVERY");
    expect(salePathForOrder({})).toBe("DELIVERY");
    expect(salePathForOrder({ fulfillPath: null, counterSale: false })).toBe("DELIVERY");
  });
});

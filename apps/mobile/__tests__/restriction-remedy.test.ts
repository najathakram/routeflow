import { customerStateFix, remedyActions } from "../lib/restriction-warning";

/**
 * Row 672 (SA-844): the pure half of the mobile "add a state" action (the same code as web, pinned by
 * apps/web/lib/api/restriction-warning.parity.test.ts): which fix each warned line asks for, and how a customer's
 * governing state is given in place.
 */
const line = (over: Record<string, unknown> = {}) =>
  ({
    lineKey: "n:0",
    productId: "p1",
    displayName: "Acme Gummies",
    outcome: "INDETERMINATE",
    rules: [],
    ...over,
  }) as never;

describe("remedyActions", () => {
  it("one action per customer and one for the store, in line order; lines without a remedy add none", () => {
    expect(
      remedyActions([
        line({ remedy: "ADD_CUSTOMER_STATE", customerId: "c1" }),
        line({ lineKey: "n:1", remedy: "ADD_CUSTOMER_STATE", customerId: "c1" }),
        line({ lineKey: "n:2", outcome: "BLOCK" }),
        line({ lineKey: "n:3", remedy: "ADD_STORE_STATE" }),
        line({ lineKey: "n:4", remedy: "ADD_STORE_STATE" }),
      ]),
    ).toEqual([{ kind: "ADD_CUSTOMER_STATE", customerId: "c1" }, { kind: "ADD_STORE_STATE" }]);
  });

  it("a customer remedy with no customer id offers nothing (there is no one to fix in place)", () => {
    expect(remedyActions([line({ remedy: "ADD_CUSTOMER_STATE" })])).toEqual([]);
  });
});

describe("customerStateFix", () => {
  it("no address: create the minimal default address", () => {
    expect(customerStateFix([])).toEqual({ kind: "create" });
  });
  it("exactly one default: set the state on it", () => {
    expect(
      customerStateFix([
        { id: "a1", isDefault: false },
        { id: "a2", isDefault: true },
      ]),
    ).toEqual({ kind: "setState", addressId: "a2" });
  });
  it("addresses but no single default: choose the default first (never guess)", () => {
    expect(customerStateFix([{ id: "a1" }, { id: "a2", isDefault: false }])).toEqual({
      kind: "chooseDefault",
    });
    expect(
      customerStateFix([
        { id: "a1", isDefault: true },
        { id: "a2", isDefault: true },
      ]),
    ).toEqual({ kind: "chooseDefault" });
  });
});

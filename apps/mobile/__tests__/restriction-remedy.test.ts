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

  it("carries the server-named governing address (SA-924)", () => {
    expect(
      remedyActions([line({ remedy: "ADD_CUSTOMER_STATE", customerId: "c1", addressId: "a1" })]),
    ).toEqual([{ kind: "ADD_CUSTOMER_STATE", customerId: "c1", addressId: "a1" }]);
  });

  it("a customer remedy with no customer id offers nothing (there is no one to fix in place)", () => {
    expect(remedyActions([line({ remedy: "ADD_CUSTOMER_STATE" })])).toEqual([]);
  });
});

describe("customerStateFix (SA-924: the address is the one the engine reads, named by the server)", () => {
  it("no address: create the minimal default address", () => {
    expect(customerStateFix([])).toEqual({ kind: "create" });
  });
  it("the server named the governing address: set the state on it", () => {
    expect(customerStateFix([{ id: "a1" }, { id: "a2" }], "a2")).toEqual({
      kind: "setState",
      addressId: "a2",
    });
  });
  it("one address and no default (the engine reads it): set the state, never 'more than one address'", () => {
    expect(customerStateFix([{ id: "a1" }], "a1")).toEqual({ kind: "setState", addressId: "a1" });
  });
  it("addresses but none named (the engine reads none or several): choose the default first", () => {
    expect(customerStateFix([{ id: "a1" }, { id: "a2" }])).toEqual({ kind: "chooseDefault" });
  });
});

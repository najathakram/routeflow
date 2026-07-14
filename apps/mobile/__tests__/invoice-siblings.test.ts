import { siblingInvoicesOf } from "../lib/invoice-siblings";

describe("siblingInvoicesOf", () => {
  it("current has no invoiceGroupId → []", () => {
    expect(siblingInvoicesOf([{ id: "b", invoiceGroupId: "g1" }], { id: "a" })).toEqual([]);
  });

  it("current undefined → []", () => {
    expect(siblingInvoicesOf([{ id: "b", invoiceGroupId: "g1" }], undefined)).toEqual([]);
  });

  it("excludes the current invoice itself even if present in candidates", () => {
    const current = { id: "a", invoiceGroupId: "g1" };
    const candidates = [current, { id: "b", invoiceGroupId: "g1" }];
    expect(siblingInvoicesOf(candidates, current)).toEqual([{ id: "b", invoiceGroupId: "g1" }]);
  });

  it("excludes candidates with a different (or null) invoiceGroupId", () => {
    const current = { id: "a", invoiceGroupId: "g1" };
    const candidates = [
      { id: "b", invoiceGroupId: "g2" },
      { id: "c", invoiceGroupId: null },
      { id: "d", invoiceGroupId: "g1" },
    ];
    expect(siblingInvoicesOf(candidates, current)).toEqual([{ id: "d", invoiceGroupId: "g1" }]);
  });

  it("preserves candidate order and extra fields (generic passthrough)", () => {
    const current = { id: "a", invoiceGroupId: "g1" };
    const candidates = [
      { id: "d", invoiceGroupId: "g1", invoiceNumber: "INV-2" },
      { id: "e", invoiceGroupId: "g1", invoiceNumber: "INV-3" },
    ];
    expect(siblingInvoicesOf(candidates, current)).toEqual(candidates);
  });
});

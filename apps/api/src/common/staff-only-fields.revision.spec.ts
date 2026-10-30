import { pickCustomerOrderFields, toCustomerOrder } from "./staff-only-fields";

/** Row 380: the buyer edit sends back the revision it loaded, so the customer order carries it. */
describe("customer order revisionNumber (row 380)", () => {
  it("keeps the revision number a buyer edit must send back", () => {
    const out = pickCustomerOrderFields({ id: "o-1", status: "PENDING", revisionNumber: 3 });
    expect(out).toEqual(expect.objectContaining({ id: "o-1", revisionNumber: 3 }));
  });

  it("keeps a revision number of 0 (never edited)", () => {
    expect(toCustomerOrder({ id: "o-1", revisionNumber: 0 })).toEqual(
      expect.objectContaining({ revisionNumber: 0 }),
    );
  });

  it("still drops the revision history itself (staff-only)", () => {
    const out = pickCustomerOrderFields({ id: "o-1", revisionNumber: 1, revisions: [{ id: "r" }] });
    expect(out).not.toHaveProperty("revisions");
  });
});

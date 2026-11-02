import { fillEmptyDates } from "./scan-invoice-tenant-dates";

/** F14 (SA-964 §4): an empty bill or expense date takes the tenant's day; a typed date is never touched. */
describe("fillEmptyDates", () => {
  const day = "2026-10-26"; // the tenant's day; the browser's clock may be a day behind

  it("fills an empty bill date and an empty expense date", () => {
    expect(fillEmptyDates([{ billDate: "", expenseDate: "" }], day)).toEqual([
      { billDate: day, expenseDate: day },
    ]);
  });

  it("keeps a typed date and fills only the empty one", () => {
    expect(fillEmptyDates([{ billDate: "2026-10-01", expenseDate: "" }], day)).toEqual([
      { billDate: "2026-10-01", expenseDate: day },
    ]);
  });

  it("returns the same invoice object when nothing is empty", () => {
    const inv = { billDate: "2026-10-01", expenseDate: "2026-10-02" };
    expect(fillEmptyDates([inv], day)[0]).toBe(inv);
  });
});

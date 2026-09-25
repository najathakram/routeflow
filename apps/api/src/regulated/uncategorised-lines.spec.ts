import { uncategorisedLineWarnings } from "./uncategorised-lines";

/**
 * F-05 (#2093, owner ruling 2026-09-25): custom lines are exempt from the ban check, so this report row is the
 * review list: no-catalog lines on issued invoices sold to customers in a jurisdiction with an active rule.
 */
describe("uncategorisedLineWarnings", () => {
  const range = {
    from: new Date("2026-09-01T00:00:00Z"),
    toExclusive: new Date("2026-10-01T00:00:00Z"),
  };
  const ON = { enabled: true, addressPrecedence: "BILLING_FIRST" as const };
  const addr = (stateCode: string | null, over: object = {}) => ({
    isDefault: true,
    addressType: "BILLING",
    stateCode,
    stateNeedsReview: false,
    ...over,
  });
  const item = (invoiceId: string, addresses: object[], name = "Acme Wholesale") => ({
    invoiceId,
    invoice: { invoiceNumber: `INV-${invoiceId}`, customer: { businessName: name, addresses } },
  });
  const run = (rules: object[], items: object[], policy = ON) => {
    const db = {
      sellingRestriction: { findMany: jest.fn().mockResolvedValue(rules) },
      invoiceItem: { findMany: jest.fn().mockResolvedValue(items) },
    };
    return uncategorisedLineWarnings(db, policy, range).then((w) => ({ w, db }));
  };
  const STATE_CA = { jurisdiction: "STATE", states: ["CA"] };

  it("lists a customer whose governing state a STATE rule names, once per invoice", async () => {
    const { w } = await run(
      [STATE_CA],
      [item("1", [addr("CA")]), item("1", [addr("CA")]), item("2", [addr("NY")])],
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      code: "UNCATEGORISED_LINE_IN_RULE_STATE",
      invoiceId: "1",
      customerName: "Acme Wholesale",
    });
    expect(w[0].message).toContain("in CA");
    expect(w[0].message).toContain("Add the item to the catalog");
  });

  it("a FEDERAL rule lists every customer; an unresolved state is listed (unknown is never safe)", async () => {
    expect(
      (await run([{ jurisdiction: "FEDERAL", states: [] }], [item("2", [addr("NY")])])).w,
    ).toHaveLength(1);
    const unknown = await run(
      [STATE_CA],
      [item("3", []), item("4", [addr("CA", { stateNeedsReview: true })])],
    );
    expect(unknown.w).toHaveLength(2);
    expect(unknown.w[0].message).toContain("in an unknown state");
  });

  it("an unreadable STATE rule blocks everywhere, so it lists everyone", async () => {
    expect(
      (await run([{ jurisdiction: "STATE", states: ["ZZ-junk"] }], [item("2", [addr("NY")])])).w,
    ).toHaveLength(1);
  });

  it("asks only for productless lines on issued (not draft/void) invoices in the range", async () => {
    const { db } = await run([STATE_CA], []);
    const where = db.invoiceItem.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      productId: null,
      invoice: {
        status: { notIn: ["DRAFT", "VOID"] },
        issueDate: { gte: range.from, lt: range.toExclusive },
      },
    });
  });

  it("no active rule, or the engine OFF, reads nothing and lists nothing", async () => {
    const none = await run([], [item("1", [addr("CA")])]);
    expect(none.w).toEqual([]);
    expect(none.db.invoiceItem.findMany).not.toHaveBeenCalled();
    const off = await run([STATE_CA], [item("1", [addr("CA")])], { ...ON, enabled: false });
    expect(off.w).toEqual([]);
    expect(off.db.sellingRestriction.findMany).not.toHaveBeenCalled();
  });
});

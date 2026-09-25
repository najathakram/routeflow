import { uncategorisedLineWarnings } from "./uncategorised-lines";

/**
 * F-05 (#2093, owner ruling 2026-09-25): custom lines are exempt from the ban check, so this report row is the
 * review list: issued invoices with a no-catalog line whose customer sat in a jurisdiction with a rule active
 * WHEN THE INVOICE WAS ISSUED (SA-272), one row per invoice.
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
  const inv = (
    id: string,
    addresses: object[],
    issued = "2026-09-15T12:00:00Z",
    name = "Acme Wholesale",
  ) => ({
    id,
    invoiceNumber: `INV-${id}`,
    issueDate: new Date(issued),
    customer: { businessName: name, addresses },
  });
  const rule = (over: object = {}) => ({
    jurisdiction: "STATE",
    states: ["CA"],
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    liftedAt: null,
    ...over,
  });
  const run = (rules: object[], invoices: object[], policy = ON) => {
    const db = {
      sellingRestriction: { findMany: jest.fn().mockResolvedValue(rules) },
      invoice: { findMany: jest.fn().mockResolvedValue(invoices) },
    };
    return uncategorisedLineWarnings(db, policy, range).then((w) => ({ w, db }));
  };

  it("lists a customer whose governing state a STATE rule names, one row per invoice", async () => {
    const { w } = await run([rule()], [inv("1", [addr("CA")]), inv("2", [addr("NY")])]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      code: "UNCATEGORISED_LINE_IN_RULE_STATE",
      invoiceId: "1",
      customerName: "Acme Wholesale",
    });
    expect(w[0].message).toContain("in CA");
    expect(w[0].message).toContain("Add the item to the catalog");
  });

  it("queries ONE row per invoice (items: some productless), issued and in range; rules overlapping the range", async () => {
    const { db } = await run([rule()], []);
    expect(db.invoice.findMany.mock.calls[0][0].where).toEqual({
      status: { notIn: ["DRAFT", "VOID"] },
      issueDate: { gte: range.from, lt: range.toExclusive },
      items: { some: { productId: null } },
    });
    const where = db.sellingRestriction.findMany.mock.calls[0][0].where;
    expect(where.effectiveFrom).toEqual({ lt: range.toExclusive });
    expect(JSON.stringify(where)).toContain(range.from.toISOString());
  });

  it("rules are judged as of each invoice's ISSUE DATE: a rule lifted Oct 1 still flags September, a later rule does not", async () => {
    const liftedLater = rule({ liftedAt: new Date("2026-10-01T00:00:00Z") });
    expect(
      (await run([liftedLater], [inv("1", [addr("CA")], "2026-09-30T00:00:00Z")])).w,
    ).toHaveLength(1);
    const liftedBefore = rule({ liftedAt: new Date("2026-09-10T00:00:00Z") });
    const both = await run(
      [liftedBefore],
      [
        inv("early", [addr("CA")], "2026-09-05T00:00:00Z"),
        inv("late", [addr("CA")], "2026-09-20T00:00:00Z"),
      ],
    );
    expect(both.w.map((x) => x.invoiceId)).toEqual(["early"]);
    const startsLater = rule({ effectiveFrom: new Date("2026-09-25T00:00:00Z") });
    const notYet = await run([startsLater], [inv("1", [addr("CA")], "2026-09-15T00:00:00Z")]);
    expect(notYet.w).toEqual([]);
  });

  it("a FEDERAL rule, a blank/unreadable STATE rule and an unrecognised jurisdiction each list everyone (fail closed)", async () => {
    const ny = [inv("1", [addr("NY")])];
    expect((await run([rule({ jurisdiction: "FEDERAL", states: [] })], ny)).w).toHaveLength(1);
    expect((await run([rule({ states: [""] })], ny)).w).toHaveLength(1);
    expect((await run([rule({ states: [] })], ny)).w).toHaveLength(1);
    expect((await run([rule({ states: ["ZZ-junk"] })], ny)).w).toHaveLength(1);
    expect((await run([rule({ jurisdiction: "PROVINCE" })], ny)).w).toHaveLength(1);
  });

  it("an unresolved governing state is listed (unknown is never safe)", async () => {
    const { w } = await run(
      [rule()],
      [inv("3", []), inv("4", [addr("CA", { stateNeedsReview: true })])],
    );
    expect(w).toHaveLength(2);
    expect(w[0].message).toContain("in an unknown state");
  });

  it("no overlapping rule, or the engine OFF, reads no invoice and lists nothing", async () => {
    const none = await run([], [inv("1", [addr("CA")])]);
    expect(none.w).toEqual([]);
    expect(none.db.invoice.findMany).not.toHaveBeenCalled();
    const off = await run([rule()], [inv("1", [addr("CA")])], { ...ON, enabled: false });
    expect(off.w).toEqual([]);
    expect(off.db.sellingRestriction.findMany).not.toHaveBeenCalled();
  });
});

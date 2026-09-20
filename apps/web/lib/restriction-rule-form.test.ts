import {
  dayEndToIso,
  dayToIso,
  emptyRuleForm,
  ruleFormSchema,
  toCreateRequest,
  type RuleFormValues,
} from "./restriction-rule-form";

const valid: RuleFormValues = {
  ...emptyRuleForm,
  categoryId: "c1",
  states: ["TX", "FL"],
  reason: "State ban on hemp edibles",
};
const errorsOf = (v: RuleFormValues) => {
  const r = ruleFormSchema.safeParse(v);
  return r.success
    ? {}
    : Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message]));
};

describe("ruleFormSchema (mirrors the API's validation, in plain words)", () => {
  it("accepts a complete category + state rule", () => {
    expect(errorsOf(valid)).toEqual({});
  });

  it("needs the chosen target: a category for CATEGORY, a product for PRODUCT", () => {
    expect(errorsOf({ ...valid, categoryId: "" })).toEqual({ categoryId: "Pick a category" });
    expect(errorsOf({ ...valid, targetKind: "PRODUCT", categoryId: "" })).toEqual({
      productId: "Pick a product",
    });
    expect(errorsOf({ ...valid, targetKind: "PRODUCT", categoryId: "", productId: "p1" })).toEqual(
      {},
    );
  });

  it("a STATE rule needs at least one state; a FEDERAL rule does not", () => {
    expect(errorsOf({ ...valid, states: [] })).toEqual({ states: "Pick at least one state" });
    expect(errorsOf({ ...valid, jurisdiction: "FEDERAL", states: [] })).toEqual({});
  });

  it("requires a reason (whitespace is not one) and caps it at 500", () => {
    expect(errorsOf({ ...valid, reason: "   " })).toEqual({ reason: "Add a reason" });
    expect(errorsOf({ ...valid, reason: "x".repeat(500) })).toEqual({});
    expect(errorsOf({ ...valid, reason: "x".repeat(501) }).reason).toMatch(/under 500/);
  });

  it("a one-day rule (start = end) is valid; an end before the start is refused in words", () => {
    expect(errorsOf({ ...valid, startsOn: "2026-10-10", endsOn: "2026-10-10" })).toEqual({});
    expect(errorsOf({ ...valid, startsOn: "2026-10-10", endsOn: "2026-10-11" })).toEqual({});
    expect(errorsOf({ ...valid, startsOn: "2026-10-10", endsOn: "2026-10-09" })).toEqual({
      endsOn: "The end date can't be before the start date",
    });
    expect(errorsOf({ ...valid, endsOn: "2999-10-11" })).toEqual({});
    expect(errorsOf({ ...valid, startsOn: "2026-10-10" })).toEqual({});
  });

  it("a blank start means now: an end day already past is refused here, today is fine", () => {
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    expect(errorsOf({ ...valid, endsOn: iso(yesterday) })).toEqual({
      endsOn: "The end date has already passed",
    });
    expect(errorsOf({ ...valid, endsOn: iso(today) })).toEqual({});
  });
});

describe("toCreateRequest", () => {
  it("sends only the chosen target and the states of a STATE rule (de-duplicated)", () => {
    expect(toCreateRequest({ ...valid, productId: "stale", states: ["TX", "TX", "FL"] })).toEqual({
      categoryId: "c1",
      jurisdiction: "STATE",
      states: ["TX", "FL"],
      surface: "ALL",
      reason: "State ban on hemp edibles",
    });
    const p = toCreateRequest({
      ...valid,
      targetKind: "PRODUCT",
      productId: "p1",
      categoryId: "stale",
    });
    expect(p.productId).toBe("p1");
    expect(p).not.toHaveProperty("categoryId");
  });

  it("never sends states on a FEDERAL rule, even if some were picked before switching", () => {
    const r = toCreateRequest({ ...valid, jurisdiction: "FEDERAL", states: ["TX"] });
    expect(r.jurisdiction).toBe("FEDERAL");
    expect(r).not.toHaveProperty("states");
  });

  it("omits an empty window (the API defaults to now / open-ended) and sends dates as ISO", () => {
    const open = toCreateRequest(valid);
    expect(open).not.toHaveProperty("effectiveFrom");
    expect(open).not.toHaveProperty("effectiveTo");
    const timed = toCreateRequest({ ...valid, startsOn: "2026-10-10", endsOn: "2026-12-31" });
    // Start is INCLUSIVE at the start of the chosen day; the end is EXCLUSIVE, so "ends Dec 31"
    // goes out as the start of Jan 1 (local), keeping all of Dec 31 in force. Expected instants are
    // built independently of the helpers.
    expect(timed.effectiveFrom).toBe(new Date("2026-10-10T00:00:00").toISOString());
    expect(timed.effectiveTo).toBe(new Date("2027-01-01T00:00:00").toISOString());
  });

  it("the exclusive end handles month and year rollover and a one-day rule", () => {
    expect(dayEndToIso("2026-01-31")).toBe(new Date("2026-02-01T00:00:00").toISOString());
    expect(dayEndToIso("2028-02-28")).toBe(new Date("2028-02-29T00:00:00").toISOString());
    expect(dayEndToIso("2028-02-29")).toBe(new Date("2028-03-01T00:00:00").toISOString());
    const oneDay = toCreateRequest({ ...valid, startsOn: "2026-12-15", endsOn: "2026-12-15" });
    expect(oneDay.effectiveFrom).toBe(new Date("2026-12-15T00:00:00").toISOString());
    expect(oneDay.effectiveTo).toBe(new Date("2026-12-16T00:00:00").toISOString());
  });

  it("trims the reason and sends the channel", () => {
    expect(toCreateRequest({ ...valid, surface: "BUYER_PORTAL", reason: "  law  " })).toMatchObject(
      {
        surface: "BUYER_PORTAL",
        reason: "law",
      },
    );
  });
});

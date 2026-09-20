import {
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

  it("the end must be after the start; an open end or open start is fine", () => {
    const bad = { ...valid, startsOn: "2026-10-10", endsOn: "2026-10-10" };
    expect(errorsOf(bad)).toEqual({ endsOn: "The end date must be after the start date" });
    expect(
      errorsOf({ ...valid, startsOn: "2026-10-10", endsOn: "2026-10-09" }).endsOn,
    ).toBeTruthy();
    expect(errorsOf({ ...valid, startsOn: "2026-10-10", endsOn: "2026-10-11" })).toEqual({});
    expect(errorsOf({ ...valid, endsOn: "2026-10-11" })).toEqual({});
    expect(errorsOf({ ...valid, startsOn: "2026-10-10" })).toEqual({});
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
    expect(timed.effectiveFrom).toBe(dayToIso("2026-10-10"));
    expect(timed.effectiveTo).toBe(dayToIso("2026-12-31"));
    expect(new Date(timed.effectiveTo!).getTime()).toBeGreaterThan(
      new Date(timed.effectiveFrom!).getTime(),
    );
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

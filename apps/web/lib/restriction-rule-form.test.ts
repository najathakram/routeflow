import {
  dayEndToIso,
  dayToIso,
  emptyRuleForm,
  ruleFormSchema,
  ruleSettingsSchema,
  toCreateRequest,
  ruleToFormValues,
  toEditRequest,
  type RuleFormValues,
} from "./restriction-rule-form";

const valid: RuleFormValues = {
  ...emptyRuleForm,
  targets: [{ kind: "CATEGORY", id: "c1", name: "Hemp" }],
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

  it("needs at least one product or label, in any mix", () => {
    expect(errorsOf({ ...valid, targets: [] })).toEqual({
      targets: "Pick at least one product or label",
    });
    expect(
      errorsOf({ ...valid, targets: [{ kind: "PRODUCT", id: "p1", name: "Gummies" }] }),
    ).toEqual({});
    expect(
      errorsOf({
        ...valid,
        targets: [
          { kind: "PRODUCT", id: "p1", name: "Gummies" },
          { kind: "CATEGORY", id: "c1", name: "Hemp" },
        ],
      }),
    ).toEqual({});
  });

  it("caps one rule at the per-rule limit", () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({
      kind: "PRODUCT" as const,
      id: `p${i}`,
      name: `P${i}`,
    }));
    expect(errorsOf({ ...valid, targets: many }).targets).toMatch(/5,000/);
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
  it("sends the picked targets and the states of a STATE rule (de-duplicated)", () => {
    expect(toCreateRequest({ ...valid, states: ["TX", "TX", "FL"] })).toEqual({
      targets: { categoryIds: ["c1"] },
      jurisdiction: "STATE",
      states: ["TX", "FL"],
      surface: "ALL",
      reason: "State ban on hemp edibles",
    });
    const mixed = toCreateRequest({
      ...valid,
      targets: [
        { kind: "PRODUCT", id: "p1", name: "Gummies" },
        { kind: "CATEGORY", id: "c1", name: "Hemp" },
        { kind: "PRODUCT", id: "f1", name: "Sample Pod (all variants)", isFamily: true },
      ],
    });
    expect(mixed.targets).toEqual({ productIds: ["p1", "f1"], categoryIds: ["c1"] });
    // the legacy single-target keys are never sent alongside `targets`
    expect(mixed).not.toHaveProperty("productId");
    expect(mixed).not.toHaveProperty("categoryId");
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

  it("a year below 100 is not remapped to 19xx (end stays one day after the start)", () => {
    expect(new Date(dayEndToIso("0026-12-31")).getFullYear()).toBe(27);
    expect(new Date(dayToIso("0026-12-31")).getFullYear()).toBe(26);
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

describe("editing a rule's settings", () => {
  const rule = {
    jurisdiction: "STATE" as const,
    states: ["TX", "FL"],
    surface: "ALL" as const,
    effectiveFrom: new Date("2026-10-10T00:00:00").toISOString(),
    effectiveTo: new Date("2027-01-01T00:00:00").toISOString(),
    reason: "State ban",
  };

  it("prefills the form from the rule: days in the admin's timezone, the LAST day in force", () => {
    expect(ruleToFormValues(rule)).toMatchObject({
      jurisdiction: "STATE",
      states: ["TX", "FL"],
      surface: "ALL",
      startsOn: "2026-10-10",
      endsOn: "2026-12-31",
      reason: "State ban",
      targets: [],
    });
    expect(ruleToFormValues({ ...rule, effectiveTo: null }).endsOn).toBe("");
  });

  it("an untouched window goes back byte-for-byte (a mid-afternoon API end is not rounded)", () => {
    const afternoon = { ...rule, effectiveTo: "2026-12-31T15:30:00.000Z" };
    const req = toEditRequest(ruleToFormValues(afternoon), afternoon);
    expect(req.effectiveFrom).toBe(afternoon.effectiveFrom);
    expect(req.effectiveTo).toBe("2026-12-31T15:30:00.000Z");
  });

  it("a changed day is converted like create does; a cleared end is an explicit null", () => {
    const v = { ...ruleToFormValues(rule), endsOn: "2027-02-28", startsOn: "2026-11-01" };
    const req = toEditRequest(v, rule);
    expect(req.effectiveFrom).toBe(new Date("2026-11-01T00:00:00").toISOString());
    expect(req.effectiveTo).toBe(new Date("2027-03-01T00:00:00").toISOString());
    expect(toEditRequest({ ...ruleToFormValues(rule), endsOn: "" }, rule).effectiveTo).toBeNull();
  });

  it("never sends states on a federal edit, and trims the reason and note", () => {
    const req = toEditRequest(
      { ...ruleToFormValues(rule), jurisdiction: "FEDERAL", reason: "  law  " },
      rule,
      "  because  ",
    );
    expect(req).not.toHaveProperty("states");
    expect(req).toMatchObject({ jurisdiction: "FEDERAL", reason: "law", note: "because" });
    expect(toEditRequest(ruleToFormValues(rule), rule)).not.toHaveProperty("note");
  });

  it("the settings schema ignores targets (an edit never changes them) but keeps every other rule", () => {
    expect(ruleSettingsSchema.safeParse(ruleToFormValues(rule)).success).toBe(true);
    const bad = ruleSettingsSchema.safeParse({ ...ruleToFormValues(rule), states: [], reason: "" });
    expect(bad.success).toBe(false);
    expect(bad.success ? [] : bad.error.issues.map((i) => i.message).sort()).toEqual([
      "Add a reason",
      "Pick at least one state",
    ]);
  });
});

/**
 * P10-PAR-5 pure-logic guards for the mobile order-templates (standing orders)
 * parity screen. Locks the Active/Paused pill, the action flags, and the
 * ISO-weekday schedule label (guarding the Sunday=7 indexing bug).
 */
import {
  daysLabel,
  orderTemplateActionFlags,
  orderTemplatePillFor,
  unwrapListEnvelope,
  validateTemplateForm,
} from "../lib/order-templates-logic";

describe("orderTemplatePillFor", () => {
  it.each([
    [true, "green", "Active"],
    [false, "gray", "Paused"],
  ] as const)("%s → %s / %s", (isActive, variant, label) => {
    expect(orderTemplatePillFor(isActive)).toEqual({ variant, label });
  });
});

describe("orderTemplateActionFlags", () => {
  it("active → generate + pause, never resume", () => {
    expect(orderTemplateActionFlags(true)).toEqual({
      canGenerate: true,
      canPause: true,
      canActivate: false,
    });
  });
  it("paused → generate + resume, never pause", () => {
    expect(orderTemplateActionFlags(false)).toEqual({
      canGenerate: true,
      canPause: false,
      canActivate: true,
    });
  });
});

describe("daysLabel (ISO 1–7, Mon..Sun)", () => {
  it.each([
    [[1, 3, 5], "Mon, Wed, Fri"],
    [[7], "Sun"], // guards the Sunday=7 → undefined indexing bug
    [[5, 1], "Mon, Fri"], // sorts before rendering
    [[], "No schedule"],
    [undefined, "No schedule"],
  ] as const)("%j → %s", (days, out) => {
    expect(daysLabel(days as number[] | undefined)).toBe(out);
  });
});

describe("unwrapListEnvelope (the {data, meta} staff-list crash guard)", () => {
  it("unwraps the envelope the staff list endpoint actually sends", () => {
    expect(unwrapListEnvelope<{ id: string }>({ data: [{ id: "a" }], meta: { total: 1 } })).toEqual(
      [{ id: "a" }],
    );
  });
  it("passes a bare array through untouched", () => {
    expect(unwrapListEnvelope([1, 2])).toEqual([1, 2]);
  });
  it.each([[null], [undefined], [{}], [{ data: "nope" }], ["junk"]])(
    "degrades %j to an empty list instead of crashing a .filter",
    (payload) => {
      expect(unwrapListEnvelope(payload)).toEqual([]);
    },
  );
});

describe("validateTemplateForm (mirrors web StandingOrderModal rules)", () => {
  const valid = {
    name: "Tuesday staples",
    daysOfWeek: [2],
    items: [{ productId: "p1", qty: 2 }],
  };
  it("accepts the minimal valid form", () => {
    expect(validateTemplateForm(valid)).toBeNull();
  });
  it.each([
    [{ ...valid, name: "  " }, /name/],
    [{ ...valid, daysOfWeek: [] }, /delivery day/],
    [{ ...valid, items: [] }, /at least one product/],
    [{ ...valid, items: [{ productId: "p1", qty: 0 }] }, /quantity of at least 1/],
    [{ ...valid, items: [{ productId: "", qty: 2 }] }, /product/],
  ] as const)("rejects %j", (form, msg) => {
    expect(validateTemplateForm(form as typeof valid)).toMatch(msg);
  });
});

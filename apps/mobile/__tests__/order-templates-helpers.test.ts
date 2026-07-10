/**
 * P10-PAR-5 pure-logic guards for the mobile order-templates (standing orders)
 * parity screen. Locks the Active/Paused pill, the action flags, and the
 * ISO-weekday schedule label (guarding the Sunday=7 indexing bug).
 */
import {
  daysLabel,
  orderTemplateActionFlags,
  orderTemplatePillFor,
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

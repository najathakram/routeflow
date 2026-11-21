/**
 * @jest-environment node
 */
// SA-1203 A11, the static half of the T16 walk's coverage rules: the exemption list is empty and its length
// is pinned (C2, plant W8), the equivalence rule for a focusable element that is not rendered (C1), and the
// reasons that stay red. The browser half runs in the slot (spec 85, plants in spec 96).
import {
  ALLOWED_SKIPS,
  T16_SIZE_ONLY,
  T16_SIZE_ONLY_LENGTH,
  equivalent,
  hrefParts,
  notRenderedProblems,
  otherSkipProblems,
  sizeOnlyLengthOk,
  type FocusInfo,
  type Skip,
} from "../../e2e/helpers/site-colour-walk-pure";

const link = (href: string, el = "a.x"): FocusInfo => ({
  el,
  tag: "a",
  href,
  name: "Sign up",
  target: "||",
});
const button = (name: string, target = "||", el = "button.x"): FocusInfo => ({
  el,
  tag: "button",
  href: null,
  name,
  target,
});
const skipped = (i: FocusInfo, reason = "not-rendered", sizeOnly = false): Skip => ({
  ...i,
  reason,
  sizeOnly,
});

describe("C2: the T16_SIZE_ONLY exemption list starts empty and its length is pinned (plant W8)", () => {
  it("is empty", () => {
    expect(T16_SIZE_ONLY).toHaveLength(0);
    expect(T16_SIZE_ONLY_LENGTH).toBe(0);
    expect(sizeOnlyLengthOk(T16_SIZE_ONLY)).toBe(true);
  });

  it("W8: a list with one added entry turns the length pin red", () => {
    const planted = [
      { page: "/", size: "1440x900", selector: "a.desktop-only", reason: "a desktop-only link" },
    ];
    expect(sizeOnlyLengthOk(planted)).toBe(false);
  });
});

describe("C1: a not-rendered focusable passes only through an equivalent measured element", () => {
  it("links: the same origin and path match; a different path or origin does not", () => {
    expect(equivalent(link("https://a.test/signup"), link("https://a.test/signup"))).toBe(true);
    expect(equivalent(link("https://a.test/signup?x=1"), link("https://a.test/signup"))).toBe(true);
    expect(equivalent(link("https://a.test/signup"), link("https://a.test/login"))).toBe(false);
    expect(equivalent(link("https://a.test/signup"), link("https://b.test/signup"))).toBe(false);
  });

  it("links: the hash counts only when both carry one", () => {
    expect(equivalent(link("https://a.test/p#one"), link("https://a.test/p"))).toBe(true);
    expect(equivalent(link("https://a.test/p"), link("https://a.test/p#one"))).toBe(true);
    expect(equivalent(link("https://a.test/p#one"), link("https://a.test/p#one"))).toBe(true);
    expect(equivalent(link("https://a.test/p#one"), link("https://a.test/p#two"))).toBe(false);
    expect(hrefParts("https://a.test/p#")?.hash).toBe("");
    expect(hrefParts("not a url")).toBeNull();
  });

  it("buttons: the accessible name AND the form / aria-controls / data-track target must match", () => {
    expect(equivalent(button("Menu", "|nav|"), button("Menu", "|nav|"))).toBe(true);
    expect(equivalent(button("Menu", "|nav|"), button("Menu", "|other|"))).toBe(false);
    expect(equivalent(button("Menu", "|nav|"), button("Close", "|nav|"))).toBe(false);
    expect(equivalent(button("", "||"), button("", "||"))).toBe(false);
  });

  it("a link is never equivalent to a button", () => {
    expect(equivalent(link("https://a.test/x"), button("Sign up"))).toBe(false);
  });

  it("W1: the only sign-up not rendered, no equivalent measured, is red with the exact message", () => {
    const r = notRenderedProblems(
      "/ 390x844",
      [skipped(link("https://a.test/signup", "a.btn Sign up"))],
      [link("https://a.test/pricing")],
    );
    expect(r.problems).toEqual([
      "T16 / 390x844: a.btn Sign up not rendered and no equivalent measured",
    ]);
    expect(r.accepted).toBe(0);
  });

  it("W2: the hero sign-up not rendered while the header one is measured is green and counted", () => {
    const r = notRenderedProblems(
      "/ 390x844",
      [skipped(link("https://a.test/signup#hero", "a.hero"))],
      [link("https://a.test/signup", "a.header")],
    );
    expect(r).toEqual({ problems: [], accepted: 1 });
  });

  it("a T16_SIZE_ONLY entry exempts a skip; the exemption is flagged by the walk, never by a run", () => {
    const r = notRenderedProblems(
      "/ 1440x900",
      [skipped(link("https://a.test/x"), "not-rendered", true)],
      [],
    );
    expect(r).toEqual({ problems: [], accepted: 0 });
  });

  it("only not-rendered skips go through the rule; the allowed reasons pass, any other is red", () => {
    expect(ALLOWED_SKIPS).toEqual(["disabled", "inert", "closed-dialog"]);
    const i = button("Go");
    expect(otherSkipProblems("p", [skipped(i, "disabled"), skipped(i, "inert")])).toEqual([]);
    expect(otherSkipProblems("p", [skipped(i, "closed-dialog")])).toEqual([]);
    expect(otherSkipProblems("p", [skipped(i, "unsettled")])).toEqual([
      "T16 p: button.x not measured: unsettled",
    ]);
    expect(otherSkipProblems("p", [skipped(i, "focus-refused")])).toHaveLength(1);
    expect(otherSkipProblems("p", [skipped(i, "anything-new")])).toHaveLength(1);
    expect(otherSkipProblems("p", [skipped(i, "not-rendered")])).toEqual([]);
    expect(notRenderedProblems("p", [skipped(i, "disabled")], []).problems).toEqual([]);
  });
});

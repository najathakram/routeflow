import { limitChipText } from "./portal-limits";

/** The product-page chip names what the rule does: a legal ban (surface ALL) is "Restricted…", a portal limit "Not offered…". */
const CASES: Array<{
  surface: "ALL" | "BUYER_PORTAL";
  jurisdiction: "STATE" | "FEDERAL";
  states: string[];
  text: string;
}> = [
  { surface: "ALL", jurisdiction: "STATE", states: ["tx"], text: "Restricted in TX" },
  {
    surface: "ALL",
    jurisdiction: "STATE",
    states: ["TX", "CA", "NY"],
    text: "Restricted in TX, CA, NY",
  },
  {
    surface: "ALL",
    jurisdiction: "STATE",
    states: ["TX", "CA", "NY", "FL"],
    text: "Restricted in 4 states",
  },
  { surface: "ALL", jurisdiction: "FEDERAL", states: [], text: "Restricted everywhere" },
  { surface: "ALL", jurisdiction: "FEDERAL", states: ["TX"], text: "Restricted everywhere" },
  { surface: "ALL", jurisdiction: "STATE", states: [], text: "Restricted everywhere" },
  { surface: "BUYER_PORTAL", jurisdiction: "STATE", states: ["tx"], text: "Not offered in TX" },
  {
    surface: "BUYER_PORTAL",
    jurisdiction: "STATE",
    states: ["TX", "CA", "NY"],
    text: "Not offered in TX, CA, NY",
  },
  {
    surface: "BUYER_PORTAL",
    jurisdiction: "STATE",
    states: ["TX", "CA", "NY", "FL"],
    text: "Not offered in 4 states",
  },
  {
    surface: "BUYER_PORTAL",
    jurisdiction: "FEDERAL",
    states: [],
    text: "Hidden from all portal customers",
  },
  {
    surface: "BUYER_PORTAL",
    jurisdiction: "STATE",
    states: [],
    text: "Hidden from all portal customers",
  },
];

describe("limitChipText", () => {
  it.each(CASES)("$surface $jurisdiction $states -> $text", ({ text, ...l }) => {
    expect(limitChipText(l)).toBe(text);
  });
});

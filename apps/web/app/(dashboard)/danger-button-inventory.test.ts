import * as fs from "fs";
import * as path from "path";

/**
 * UX guide improvement 6 (class pin, shrink-only): a destructive button on the page itself is a red
 * OUTLINE (`danger-outline`); only the confirm button inside a dialog is solid `danger`. This counts
 * the solid `variant="danger"` uses per file (Badges excluded) and pins each to the number of
 * dialog confirms, so a new solid red page button fails here. Lower a count when a dialog is removed;
 * never raise one to admit a page-level button.
 */
const DIR = __dirname;
const PINS: Array<[file: string, dialogConfirms: number, which: string]> = [
  [
    "customers/[id]/page.tsx",
    7,
    'delete price override, suspend/deactivate (:4021, ternary form: variant={x ? "danger" : "secondary"}, the dialog confirm), delete standing order, delete contact, decline request, delete customer, disconnect portal',
  ],
  ["credit-notes/[id]/page.tsx", 0, "none"],
  ["estimates/[id]/page.tsx", 1, "the void dialog's own confirm"],
  ["finance/commissions/[id]/page.tsx", 1, "void statement dialog"],
  ["returns/[id]/page.tsx", 2, "reject return, cancel return"],
];

// Catches variant="danger", variant={"danger"} and a ternary such as variant={x ? "danger" : "secondary"}
// (one line each; a Badge's variant is a colour, not a button).
const DANGER = /variant=(?:"danger"|\{[^}]*"danger"[^}]*\})/;
const matches = (src: string) =>
  src.split(/\r?\n/).filter((line) => DANGER.test(line) && !line.includes("<Badge"));
const solidDanger = (src: string) => matches(src).length;

describe("solid red buttons are dialog confirms only", () => {
  it.each(PINS)("%s", (file, expected) => {
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    expect(solidDanger(src)).toBe(expected);
  });
});

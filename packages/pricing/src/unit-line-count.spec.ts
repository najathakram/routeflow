import { unitLineCount } from "./unit-line-count";

/**
 * #2276 / SA-388: the ONE count rule for a stored unit line, shared by web (orders/[id]) and mobile
 * (edit-items-draft, buyer edit-items). Fixtures are SERVER-SHAPED: `qty` is base pieces
 * (count x unitsPerBox), `boxes` is the count when the server wrote one, `unitsPerBox` is the line's
 * snapshot factor. `null` = LOCKED (no safe count; the caller refuses edits, never guesses).
 */
describe("unitLineCount (SA-388, #2276)", () => {
  it.each([
    // boxes is the count when it is a positive integer
    ["boxes 3 of 12", { qty: 36, boxes: 3, unitsPerBox: 12 }, 3],
    ["boxes wins over qty", { qty: 99, boxes: 3, unitsPerBox: 12 }, 3],
    // else qty / factor when qty is a positive whole multiple of an integer factor >= 1
    ["boxes 0, qty 36 of 12", { qty: 36, boxes: 0, unitsPerBox: 12 }, 3],
    ["boxes null, qty 36 of 12", { qty: 36, boxes: null, unitsPerBox: 12 }, 3],
    ['"Each" factor 1', { qty: 4, boxes: null, unitsPerBox: 1 }, 4],
    [
      "a fractional boxes falls through to qty / factor",
      { qty: 36, boxes: 2.5, unitsPerBox: 12 },
      3,
    ],
    ["a negative boxes falls through to qty / factor", { qty: 36, boxes: -3, unitsPerBox: 12 }, 3],
    ["Decimal-as-string values (web JSON)", { qty: "36", boxes: "0", unitsPerBox: "12" }, 3],
    // LOCKED
    ["qty not a whole multiple", { qty: 40, boxes: 0, unitsPerBox: 12 }, null],
    ["qty 0", { qty: 0, boxes: 0, unitsPerBox: 12 }, null],
    ["qty 0, boxes null", { qty: 0, boxes: null, unitsPerBox: 12 }, null],
    ["a negative qty", { qty: -24, boxes: null, unitsPerBox: 12 }, null],
    ["a fractional qty", { qty: 36.5, boxes: null, unitsPerBox: 1 }, null],
    ["a fractional factor", { qty: 36, boxes: null, unitsPerBox: 1.5 }, null],
    ["a negative factor", { qty: 36, boxes: null, unitsPerBox: -12 }, null],
    ["a zero factor", { qty: 36, boxes: null, unitsPerBox: 0 }, null],
    ["no factor", { qty: 36, boxes: null, unitsPerBox: null }, null],
    ["no factor field at all", { qty: 36 }, null],
    ["a non-numeric factor", { qty: 36, boxes: null, unitsPerBox: "abc" }, null],
  ] as const)("%s", (_label, line, expected) => {
    expect(unitLineCount(line)).toBe(expected);
  });
});

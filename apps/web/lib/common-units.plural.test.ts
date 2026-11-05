import { plural } from "@routeflow/pricing";
import { COMMON_UNITS } from "./common-units";

/**
 * Class pin for unit words: every entry the product unit fields suggest must plural-ise the way a person
 * would say it ("6 each", never "6 eaches"). A new common unit with an odd plural fails here, not on a
 * live-stock note.
 */
const EXPECTED_PLURAL: Record<string, string> = {
  each: "each",
  unit: "units",
  pcs: "pcs",
  case: "cases",
  box: "boxes",
  bag: "bags",
  pack: "packs",
  dozen: "dozen",
  bundle: "bundles",
  tray: "trays",
  pallet: "pallets",
  kg: "kg",
  g: "g",
  lb: "lb",
  oz: "oz",
  L: "L",
  ml: "ml",
  liter: "liters",
  roll: "rolls",
  sheet: "sheets",
  bottle: "bottles",
  can: "cans",
  strip: "strips",
};

describe("COMMON_UNITS plurals", () => {
  it("every common unit has a pinned plural (a new unit needs a row here)", () => {
    expect([...COMMON_UNITS].sort()).toEqual(Object.keys(EXPECTED_PLURAL).sort());
  });

  it.each(Object.entries(EXPECTED_PLURAL))("%s reads %s for 6", (unit, many) => {
    expect(plural(unit, 6)).toBe(many);
    expect(plural(unit, 1)).toBe(unit);
  });
});

/** Row 556 / SA-970 §2.2 - every add-on change source is classified, with a reason. */
import {
  ADDON_SOURCE_CLASS,
  ADDON_SOURCE_REASON,
  classOfSource,
} from "./addon-change-source-class";
import { ADDON_CHANGE_SOURCES } from "./tenant-addon-writer";

describe("addon change source classification", () => {
  it("classifies exactly the closed source list (a source added without a class fails here and in tsc)", () => {
    expect(Object.keys(ADDON_SOURCE_CLASS).sort()).toEqual([...ADDON_CHANGE_SOURCES].sort());
    expect(Object.keys(ADDON_SOURCE_REASON).sort()).toEqual([...ADDON_CHANGE_SOURCES].sort());
  });

  it.each([...ADDON_CHANGE_SOURCES])("%s has a valid class and a one-line reason", (s) => {
    expect(["owner", "expected_system", "alert"]).toContain(ADDON_SOURCE_CLASS[s]);
    expect(ADDON_SOURCE_REASON[s].trim().length).toBeGreaterThan(10);
    expect(ADDON_SOURCE_REASON[s]).not.toContain("\n");
  });

  it("a source the map does not know is alert", () => {
    expect(classOfSource("brand.new")).toBe("alert");
    expect(classOfSource(undefined)).toBe("alert");
  });
});

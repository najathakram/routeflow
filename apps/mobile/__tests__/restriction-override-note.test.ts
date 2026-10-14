import { FORMER_USER, restrictionOverrideLine } from "../lib/restriction-override-note";

/** Row 510: the staff-only "Sold despite restriction" line (mobile twin of web's restriction-override-note.ts). */
describe("restrictionOverrideLine", () => {
  it("reads 'Sold despite restriction · reason · by name · date'", () => {
    expect(
      restrictionOverrideLine({
        reason: "Owner approved",
        name: "pat",
        at: "2026-10-07T15:14:00.000Z",
      }),
    ).toBe("Sold despite restriction · Owner approved · by pat · Oct 7, 2026");
  });
  it("falls back to 'former user' when the name can't be resolved", () => {
    expect(restrictionOverrideLine({ reason: "Owner approved", name: null, at: null })).toBe(
      "Sold despite restriction · Owner approved · by former user",
    );
    expect(FORMER_USER).toBe("former user");
  });
  it("leaves the 'by' part out while the name is still resolving", () => {
    expect(restrictionOverrideLine({ reason: "Owner approved", name: undefined, at: null })).toBe(
      "Sold despite restriction · Owner approved",
    );
  });
});

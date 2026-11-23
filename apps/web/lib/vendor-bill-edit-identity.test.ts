import { readFileSync } from "fs";
import { join } from "path";
import { billLineLocked, billLineUnit } from "@routeflow/pricing";

/**
 * SA-1207 S2b spec 6: the bill edit echoes each stored line's id (the server pairs rows by it and carries a
 * lot's label and family from the stored row), and reads a line's unit through `billLineUnit` only.
 */
const page = readFileSync(
  join(__dirname, "..", "app", "(dashboard)", "vendor-bills", "[id]", "page.tsx"),
  "utf8",
);

describe("bill edit page: line identity and unit", () => {
  it("seeds each row with the stored id, label and lock, and sends the id back on save", () => {
    expect(page).toContain("id: item.id,");
    expect(page).toContain("unitLabel: item.unitLabel ?? null,");
    expect(page).toContain("locked: billLineLocked(item),");
    expect(page).toContain("...(row.id ? { id: row.id } : {}),");
  });

  it("never reads packSize as 'above 1 means a case' on a stored line", () => {
    expect(page).not.toMatch(/\(item\.packSize \?\? 0\) > 1/);
    expect(page).not.toMatch(/parseInt\(row\.packSize, 10\) > 1/);
  });

  it("a lot seeds as a locked row of its own pack, not a catalog case", () => {
    const lot = { packSize: 7, unitLabel: "7 Pieces", familyGroupId: "g" };
    expect(billLineLocked(lot)).toBe(true);
    expect(billLineUnit(lot)).toMatchObject({ kind: "lot", factor: 7 });
  });
});

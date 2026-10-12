import { readFileSync } from "fs";
import { join } from "path";

/** Row 372 (web half): the edit save sends the revision it loaded, and a stale 409 reaches the notice, not a toast. */
const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
const api = readFileSync(join(__dirname, "../../../../lib/api/orders.ts"), "utf8");

describe("order edit sends expectedRevisionNumber (row 372)", () => {
  it("handleSaveItems sends the revision the editor loaded", () => {
    expect(page).toContain("expectedRevisionNumber: stale.expected()");
  });
  it("a stale 409 is captured by the notice and owns the toast", () => {
    expect(page).toContain("stale.capture(err)");
    expect(page).toContain("stale.ownsToast(e)");
    expect(page).toContain("{stale.node}");
  });
  it("the mutation puts the field on the PATCH body", () => {
    expect(api).toMatch(
      /\.patch<Order>\(`\/orders\/\$\{id\}\/items`, \{[^}]*expectedRevisionNumber/,
    );
  });
});

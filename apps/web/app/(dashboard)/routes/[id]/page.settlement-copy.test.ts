import * as fs from "fs";
import * as path from "path";

/**
 * Review-a on #4188, two pins on the office run page (a source read, as the D-15 pin does: the page has no render test).
 *
 * 1. The Amend sheet says what Amend does. SA-1098 A-6 ruled the old count is KEPT: `settleRun` puts the whole old note
 *    under "Earlier count:", so the sheet's sentence is true as written (this row and the DB row SE-8b move together).
 * 2. Cancel and Finish both show their own refusal, so their hook runs with `localErrorToast` and a refusal raises ONE toast.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("office run page: settlement copy and one toast", () => {
  it("the Amend sheet says the old count stays in the note, and never that the new count replaces it", () => {
    expect(src).toContain("The old count stays in the note.");
    expect(src).not.toMatch(/replaces the old/i);
  });

  it("the run-status hook behind Cancel and Finish keeps the app-wide toast off", () => {
    expect(src).toMatch(/useUpdateRouteRunStatus\(\{\s*localErrorToast: true,?\s*\}\)/);
  });
});

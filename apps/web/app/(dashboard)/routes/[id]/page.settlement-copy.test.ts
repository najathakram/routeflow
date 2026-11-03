import * as fs from "fs";
import * as path from "path";

/**
 * Review-a on #4188, two pins on the office run page (a source read, as the D-15 pin does: the page has no render test).
 *
 * 1. The Amend sheet says what Amend does. `settleRun` REPLACES the whole note, so the old count is not kept anywhere;
 *    the sheet must not promise it is. (If the SA rules the old count is kept in the note, this row and SE-8 flip together.)
 * 2. Cancel and Finish both show their own refusal, so their hook runs with `localErrorToast` and a refusal raises ONE toast.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("office run page: settlement copy and one toast", () => {
  it("the Amend sheet says the new count replaces the old one, and never that the old one stays", () => {
    expect(src).toContain("The new count replaces the old one.");
    expect(src).not.toMatch(/old count stays/i);
  });

  it("the run-status hook behind Cancel and Finish keeps the app-wide toast off", () => {
    expect(src).toMatch(/useUpdateRouteRunStatus\(\{\s*localErrorToast: true,?\s*\}\)/);
  });
});

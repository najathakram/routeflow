import { readFileSync } from "fs";
import { join } from "path";
import { REOPEN_CONFIRM_TEXT, statusAfterReopen } from "./order-reopen";

/** SA-1136 O1-13: the page shows the status the server answered, and the confirm names both outcomes. */
describe("order reopen (web)", () => {
  it("shows the server's status after a reopen, DRAFT included", () => {
    expect(statusAfterReopen({ status: "DRAFT" })).toBe("DRAFT");
    expect(statusAfterReopen({ status: "PENDING" })).toBe("PENDING");
  });

  it("the confirm says a cancelled draft comes back as a draft and any other order as Pending", () => {
    expect(REOPEN_CONFIRM_TEXT).toBe(
      "Reopen this order? A cancelled draft comes back as a draft. Any other order comes back as Pending.",
    );
  });

  it("the page uses both, and no longer hardcodes PENDING or the old copy for the reopen", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toContain("confirm(REOPEN_CONFIRM_TEXT)");
    expect(src).toContain("setLocalStatus(statusAfterReopen(reopened))");
    expect(src).not.toContain("It will return to Pending status");
    expect(src).not.toMatch(/reopenOrder\.mutate[\s\S]{0,200}setLocalStatus\("PENDING"\)/);
  });
});

import * as fs from "fs";
import * as path from "path";
import { staffChannelJudged } from "./staff-channel";

/** SA cross-row ruling: the staff-channel question has ONE answer, and the edit code asks only it. */
describe("staffChannelJudged", () => {
  it("follows the tenant switch today", () => {
    expect(staffChannelJudged({ enabled: true, addressPrecedence: "BILLING_FIRST" })).toBe(true);
    expect(staffChannelJudged({ enabled: false, addressPrecedence: "BILLING_FIRST" })).toBe(false);
  });

  it("the edit service never reads the switch any other way", () => {
    const src = fs.readFileSync(path.join(__dirname, "rule-edit.service.ts"), "utf8");
    expect(src).toMatch(/staffChannelJudged\(policy\)/);
    expect(src).not.toMatch(/restrictionsApply\(|\.enabled\b/);
  });
});

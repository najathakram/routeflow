import * as fs from "fs";
import * as path from "path";

/**
 * Row 510: the client logic (parse the 409, validate the ONE reason, build the per-line ack, the fixed dialog copy) exists
 * once per app because a mobile screen cannot import the web app and this row adds no shared-package file. The two files
 * must stay the SAME text below their header comment, so the web dialog and the mobile modal can never disagree.
 */
const body = (file: string) => {
  const src = fs.readFileSync(file, "utf8");
  return src.slice(src.indexOf("import {"));
};

/**
 * KNOWN DIVERGENCE (SA-961, owner 10-24 no-native-work rule): W-806 removed the "Legal ban" badge copy and the
 * `ruleText` fallback sentence from the WEB helper only, and reworded the `lineRuleRows` doc comment (SA-961). The mobile helper keeps both, unchanged, until native work
 * resumes (the server's reasonText already reaches old phones). Both are masked below; every other byte must still
 * match. Delete this mask when the mobile helper catches up.
 */
const withoutKnownDivergence = (text: string) =>
  text
    .replace(/ {2}legalBadge: "Legal ban",\n/, "")
    .replace(/\/\*\*\n \* The rule lines to DISPLAY[\s\S]*?\*\/\n/, "<lineRuleRows doc>\n")
    .replace(
      /\/\*\* One rule's sentence[\s\S]*?\nexport function ruleText[\s\S]*?\n}\n/,
      "<ruleText>\n",
    );

describe("web and mobile restriction-warning helpers are the same code", () => {
  it("apps/web/lib/api/restriction-warning.ts === apps/mobile/lib/restriction-warning.ts below the header", () => {
    const web = path.resolve(__dirname, "restriction-warning.ts");
    const mobile = path.resolve(__dirname, "../../../mobile/lib/restriction-warning.ts");
    expect(body(web).length).toBeGreaterThan(1500);
    expect(withoutKnownDivergence(body(mobile))).toBe(withoutKnownDivergence(body(web)));
  });
});

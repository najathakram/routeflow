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

describe("web and mobile restriction-warning helpers are the same code", () => {
  it("apps/web/lib/api/restriction-warning.ts === apps/mobile/lib/restriction-warning.ts below the header", () => {
    const web = path.resolve(__dirname, "restriction-warning.ts");
    const mobile = path.resolve(__dirname, "../../../mobile/lib/restriction-warning.ts");
    expect(body(web).length).toBeGreaterThan(1500);
    expect(body(mobile)).toBe(body(web));
  });
});

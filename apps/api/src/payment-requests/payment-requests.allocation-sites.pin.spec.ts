/**
 * SA-1148 case 13: every allocation of a buyer payment goes through the ONE allocator, `buildAllocation`, whose
 * `firstInvoiceId` parameter is required, and the call sites are count-pinned (a sixth site is a reviewed change).
 */
import * as fs from "fs";
import * as path from "path";

const src = fs.readFileSync(path.join(__dirname, "payment-requests.service.ts"), "utf8");
const code = src
  .split("\n")
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/**");
  })
  .join("\n");

describe("buyer payment allocation sites (SA-1148)", () => {
  it("the old oldest-first allocator name is gone", () => {
    expect(code.includes("buildOldestFirstAllocation")).toBe(false);
  });

  it("firstInvoiceId is a required parameter of buildAllocation", () => {
    expect(code.includes("firstInvoiceId: string | null)")).toBe(true);
    expect(code.includes("firstInvoiceId?")).toBe(false);
  });

  it("exactly five call sites call buildAllocation (preview, card cap, operator preview, approve, card settle)", () => {
    expect(code.split("this.buildAllocation(").length - 1).toBe(5);
  });
});

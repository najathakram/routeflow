/**
 * #2404 (P0, epic #2400): `CreditNote.invoiceId` is the invoice a credit was ISSUED AGAINST (set
 * once at creation from the request) — where it is APPLIED lives in InvoicePayment. The detail
 * page called the origin "Applied to Invoice" and the list's "Applied To" column fell back to
 * "next invoice (auto)", which is wrong now that auto-apply is off by default (SA-436).
 */
import { readFileSync } from "fs";
import { join } from "path";

const detail = readFileSync(join(__dirname, "[id]", "page.tsx"), "utf8");
const list = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("credit-note origin labels (#2404)", () => {
  it("the detail page labels cn.invoiceId as the invoice it was issued against", () => {
    expect(detail).not.toMatch(/Applied to Invoice/);
    expect(detail).toMatch(/Issued against invoice:/);
  });

  it("the list column is 'Issued against' and has no auto-apply promise", () => {
    expect(list).not.toMatch(/>\s*Applied To\s*</);
    expect(list).toMatch(/>\s*Issued against\s*</);
    expect(list).not.toMatch(/next invoice \(auto\)/);
  });
});

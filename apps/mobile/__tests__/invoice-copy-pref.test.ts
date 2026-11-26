/**
 * W-1443 (SA-1516) mobile: the invoice-copy switch is OPT-IN (absent = off), written under
 * PREF.invoiceEmailCopy as the strings "true" / "false". Pure logic plus a source pin that the operator
 * settings screen binds the switch through this module.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { PREF } from "@routeflow/types";
import { invoiceCopyFromPrefs, invoiceCopyPatch } from "../lib/invoice-copy-pref";
import { withCopyNote } from "../lib/invoice-send-logic";

describe("invoice copy preference (W-1443)", () => {
  it("reads an absent preference as OFF (opt-in), not on", () => {
    expect(invoiceCopyFromPrefs({})).toBe(false);
    expect(invoiceCopyFromPrefs(null)).toBe(false);
    expect(invoiceCopyFromPrefs(undefined)).toBe(false);
  });

  it('is on only for the exact value "true"', () => {
    expect(invoiceCopyFromPrefs({ [PREF.invoiceEmailCopy]: "true" })).toBe(true);
    expect(invoiceCopyFromPrefs({ [PREF.invoiceEmailCopy]: "false" })).toBe(false);
    expect(invoiceCopyFromPrefs({ [PREF.invoiceEmailCopy]: "TRUE" })).toBe(false);
  });

  it('writes "true" / "false" under PREF.invoiceEmailCopy and nothing else', () => {
    expect(invoiceCopyPatch(true)).toEqual({ invoiceEmailCopy: "true" });
    expect(invoiceCopyPatch(false)).toEqual({ invoiceEmailCopy: "false" });
    expect(PREF.invoiceEmailCopy).toBe("invoiceEmailCopy");
  });

  it("the operator settings screen binds the switch through the module, with the web wording", () => {
    const src = readFileSync(
      join(__dirname, "..", "app", "(operator)", "settings", "index.tsx"),
      "utf8",
    );
    expect(src).toMatch(/notification-prefs/);
    expect(src).toMatch(/getInvoiceCopyEnabled/);
    expect(src).toMatch(/setInvoiceCopyEnabled/);
    expect(src).toContain("Send me a copy of invoices I email");
    expect(src).toMatch(/The customer\s+does not see it\./);
  });
});

describe("send toast copy note (W-1443)", () => {
  it("adds the line only when the api reports copiedTo", () => {
    expect(withCopyNote("Invoice emailed", { success: true })).toBe("Invoice emailed");
    expect(withCopyNote("Invoice emailed", { copiedTo: "ops@acme.test" })).toBe(
      "Invoice emailed. A copy went to you.",
    );
  });
  it('reads "TRUE", "1" and a missing value as off', () => {
    expect(invoiceCopyFromPrefs({ [PREF.invoiceEmailCopy]: "TRUE" })).toBe(false);
    expect(invoiceCopyFromPrefs({ [PREF.invoiceEmailCopy]: "1" })).toBe(false);
    expect(invoiceCopyFromPrefs({})).toBe(false);
  });
});

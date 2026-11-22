import { INVOICE_ACCOUNT_LABELS } from "@routeflow/types";
import { readFileSync } from "fs";
import { join } from "path";
import { INVOICE_ACCOUNT_LABELS_API } from "./invoice-account-balance";

/**
 * SA-1197 C12: the one label map lives in packages/types/api/invoice-account.ts; the api may not load a runtime value
 * from @routeflow/types (no-runtime-types-import.spec.ts), so it keeps INVOICE_ACCOUNT_LABELS_API. The two are equal key
 * for key and word for word, so the owner's answer on the words is one edit in each, pinned here.
 */
describe("invoice account labels: the api mirror equals the shared map (C12)", () => {
  it("same keys, same words", () => {
    expect(INVOICE_ACCOUNT_LABELS_API).toEqual(INVOICE_ACCOUNT_LABELS);
  });

  it("T15: no label carries Total, Amount due or a second Balance due (owner 10-24, W-884)", () => {
    for (const label of Object.values(INVOICE_ACCOUNT_LABELS)) {
      expect(label).not.toMatch(/total|amount due|balance due/i);
    }
  });

  it("SA-1209 D3: the two dated forms carry the {asOf} slot; the others carry none", () => {
    expect(INVOICE_ACCOUNT_LABELS.heading).toBe("Customer account balance as of {asOf}");
    expect(INVOICE_ACCOUNT_LABELS.openBalanceOn).toBe("Open balance on {asOf}");
    for (const k of ["others", "thisInvoice", "openBalance"] as const) {
      expect(INVOICE_ACCOUNT_LABELS[k]).not.toContain("{asOf}");
    }
    for (const label of Object.values(INVOICE_ACCOUNT_LABELS)) {
      expect(label).not.toContain("{date}");
    }
  });
});

/**
 * SA-1209 D3: the block's time and the PDF's "Generated" stamp print through the ONE formatter, asOfText
 * (packages/pricing/src/as-of-text.ts). No second date-and-time formatter in either file.
 */
describe("the account block and the PDF stamp share asOfText (SA-1209 D3)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

  it("the block builder calls asOfText and keeps no date helper of its own", () => {
    const src = read("customers/invoice-account-balance.ts");
    expect(src).toMatch(/asOfText\(\s*result\.asOfAt\s*,\s*result\.zone\s*\)/);
    expect(src).not.toMatch(/accountAsOfText|withDate|toLocale/);
  });

  it("the PDF template stamps Generated through asOfText in the tenant's zone, never the server's", () => {
    const src = read("invoices/invoice-pdf-template.tsx");
    expect(src).toMatch(/Generated \{asOfText\(generatedAt,\s*invoice\.tenantZone/);
    expect(src).not.toMatch(/fmtDateTime|toLocaleString/);
  });
});

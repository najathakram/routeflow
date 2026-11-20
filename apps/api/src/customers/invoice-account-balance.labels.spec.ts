import { INVOICE_ACCOUNT_LABELS } from "@routeflow/types";
import { readFileSync } from "fs";
import { join } from "path";
import { INVOICE_ACCOUNT_LABELS_API, accountAsOfText } from "./invoice-account-balance";

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

  it("the two dated forms carry the {date} slot; the others carry none", () => {
    expect(INVOICE_ACCOUNT_LABELS.heading).toContain("{date}");
    expect(INVOICE_ACCOUNT_LABELS.openBalanceOn).toContain("{date}");
    for (const k of ["others", "thisInvoice", "openBalance"] as const) {
      expect(INVOICE_ACCOUNT_LABELS[k]).not.toContain("{date}");
    }
  });
});

/**
 * SA-1197 A1-3: the block's as-of date and the PDF's other dates print in one style. The template is stubbed globally
 * under Jest, so fmtDate cannot be called here; the house pattern is a source pin. Both build the date with the same
 * toLocaleDateString locale and options, so a change to either one goes red here.
 */
describe("the as-of date matches the PDF's fmtDate (A1-3)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  const dateCall = (src: string, startMarker: string) => {
    const at = src.indexOf(startMarker);
    expect(at).toBeGreaterThan(-1);
    const m = /toLocaleDateString\(([\s\S]*?)\);/.exec(src.slice(at));
    expect(m).not.toBeNull();
    return (m as RegExpExecArray)[1].replace(/\s+/g, "").replace(/,(?=[}\]])/g, "");
  };

  it("accountAsOfText and fmtDate pass the same locale and options", () => {
    const leaf = dateCall(
      read("customers/invoice-account-balance.ts"),
      "export function accountAsOfText(",
    );
    const pdf = dateCall(read("invoices/invoice-pdf-template.tsx"), "const fmtDate = (");
    expect(leaf).toBe(pdf);
    expect(leaf).toContain('timeZone:"UTC"');
  });

  it("prints the documents' style", () => {
    expect(accountAsOfText("2026-11-20")).toBe("Nov 20, 2026");
    expect(accountAsOfText("2026-01-05")).toBe("Jan 5, 2026");
  });
});

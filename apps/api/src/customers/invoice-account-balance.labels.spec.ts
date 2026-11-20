import { INVOICE_ACCOUNT_LABELS } from "@routeflow/types";
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

  it("the two dated forms carry the {date} slot; the others carry none", () => {
    expect(INVOICE_ACCOUNT_LABELS.heading).toContain("{date}");
    expect(INVOICE_ACCOUNT_LABELS.openBalanceOn).toContain("{date}");
    for (const k of ["others", "thisInvoice", "openBalance"] as const) {
      expect(INVOICE_ACCOUNT_LABELS[k]).not.toContain("{date}");
    }
  });
});

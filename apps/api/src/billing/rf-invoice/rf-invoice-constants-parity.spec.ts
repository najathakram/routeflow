// The API may not value-import @routeflow/types (no-runtime-workspace-imports.spec.ts), so the
// RfInvoice constants are mirrored in ./rf-invoice.constants.ts. This pins the mirror to the shared
// package, and the audit codes to the admin audit registry. A spec may require the package freely.
import * as shared from "@routeflow/types";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ACTION_LABELS,
} from "../../platform-admin/audit-actions.constant";
import {
  RF_INVOICE_AUDIT_ACTIONS,
  RF_INVOICE_LINE_KINDS,
  RF_INVOICE_STATUS_VALUES,
  RF_INVOICE_VIEW_VALUES,
} from "./rf-invoice.constants";

describe("rf-invoice constants parity", () => {
  const s = shared as unknown as Record<string, readonly string[]>;

  it("status values match packages/types (OPEN | PAID | VOID; legacy FAILED is never written)", () => {
    expect([...RF_INVOICE_STATUS_VALUES]).toEqual(s.RF_INVOICE_STATUS_VALUES);
    expect([...RF_INVOICE_STATUS_VALUES]).toEqual(["OPEN", "PAID", "VOID"]);
  });

  it("view values match packages/types", () => {
    expect([...RF_INVOICE_VIEW_VALUES]).toEqual(s.RF_INVOICE_VIEW_VALUES);
    expect([...RF_INVOICE_VIEW_VALUES]).toEqual([
      "overdue",
      "due_soon",
      "open",
      "paid",
      "void",
      "all",
    ]);
  });

  it("line kinds match packages/types", () => {
    expect([...RF_INVOICE_LINE_KINDS]).toEqual(s.RF_INVOICE_LINE_KINDS);
  });

  it("issue / needs-price audit codes are registered with their exact labels", () => {
    expect(RF_INVOICE_AUDIT_ACTIONS.ISSUED).toBe("RF_INVOICE_ISSUED");
    expect(RF_INVOICE_AUDIT_ACTIONS.NEEDS_PRICE).toBe("RF_INVOICE_NEEDS_PRICE");
    expect(RF_INVOICE_AUDIT_ACTIONS.STALE_PERIOD).toBe("RF_INVOICE_STALE_PERIOD");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_STALE_PERIOD).toBe(
      "RouteFlow invoice not issued (stale period)",
    );
    expect(RF_INVOICE_AUDIT_ACTIONS.IRREGULAR_PERIOD).toBe("RF_INVOICE_IRREGULAR_PERIOD");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_IRREGULAR_PERIOD).toBe(
      "RouteFlow invoice needs review (irregular period)",
    );
    expect(AdminAuditAction.RF_INVOICE_ISSUED).toBe("RF_INVOICE_ISSUED");
    expect(AdminAuditAction.RF_INVOICE_NEEDS_PRICE).toBe("RF_INVOICE_NEEDS_PRICE");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_ISSUED).toBe("RouteFlow invoice issued");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_NEEDS_PRICE).toBe(
      "RouteFlow invoice not issued (no price)",
    );
  });
});

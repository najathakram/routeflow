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
  RF_INVOICE_SEND_COOLDOWN_MS,
  RF_INVOICE_SEND_MAX_IDS,
  RF_INVOICE_SEND_OUTCOME_VALUES,
  RF_INVOICE_SEND_TRIGGERS,
  RF_INVOICE_STATUS_VALUES,
  RF_INVOICE_VIEW_VALUES,
  rfInvoiceTestTenantSlugs,
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

  it("PR2 lifecycle audit codes are registered with their labels", () => {
    expect(AdminAuditAction.RF_INVOICE_MARKED_PAID).toBe("RF_INVOICE_MARKED_PAID");
    expect(AdminAuditAction.RF_INVOICE_REOPENED).toBe("RF_INVOICE_REOPENED");
    expect(AdminAuditAction.RF_INVOICE_VOIDED).toBe("RF_INVOICE_VOIDED");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_MARKED_PAID).toBe("RouteFlow invoice marked paid");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_REOPENED).toBe("RouteFlow invoice reopened");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_VOIDED).toBe("RouteFlow invoice voided");
  });

  it("PR3: send outcomes and triggers match packages/types; the 10-minute cooldown", () => {
    expect([...RF_INVOICE_SEND_OUTCOME_VALUES]).toEqual(s.RF_INVOICE_SEND_OUTCOME_VALUES);
    expect([...RF_INVOICE_SEND_OUTCOME_VALUES]).toEqual([
      "sent",
      "cooldown",
      "not_open",
      "not_found",
      "no_recipients",
      "failed",
    ]);
    expect([...RF_INVOICE_SEND_TRIGGERS]).toEqual(s.RF_INVOICE_SEND_TRIGGERS);
    expect([...RF_INVOICE_SEND_TRIGGERS]).toEqual(["manual", "issue", "d0", "d7", "d14"]);
    expect(RF_INVOICE_SEND_COOLDOWN_MS).toBe(10 * 60 * 1000);
    expect(RF_INVOICE_SEND_MAX_IDS).toBe(50);
  });

  it("PR3: the RF_INVOICE_SENT audit code is registered with its label", () => {
    expect(RF_INVOICE_AUDIT_ACTIONS.SENT).toBe("RF_INVOICE_SENT");
    expect(AdminAuditAction.RF_INVOICE_SENT).toBe("RF_INVOICE_SENT");
    expect(ADMIN_AUDIT_ACTION_LABELS.RF_INVOICE_SENT).toBe("RouteFlow invoice emailed");
  });

  it("RF_INVOICE_TEST_TENANT_SLUGS: default empty; parses a trimmed list; a non-test slug throws", () => {
    expect(rfInvoiceTestTenantSlugs(undefined)).toEqual([]);
    expect(rfInvoiceTestTenantSlugs("")).toEqual([]);
    expect(rfInvoiceTestTenantSlugs(" e2e-a , qa-b,,e2e-a ,test")).toEqual([
      "e2e-a",
      "qa-b",
      "test",
    ]);
    expect(() => rfInvoiceTestTenantSlugs("e2e-a,acme")).toThrow(/not an approved test tenant/);
    expect(() => rfInvoiceTestTenantSlugs("QA-upper")).toThrow();
  });
});

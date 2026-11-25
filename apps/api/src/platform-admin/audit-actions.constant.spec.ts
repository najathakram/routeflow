import {
  FEATURE_CONFIG_CLEARED_ACTION,
  FEATURE_CONFIG_SET_ACTION,
} from "../billing/feature-config.service";
import {
  AdminAuditAction,
  ADMIN_AUDIT_ACTION_FACETS,
  ADMIN_AUDIT_ACTION_LABELS,
  adminAuditActionLabel,
} from "./audit-actions.constant";

describe("SA-1: feature-config audit actions have admin labels", () => {
  it.each([FEATURE_CONFIG_SET_ACTION, FEATURE_CONFIG_CLEARED_ACTION])(
    "%s resolves to a human label (not null, not the raw code)",
    (code) => {
      const label = adminAuditActionLabel(code);
      expect(label).toBeTruthy();
      expect(label).not.toBe(code);
      expect(ADMIN_AUDIT_ACTION_FACETS.map((f) => f.code)).toContain(code);
    },
  );

  it("labels read as plain English for set and clear", () => {
    expect(ADMIN_AUDIT_ACTION_LABELS.FEATURE_CONFIG_SET).toBe("Feature setting changed");
    expect(ADMIN_AUDIT_ACTION_LABELS.FEATURE_CONFIG_CLEARED).toBe("Feature setting cleared");
  });
});

describe("R-2: the staff refund audit action", () => {
  it("TENANT_STAFF_REFUND_RECORDED has its code, its label and a place in the facet list", () => {
    expect(AdminAuditAction.TENANT_STAFF_REFUND_RECORDED).toBe("TENANT_STAFF_REFUND_RECORDED");
    expect(ADMIN_AUDIT_ACTION_LABELS.TENANT_STAFF_REFUND_RECORDED).toBe("Staff refund recorded");
    expect(adminAuditActionLabel("TENANT_STAFF_REFUND_RECORDED")).toBe("Staff refund recorded");
    expect(ADMIN_AUDIT_ACTION_FACETS.map((f) => f.code)).toContain("TENANT_STAFF_REFUND_RECORDED");
  });
});

import {
  FEATURE_CONFIG_CLEARED_ACTION,
  FEATURE_CONFIG_SET_ACTION,
} from "../billing/feature-config.service";
import {
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

import type { FeaturePreviewRequest, FeaturePreviewResponse } from "../types";
import { EFFECTIVE_FIXTURE } from "./effective.fixtures";

/**
 * Builds a `FeaturePreviewResponse` fixture: `before` is always the unmodified trace; `after`
 * flips exactly the keys the request implies changed, so `changed` is derivable and testable
 * ("preview shows exactly the diff that apply sends" — brief D test 3). Used by both Jest
 * mock handlers and the Playwright route mocks; keep it a pure function of the request so a
 * test can assert preview output without re-deriving resolver logic.
 */
export function previewFixture(request: FeaturePreviewRequest): FeaturePreviewResponse {
  const before = EFFECTIVE_FIXTURE;
  const changed = new Set<string>();
  const after = before.map((f) => {
    let next = f;
    if (request.planKey) {
      // A tier change only visibly changes ADDON_SKU-sourced rows in this fixture (PRESET rows
      // are re-derived server-side from the new plan's term, which this mock doesn't attempt).
      if (f.key === "recurring_routes" && request.planKey === "STARTER") {
        next = { ...f, serving: false, source: "NONE", billing: { charged: false } };
        changed.add(f.key);
      }
    }
    for (const ov of request.overrides ?? []) {
      if (ov.featureKey === f.key) {
        const serving = ov.effect === "GRANT";
        if (serving !== f.serving || f.source !== (serving ? "OVERRIDE_GRANT" : "OVERRIDE_DENY")) {
          next = {
            ...f,
            serving,
            source: serving ? "OVERRIDE_GRANT" : "OVERRIDE_DENY",
            detail: { ...f.detail, reason: ov.reason, kind: ov.kind },
          };
          changed.add(f.key);
        }
      }
    }
    for (const [key, mode] of Object.entries(request.modes ?? {})) {
      if (f.key === key && f.mode && f.mode.effective !== mode) {
        next = { ...f, mode: { ...f.mode, value: mode, effective: mode } };
        changed.add(f.key);
      }
    }
    return next;
  });
  return { before, after, changed: [...changed] };
}

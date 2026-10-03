/**
 * Size ratchet — the 15 largest source files may not grow past baseline + a small headroom.
 *
 * Source: local-assets/handoff/2026-09-19/repo-hygiene-audit.md §3 (the busiest AND biggest files —
 * orders/invoices services and their specs are touched 27-38 times a month, so every PR near them
 * risks a conflict). A feature that has to touch one of these first extracts its slice into its own
 * file (the LineItemRow prefactor pattern), so the giant ends up SMALLER, never larger.
 *
 * When you shrink one, lower its baseline here in the same PR — the ratchet only ever moves down.
 * A file listed here that no longer exists fails too (a rename must re-point its row, never
 * silently drop out of the ratchet).
 *
 * Runs in the `test:repo-truth` lane (jest.repo-truth.config.js) — it reads files in apps/web and
 * apps/mobile, so it must run on every scoped pre-push, not only when apps/api changes.
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * Headroom above each baseline: a lane that adds a few lines to a giant while doing real work
 * must not go red on +1. Growth BEYOND it means the slice you are adding belongs in its own
 * module. The ratchet only ever moves DOWN — when you shrink a file, lower its baseline here in
 * the same PR (never raise one).
 */
const HEADROOM = 25;

/** Repo-relative path → baseline line count (measured 2026-09-19 at 91d323de). */
const BASELINE: Record<string, number> = {
  // SA-124f/SA-124h: the 5710 -> 5755 raise made after B776's SA-124e round was WRONG — no
  // approval for a raise exists (ratchets only ever move down; a raise is the owner's call, not
  // a lane's or the SA's), and the PR body's "the SA/fleet lead accepted this baseline move" note
  // was never true. R1 (SA-124g/h's fallback scope) reverted updateOrderItems' replaceAll rebuild
  // to master byte-for-byte, so the growth that prompted the raise is gone; restored to 5710.
  // Round 4 continued: merging origin/master brought in its own unrelated growth (operator
  // tier-price select columns, +6) — SA-124h's instruction was to extract until the MERGED file
  // is comfortably under the old ceiling, not merely within headroom. buildReplaceAllLineData
  // (the replaceAll rebuild's per-item price/data build) moved verbatim to its own file
  // (orders/replace-all-line-build.ts) — 5740 -> 5540. Lowered to the measured value. Round 5
  // (sourceLineId): buildExistingLineMaps also extracted — still fits at 5540, unchanged.
  "apps/api/src/orders/orders.service.ts": 5345, // #2716c/SA-592a: BOGO counterpart snapshot -> replace-all-line-build.ts (was 5359); #2716c/SA-592: tier-restore adapter (measured 5359); #2716c: (B)/(C) local classifiers -> staff-line-price.ts (was 5408; measured 5361 on #2751); #2563: diff removals -> order-line-removal.ts (was 5419); #2530: replay-key lookup + stamping -> merge-idempotency.ts (was 5487; measured 5501 on master d7d1cb88); #2391/SA-065: changeStatus transition table -> order-status-transitions.ts (was 5488); #2094: findOrderIdByIdempotencyKey -> merge-idempotency.ts to fit the inline-return hooks (was 5540); B776/SA-124a: buildMergeLineWrites replaced both merge methods' own live-pack fold (was 5751; SA-065 before that: appendOrderRevision -> order-revisions.ts, was 5780; U1 before that: class tail -> order-lifecycle.ts, 5880)
  "apps/api/src/invoices/invoices.service.ts": 5916, // #1529: computeDepositFields -> deposit-fields.ts (was 5926; measured 5916 on 1f9f48f0 + this change); #2557: KPI tiles -> invoice-kpi-summary.ts (was 6075; measured 6081 on master 538d81c6); payment receipt images -> payment-image.ts (was 6111; measured 6127 on master 1a55c021); #2178: revert-set selection -> order-edit-revert-set.ts (was 6124; measured 6111 after the bdc2e019 merge); Train A (owner, 3 merge trains): #2323 (SA-065 resync extraction, 6163) then #2117 (F-05 PR2 invoice-list-query extraction, 6151) compose to a measured 6124; lower-of, never raised.
  "apps/api/src/orders/orders.service.spec.ts": 9439, // #2563: OrdersController merge-choice block -> orders.controller.merge-choice.spec.ts (was 9511);
  "apps/api/src/customers/customers.service.ts": 3276, // #2558/SA-510a: delete pre-flight + in-tx guards -> customer-delete-preflight.ts (was 3307; 3332 at the cap)
  "apps/api/src/invoices/invoices.service.spec.ts": 9351,
  "apps/web/app/(dashboard)/customers/[id]/page.tsx": 4378,
  "apps/web/app/(dashboard)/orders/[id]/page.tsx": 3705, // M4a-1: scan-level line helpers -> orders/[id]/scan-level-line.tsx (was 3720)
  "apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx": 2291, // SA-641 I7: PR2-PR4 must each leave it net-smaller; new UI goes in extracted files
  "apps/api/src/customers/customers.service.spec.ts": 3138, // #2587: REG-B189 destruction pins retired (was 3209)
  "apps/api/src/routes/routes.service.ts": 3119, // #2514: run-status checks -> delivery-lines.util.ts (was 3126); #2562 (#2135): run-stop reorder body -> run-stop-reorder.ts; merged file measures 3126 (wc -l, SA-425a/512c). // #2512: POD-ingest helpers -> routes/pod-ingest.ts (was 3189); prefactor: run/stop select shapes + status constants live in routes/routes.constants.ts (was 3270)
  "apps/web/app/(dashboard)/products/[id]/page.tsx": 2942,
  "apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx": 1405, // #2340 prefactor (re-derived after #2444 moved StepperRow to components/EditItemsStepperRow): DraftItemCard, PriceOverrideModal, the unlisted card+modal, CreateCreditNoteModal, ProductPicker and the StyleSheet moved verbatim to components/edit-items/*; marginFloorPrice -> lib/margin-floor-price.ts (master was 3205 after #2444). Measured, not rounded.
  "apps/mobile/components/NewOrderScreen.tsx": 2560, // #2339: styles, CartModal (+ its sections, UnlistedCartRow), LinePriceModal, UnlistedItemModal, CreateCreditNoteSheet, CustomerPickerView and the shared types -> components/new-order/ (was 4056; measured 2560 on 8fa135c2 + this change); SA-085: lineUnitFor + the total/totalItems memo -> lib/cart-order-total.ts (executable pin for the order-total fix) (was 4078)
  "apps/web/app/(dashboard)/inventory/page.tsx": 3303,
  "apps/web/app/(marketing)/marketing.css": 9941,
  "apps/web/components/ScanInvoiceModal.tsx": 3134,
};

function lineCount(abs: string): number {
  const text = fs.readFileSync(abs, "utf8");
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

describe("size ratchet — the 16 largest source files never grow past baseline + headroom", () => {
  it("tracks exactly 16 files", () => {
    expect(Object.keys(BASELINE)).toHaveLength(16);
  });

  it.each(Object.entries(BASELINE))("%s stays within %i + HEADROOM lines", (rel, baseline) => {
    const max = baseline + HEADROOM;
    const abs = path.join(REPO_ROOT, rel);
    // A missing file must FAIL (renamed/moved without re-pointing the ratchet), never self-skip.
    expect(fs.existsSync(abs)).toBe(true);
    const lines = lineCount(abs);
    if (lines > max) {
      throw new Error(
        `${rel} grew to ${lines} lines (baseline ${baseline} + ${HEADROOM} headroom = ${max}, ` +
          `+${lines - max} over). Move new code to a new module — extract the slice you are ` +
          `changing into its own component/service (a prefactor PR) so this file shrinks or ` +
          `holds flat. Never raise the baseline.`,
      );
    }
    expect(lines).toBeLessThanOrEqual(max);
  });
});

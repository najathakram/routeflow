/**
 * Size ratchet — the 15 largest source files may only hold their size or shrink.
 *
 * Source: local-assets/handoff/2026-09-19/repo-hygiene-audit.md §3 (the busiest AND biggest files —
 * orders/invoices services and their specs are touched 27-38 times a month, so every PR near them
 * risks a conflict). A feature that has to touch one of these first extracts its slice into its own
 * file (the LineItemRow prefactor pattern), so the giant ends up SMALLER, never larger.
 *
 * When you shrink one, lower its number here in the same PR — the ratchet only ever moves down.
 * A file listed here that no longer exists fails too (a rename must re-point its row, never
 * silently drop out of the ratchet).
 *
 * Runs in the `test:repo-truth` lane (jest.repo-truth.config.js) — it reads files in apps/web and
 * apps/mobile, so it must run on every scoped pre-push, not only when apps/api changes.
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/** Repo-relative path → maximum line count (measured 2026-09-19 at 91d323de). */
const MAX_LINES: Record<string, number> = {
  "apps/api/src/orders/orders.service.ts": 6728,
  "apps/api/src/invoices/invoices.service.ts": 6412,
  "apps/api/src/orders/orders.service.spec.ts": 9511,
  "apps/api/src/customers/customers.service.ts": 3307,
  "apps/api/src/invoices/invoices.service.spec.ts": 9351,
  "apps/web/app/(dashboard)/customers/[id]/page.tsx": 4378,
  "apps/web/app/(dashboard)/orders/[id]/page.tsx": 3728,
  "apps/api/src/customers/customers.service.spec.ts": 3209,
  "apps/api/src/routes/routes.service.ts": 3270,
  "apps/web/app/(dashboard)/products/[id]/page.tsx": 2942,
  "apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx": 3315,
  "apps/mobile/components/NewOrderScreen.tsx": 4556,
  "apps/web/app/(dashboard)/inventory/page.tsx": 3303,
  "apps/web/app/(marketing)/marketing.css": 9941,
  "apps/web/components/ScanInvoiceModal.tsx": 3134,
};

function lineCount(abs: string): number {
  const text = fs.readFileSync(abs, "utf8");
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

describe("size ratchet — the 15 largest source files never grow", () => {
  it("tracks exactly 15 files", () => {
    expect(Object.keys(MAX_LINES)).toHaveLength(15);
  });

  it.each(Object.entries(MAX_LINES))("%s stays at or under %i lines", (rel, max) => {
    const abs = path.join(REPO_ROOT, rel);
    // A missing file must FAIL (renamed/moved without re-pointing the ratchet), never self-skip.
    expect(fs.existsSync(abs)).toBe(true);
    const lines = lineCount(abs);
    if (lines > max) {
      throw new Error(
        `${rel} grew to ${lines} lines (ratchet ${max}, +${lines - max}). Extract the slice you ` +
          `are changing into its own component/service in a prefactor PR so this file shrinks or ` +
          `holds flat. Never raise the ratchet.`,
      );
    }
    expect(lines).toBeLessThanOrEqual(max);
  });
});

/**
 * PageHeader action-slot wrap (B749/B770 shared root cause, Opus review on
 * #938). `packages/ui/src/web/PageHeader.tsx`'s action wrapper carried
 * `shrink-0` with no `max-w-full` — the wrapper never actually shrank below
 * the action content's own natural width, so a caller's own `flex-wrap` on
 * that content never got a narrow-enough box to wrap INTO. Measured at a
 * 342px content width: 413/428px, one row, same as before any per-page
 * `flex-wrap` fix. `max-w-full shrink-0` gives 2 rows with no overflow,
 * 768/1440 unchanged.
 *
 * The earlier B749 (customers) / B770 (invoices) fixes added `flex-wrap` to
 * their OWN action row — necessary but not sufficient on their own, since the
 * PageHeader-level wrapper was the thing actually preventing any row from
 * shrinking. This PR fixes both levels together. Class-presence RTL specs
 * (`*.overflow-b749.test.tsx` / `*.overflow-b770.test.tsx`) passed throughout
 * because jsdom has no layout engine — they prove the CLASS is present, never
 * that it produces a non-overflowing layout. This spec is the real proof:
 * real bounding boxes via #1288's shared overflow walk
 * (`e2e/helpers/overflow.ts`, copied byte-identical from that unmerged
 * branch), at the one width the bug actually reproduces at (390px).
 *
 * Covers every `PageHeader` caller found with a multi-child `action` prop
 * (grepped `action={` + `<PageHeader` across `apps/web/app`, 2026-09-25):
 * orders, customers, invoices (all three fold B749/B750/B770's own row-level
 * fix), plus analytics, drivers, products, routes, suppliers — none of which
 * had a filed bug number. Single-button/simple-ternary actions (deliveries,
 * dispatch, estimates, credit-notes, promotions, returns, sales-agents,
 * routes/my-runs, settings/restrictions/rules, finance/commissions) were
 * checked and don't need the fix — one button can't need to wrap — so
 * they're not swept here. `inventory/stock-counts/[id]` ALSO got the fix
 * (needs a live session id to reach; not swept by this URL-only spec, same
 * caveat #1288's own header documents for tab-as-state pages).
 */
import { test, expect, type Page } from "@playwright/test";
import { findViewportOverflow } from "./helpers/overflow";

test.use({ viewport: { width: 390, height: 844 } });

const PAGES = [
  { path: "/orders", ready: "heading", name: /^orders$/i },
  { path: "/customers", ready: "heading", name: /^customers$/i },
  { path: "/invoices", ready: "heading", name: /^invoices$/i },
  { path: "/analytics", ready: "heading", name: /^analytics$/i },
  { path: "/drivers", ready: "heading", name: /^drivers$/i },
  { path: "/products", ready: "heading", name: /^products$/i },
  { path: "/routes", ready: "heading", name: /^routes$/i },
  { path: "/suppliers", ready: "heading", name: /^suppliers$/i },
] as const;

async function goAndSettle(page: Page, path: string, headingName: RegExp) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: headingName }).first()).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("PageHeader action slot — 390px", () => {
  for (const p of PAGES) {
    test(`${p.path} header actions never escape the viewport at 390px`, async ({ page }) => {
      await goAndSettle(page, p.path, p.name);
      const { offenders } = await findViewportOverflow(page);
      expect(
        offenders,
        `viewport overflow on ${p.path} at 390px — ${offenders.length} offender(s), worst: ${JSON.stringify(offenders.slice(0, 5))}`,
      ).toHaveLength(0);
    });
  }
});

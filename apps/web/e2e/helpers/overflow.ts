import { expect, type Page } from "@playwright/test";

/**
 * Shared mobile-horizontal-overflow probe. Extracted from
 * 52-platform-admin-mobile-overflow.spec.ts (B559) so 53 (operator dashboard)
 * and 54 (buyer portal) can reuse the exact same check rather than a
 * re-implementation that could quietly drift from it — see that spec's header
 * for the full root-cause writeup of why the naive
 * `documentElement.scrollWidth <= innerWidth` check is structurally blind to
 * overflow absorbed by an inner `overflow-y: auto` container, and why walking
 * every real element's bounding box is the check that actually catches it.
 */

export interface Offender {
  tag: string;
  cls: string;
  text: string;
  left: number;
  right: number;
}

/** The RIGHT probe: any element whose rendered box escapes the viewport
 * horizontally, wherever the overflow is actually contained — EXCEPT inside a
 * wrapper this codebase deliberately marked scrollable
 * (`overflow-x-auto`/`overflow-x-scroll`, OR the bare `overflow-auto`
 * shorthand — `packages/ui/src/web/Table.tsx`'s shared `<Table>` wraps every
 * data table in the app with `w-full overflow-auto rounded-lg ...`, and that
 * IS the same intentional pattern, just spelled without the `-x-`. Confirmed
 * directly at 390px on the operator dashboard's recent-orders table: the
 * wrapper's own box stays fully in bounds (right edge 366 of 390) while the
 * table inside it naturally wants 588px and correctly scrolls within the
 * wrapper — this class of "offender" is the wrapped table's cells, not a
 * page-level drift). That is intentional, reachable-by-scroll UX, not the bug
 * class this probe hunts. An unbounded "scrollable" wrapper that itself
 * escapes the viewport still counts as a real bug — only a wrapper BOTH
 * marked scrollable AND itself fitting the viewport is allowlisted. Returns
 * EVERY offender, sorted worst-first — NOT pre-sliced to a top-N. Pre-merge
 * review caught the real reason that matters: an `ignore` predicate applied
 * after a top-5 slice only sees whatever happened to be worst, so a page like
 * the invoices list (B750's table produces dozens of offenders) would fill
 * all 5 slots with the ignored defect and hide any OTHER real overflow on the
 * same page — the ignore filter must run over the full set, and slicing for
 * the error message happens after that, in assertNoOverflow.
 */
/**
 * `ignoreContainerSelectors`, when given, drops any offender that is a
 * descendant of an element matching one of these plain CSS selectors —
 * checked via `closest()` inside the page, so it catches content nested
 * arbitrarily deep inside a known-bad container (a table's row-action
 * buttons and their icons, not just the table/row/cell tags themselves).
 * Reserve this for a container that is genuinely a SINGLE known, already
 * filed defect on the page being checked (e.g. "the one table on this
 * invoices list") — it is a coarser tool than the offender-level `ignore`
 * predicate in assertNoOverflow and should be scoped just as narrowly.
 */
export async function findViewportOverflow(
  page: Page,
  ignoreContainerSelectors: string[] = [],
): Promise<Offender[]> {
  return page.evaluate((ignoreSelectors) => {
    const vw = window.innerWidth;
    const offenders: Array<{
      tag: string;
      cls: string;
      text: string;
      left: number;
      right: number;
      escape: number;
    }> = [];
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const rightEscape = r.right - vw;
      const leftEscape = -r.left;
      const escape = Math.max(rightEscape, leftEscape);
      if (escape <= 1) return;

      if (ignoreSelectors.some((sel) => el.closest(sel))) return;

      let node: Element | null = el.parentElement;
      while (node && node !== document.body) {
        // MAIN is never allowlisted here, even if it carries overflow-auto /
        // overflow-x-auto: MAIN is exactly the shell-level element these
        // specs hold accountable (see (dashboard)/layout.tsx,
        // buyer/portal/layout.tsx, (platform-admin)/layout.tsx). If a shell
        // regressed to the old bare `overflow-auto` this fix removed, a MAIN
        // exemption would silently allowlist it — the same bug this probe
        // exists to catch, from the one element the probe must never trust.
        const cls = (node.className || "").toString();
        if (node.tagName !== "MAIN" && /\boverflow(-x)?-(auto|scroll)\b/.test(cls)) {
          const wr = node.getBoundingClientRect();
          if (wr.right <= vw + 1 && wr.left >= -1) return; // contained, intentional scroll
        }
        node = node.parentElement;
      }

      offenders.push({
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 90),
        text: (el.textContent || "").trim().slice(0, 40),
        left: Math.round(r.left),
        right: Math.round(r.right),
        escape: Math.round(escape),
      });
    });
    offenders.sort((a, b) => b.escape - a.escape);
    return offenders;
  }, ignoreContainerSelectors);
}

/** Legacy document-level check — kept as a regression guard, but NOT
 * sufficient on its own: it never trips for the absorbed-by-an-inner-scroller
 * bug class (see module header). */
export async function documentLevelOverflowPx(page: Page): Promise<number> {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  return scrollWidth - innerWidth;
}

/**
 * `ignore`, when given, filters out offenders that match a KNOWN, separately
 * filed defect by their own tag/text, so a test can still assert everything
 * ELSE on the page is clean rather than skip the whole page. `ignoreContainer`
 * does the same but by ancestry (see findViewportOverflow) — use it instead
 * when the known defect's own overflowing content is nested arbitrarily deep
 * (a table's row-action buttons and icons, not just its cells). Keep either
 * narrow and specific to the one filed bug it exists for — a broad ignore
 * defeats the probe the same way an unqualified page skip would.
 *
 * Logs the URL it actually checked, always. A detail-page navigation that
 * silently no-ops (a locator matching 0, a click landing on the wrong
 * element, client-side navigation that never completes) used to leave a
 * conditional check simply skipped with nothing in the test output to show
 * for it — this is the fleet's own fix for that, not just this file's:
 * every call proves, in the log, which real URL it ran the probe against.
 */
export async function assertNoOverflow(
  page: Page,
  screenLabel: string,
  ignore?: (o: Offender) => boolean,
  ignoreContainer?: string[],
) {
  console.log(`[overflow probe] ${screenLabel} — checking ${page.url()}`);
  let offenders = await findViewportOverflow(page, ignoreContainer);
  if (ignore) offenders = offenders.filter((o) => !ignore(o));
  // Slice for the failure message only, AFTER the ignore filter — see
  // findViewportOverflow's header for why filtering after a slice would have
  // let an ignored defect's own offenders crowd out everything else.
  const worst = offenders.slice(0, 5);
  expect(
    offenders,
    `viewport overflow on ${screenLabel} at ${page.viewportSize()?.width}px — ${offenders.length} offender(s), worst: ${JSON.stringify(worst)}`,
  ).toHaveLength(0);
}

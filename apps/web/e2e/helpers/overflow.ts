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
 *
 * Two, DIFFERENT checks live here, both walking `body *`: (1) a box escaping
 * the viewport (findViewportOverflow's main pass), and (2) content clipped
 * INSIDE an in-viewport box by its own `overflow-hidden`/`clip` (the second
 * pass) — added after pre-merge review caught this branch's own probe
 * missing exactly this on `(dashboard)/dashboard/page.tsx`'s order-pipeline
 * strip ("Cancelled" hard-clipped to "Cancelle", no ellipsis). Check (1)'s
 * box can be perfectly in-bounds while check (2) still fires, and vice
 * versa — they are not redundant.
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
export interface OverflowResult {
  offenders: Offender[];
  /** Count of elements dropped by ignoreContainerSelectors — see
   * assertNoOverflow's "the ignore actually ignored something" assertion. */
  ignoredByContainer: number;
}

export async function findViewportOverflow(
  page: Page,
  ignoreContainerSelectors: string[] = [],
): Promise<OverflowResult> {
  return page.evaluate((ignoreSelectors) => {
    const vw = window.innerWidth;
    let ignoredByContainer = 0;
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

      if (ignoreSelectors.some((sel) => el.closest(sel))) {
        ignoredByContainer++;
        return;
      }

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

    // SECOND, SEPARATE pass: content clipped INSIDE an in-viewport box.
    // Pre-merge review found this class of miss directly: the dashboard's
    // order-pipeline strip ((dashboard)/dashboard/page.tsx:788-789) renders
    // "Cancelled" hard-clipped to "Cancelle", no ellipsis — the strip's own
    // box, and the label's own box, both fit inside the viewport; only the
    // rendered TEXT overflows its cell. The escape-based check above can
    // never see this: it compares a box to the viewport, not a box's
    // content to the box itself. `overflow-hidden`/`overflow-x-hidden`/
    // `clip`/`overflow-x-clip` (never `auto`/`scroll` — those are the
    // allowlist's job above, a DIFFERENT and unrelated question of whether
    // the container's own box fits) have no scroll affordance at all, so
    // `scrollWidth > clientWidth` on one of them is unreachable BY
    // DEFINITION — there's no "intentional, reachable" case to allowlist,
    // unlike the escape check's overflow-auto allowance. Excludes anything
    // using `text-overflow: ellipsis`, which is a deliberate, self-
    // documenting truncation pattern, not a bug.
    document.querySelectorAll("body *").forEach((el) => {
      // MAIN excluded here too, same shell-boundary reasoning as the first
      // pass, but for a different specific reason: found running this for
      // real, on the customers list at 390px, where the operator-dashboard
      // shell's own `overflow-x-hidden` — the intentional backstop THIS PR
      // ships, working exactly as designed — got reported as if it were
      // ITSELF the clip bug, just because some descendant's content is
      // wider than MAIN's box. That is the fix doing its job (absorbing
      // excess width so it can't drift the whole page), not a "text
      // silently clipped with no way to see it" bug like the pipeline
      // strip. A genuine clip bug should be attributable to a more specific
      // element (a card, a table wrapper) — if one exists, THAT element
      // carries its own overflow-hidden/clip class and this pass still
      // catches it independently; MAIN absorbing the overflow one level up
      // is not itself a second, separate defect to report.
      if (el.tagName === "MAIN") return;
      const cls = (el.className || "").toString();
      if (!/\boverflow(-x)?-(hidden|clip)\b/.test(cls)) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const style = getComputedStyle(el);
      if (style.textOverflow === "ellipsis") return;
      // Found running this for real: ignoreSelectors was only ever checked
      // in the FIRST pass above — a known, filed clip defect (the dashboard
      // pipeline strip) caught by THIS pass had no way to be ignored, and
      // assertNoOverflow's own "ignoreContainer matched nothing" guard threw
      // exactly as designed, on this exact gap. Both passes must honor it.
      if (ignoreSelectors.some((sel) => el.closest(sel))) {
        ignoredByContainer++;
        return;
      }
      const r = el.getBoundingClientRect();
      offenders.push({
        tag: el.tagName,
        cls: cls.slice(0, 90),
        text: `[clipped content] ${(el.textContent || "").trim().slice(0, 40)}`,
        left: Math.round(r.left),
        right: Math.round(r.right),
        escape: el.scrollWidth - el.clientWidth,
      });
    });

    offenders.sort((a, b) => b.escape - a.escape);
    return { offenders, ignoredByContainer };
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
 *
 * Both `ignore` and `ignoreContainer`, when given, must actually match
 * something, or this throws — a stale ignore rule (the underlying bug got
 * fixed for real, or the app changed shape under it) must fail loudly, not
 * silently keep passing while proving nothing. Remove the rule instead of
 * letting it go quiet.
 */
/**
 * Waits for a list/table page's OWN loading UI to clear before a probe
 * measures it — so a probe can't fire against a loading skeleton instead of
 * the real table rows or empty state. Found necessary by pre-merge review:
 * a page-shell wait (a static heading or toolbar button, present before data
 * ever loads) is not the same thing as a data-presence wait, and several of
 * this app's list pages render measurably different layouts while loading
 * vs. once real content lands (e.g. a bare skeleton block with no headers or
 * columns at all).
 *
 * Checks three DIFFERENT conventions this codebase actually uses for a
 * loading state, not one — a single selector would silently miss whichever
 * pages use the others: `animate-pulse` skeleton blocks (customers, products,
 * routes), an `animate-spin` icon (orders, invoices), and literal "Loading…"
 * text (settings' users tab). `.not.toBeVisible()` on a locator that matches
 * zero elements passes immediately, so this is a no-op on any page that
 * doesn't use a given convention or that already finished loading by the
 * time this runs — it never invents a wait where there was nothing to wait
 * for.
 */
export async function waitForDataLoaded(page: Page) {
  // `:visible` + toHaveCount(0), not `.first()` + not.toBeVisible() — found
  // by review: `.first()` only tracks ONE element in DOM order, so a page
  // with several simultaneous skeleton blocks (a plausible real case, not
  // hypothetical) could pass the moment the FIRST one resolves while others
  // are still pulsing. Counting every currently-visible match to zero is the
  // check that actually means "nothing is loading anymore".
  await expect(page.locator(".animate-pulse:visible")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".animate-spin:visible")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/^Loading/i).first()).not.toBeVisible({ timeout: 15_000 });
}

export async function assertNoOverflow(
  page: Page,
  screenLabel: string,
  ignore?: (o: Offender) => boolean,
  ignoreContainer?: string[],
) {
  console.log(`[overflow probe] ${screenLabel} — checking ${page.url()}`);
  const { offenders: allOffenders, ignoredByContainer } = await findViewportOverflow(
    page,
    ignoreContainer,
  );
  let offenders = allOffenders;
  let ignoredByPredicate = 0;
  if (ignore) {
    ignoredByPredicate = offenders.filter(ignore).length;
    offenders = offenders.filter((o) => !ignore(o));
  }
  if (ignore && ignoredByPredicate === 0) {
    throw new Error(
      `[overflow probe] ${screenLabel}: the ignore predicate matched nothing — either the ` +
        `defect it was filed for is already fixed (remove the ignore) or the app changed shape ` +
        `under it (the predicate needs updating). Either way, a silently-inert ignore is not safe to keep.`,
    );
  }
  if (ignoreContainer && ignoredByContainer === 0) {
    throw new Error(
      `[overflow probe] ${screenLabel}: ignoreContainer (${JSON.stringify(ignoreContainer)}) matched nothing — ` +
        `either the defect it was filed for is already fixed (remove the ignore) or the container ` +
        `selector no longer matches the app's markup. Either way, a silently-inert ignore is not safe to keep.`,
    );
  }
  // Slice for the failure message only, AFTER the ignore filter — see
  // findViewportOverflow's header for why filtering after a slice would have
  // let an ignored defect's own offenders crowd out everything else.
  const worst = offenders.slice(0, 5);
  expect(
    offenders,
    `viewport overflow on ${screenLabel} at ${page.viewportSize()?.width}px — ${offenders.length} offender(s), worst: ${JSON.stringify(worst)}`,
  ).toHaveLength(0);
}

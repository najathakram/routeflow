# Site: print, headings without a scroll, and the wheel (WP1.1, WP1.2)

> Brandless extract of the site plan rows that ship to `master` ahead of any rename (owner ruling
> 2026-11-12). Paths are under `apps/web/public/site/` unless they start with `apps/`. Bugs: B1324
> (blank prints, headings hidden until scrolled), B1322 (headings hidden; the wheel's words column is
> WP1.2's), B1321 (wheel fit and names), B1323 (empty screen after the wheel).

## Requirements

| R | Requirement | Proven by |
|---|---|---|
| R1 | In print every page shows all its content in the static layout: no blank band, no overlapping text, no dark text on dark, the wheel as its still. Leaving print restores motion, the scroll position and the same number of scroll triggers as a fresh load | T1 |
| R2 | With scripts on and no scrolling, every `h1` and `h2` is fully opaque and visible | T2 |
| R3-R9 | The wheel: fits its stage at every size and beat (R3, R4), one pose and one lift weight (R5), names in a legend not on the canvas (R6), a heading always up in the words column (R7), no empty screen after it (R8), resize equals a fresh load (R9) | T3-T8 |
| R10 | On a phone no heading overlaps the text after it at any scroll position | T9 |
| R12 | Nothing is lost: links, buttons, controls, anchors, accordions, the 15 tile buttons | T12 |
| R13 | `public/site` under 5 MB; wheel script at most 80,000 bytes; no new vendor file; assets under `/site/` | T13 |
| R27 | Every removed static pin has a ledger row naming the test that now guards it | T27 |

## Tests

| T | Where | Then |
|---|---|---|
| T1 | `apps/web/e2e/85-site-proof-pages.spec.ts` | 12 pages at 1440x900 and 390x844, mid-page, print: no `js-motion`; every `h1-h3,p,li,a` opacity 1 and visible; nothing sticky or fixed that holds content; first-screen contrast at least 4.5; no heading on its next sibling. Back to screen: `js-motion`, `scrollY` and the trigger count as before / as a fresh load |
| T1 wheel clause | same, gated by `WHEEL_PRINT_CLAUSE` | `.rfw` is `rfw--static` with a visible `svg` and no canvas, and the wheel and its words column (`.rfw, .hx-copy`) pass the sweeps. **Skipped until WP1.2 (B1321)**, reason in the report |
| T2 | spec 85 | each page at 1440x900, never scrolled: every `h1,h2` outside `.rfw-live` at opacity .99 or more, at least 3 per page |
| T3-T8 | `apps/web/e2e/84-site-proof-wheel.spec.ts` | the wheel; lands with WP1.2 |
| T9 | spec 85 | `/` and `/product` at 390x844 and 320x568, steps of 0.1 window, read on the first frame after each step and again settled: no `h2` still to come (in the window or below it) intersects its next block |
| T12 | spec 85 + `apps/web/e2e/helpers/site-parity*.{ts,json}` | capture equals the master baseline minus rows in `site-parity.changes.json` |
| T13 | `apps/web/app/(marketing)/site-wheel-budget.static.test.ts` | budgets of R13; lands with WP1.2 |
| T27 | `apps/web/app/(marketing)/site-pin-ledger.json` (+ its test in WP1.2) | per file: current literal pins + ledger rows = baseline |

## Packages

- **WP1.1** (R1 pages, R2, R10; T1 less the wheel clause, T2, T9, T12). Every GSAP media condition is
  screen-only; an idempotent print toggle in `js/home-up.js` and `js/site.js`; reveals start visible and
  never use `once`; a heading is never faded by page motion; a print block in `css/site.css`; the phone
  rise in `css/mobile.css` moves a heading less than the gap under it, on screen only.
- **WP1.2** (R1 wheel, R3-R9, R12, R13, R27; T1 wheel clause, T3-T8, T12, T13, T27). The wheel's own
  matchMedia gains a print branch that shows the still; then set `WHEEL_PRINT_CLAUSE = true`, register spec 84 as the
  local-lane `site-proof-wheel` project (never in `site-proof`: ~16 min on one worker), and land T13 and the T27 test. Carry the T8 harness fix:
  `triggerCount` counts only persistent triggers, and the fresh page is re-mounted and scrolled like the
  resized one. Carry the read-only `cam()` hook on the wheel handle that T4 reads.

## Rulings recorded here (2026-11-13)

- **S9:** the post-deploy job runs every Playwright project, so only spec 85 matches `site-proof`;
  spec 84 is the local-lane `site-proof-wheel` project, kept out of CI and post-deploy for time.
- **T13 lands with WP1.2.** Its distinctive clause caps the wheel script, calibrated as the base size
  plus the `cam()` hook, and WP1.1 touches no wheel file; its other clauses pass by construction today.
- **T9 strengthened (L-377).** The WP0 probe measured only settled pairs with both boxes in the window and
  passed on master; on master it now fails on the bug's own value, 10 px (a 22 px hold over a 12 px gap).
- **WP0 HF4:** a closed phone menu is not content: print hides `#mobile-menu`. **HF5:** an empty fixed
  layer (a toast viewport) is left out of T1's sticky sweep.
- **GSAP matchMedia always matches a condition KEY named `all`**, whatever its value, so site.js renames
  that key when it becomes screen-only.

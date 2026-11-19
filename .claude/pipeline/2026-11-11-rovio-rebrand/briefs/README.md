# Wave 2 and wave 3 lane briefs (site rebrand, local branch only)

Written 2026-11-19 at `rebrand/rovio-site` 8cb10501ba (clean). Merge forecast from `git merge-tree` against the local `origin/master` ref 79d5702e4e (contains the wheel fix f5dbd46a83, #4367). Builders commit locally; nothing is pushed.

## Step 0 · before wave 2 (coordinator, one at a time)
1. Bring in the Mac mini's three commits after 8cb10501ba: 9dba24cdc (control-byte pin also flags 0x0B, 0x0C, 0x0E-0x1F), 4afaa3556 (`email-brand.pin.spec.ts` reads `common/brand-host.ts`), 1d6426149 (plan note in `handoff/b1b-diff.txt`). No site or app code.
2. Confirm the review of `4387f1498` (wave 2a control-byte cleanup); B1b (`ed056134b`) is PASS.
3. Catch-up: merge `origin/master` (merge commit; master's copies win on test-harness files). Forecast: 2 conflicts.
   - `apps/web/e2e/84-site-proof-wheel.spec.ts` add/add: take master's file.
   - `apps/web/e2e/helpers/site-parity.changes.json` content: master's hunk, then re-add the branch's rows (WP0, 1.3b-pages).
   - Clean: `playwright.config.ts`, e2e 36, `site-color-and-life`, `rf-wheel-up.js` (master's copy keeps `cam()`), `home.html`, `home-up.js`, `home.css`, `mobile.css`, `home-up.css`, API email files. Merged `rf-wheel-up.js` = 73,279 B.
4. One commit registering project `site-waves` in `apps/web/playwright.config.ts`, beside the `site-type-alignment` block: `testMatch: /(8[89]|9[0-3])-site-w[23]-[a-z0-9-]+\.spec\.ts/`, `dependencies: []`, Desktop Chrome, neutral comment. Lanes never edit the config.
5. Every `site-*` static test by path, then one whole web Jest. Record totals.

## New spec files (one per lane, so no two lanes share a spec)
| No. | File | Lane | Tests |
|---|---|---|---|
| 88 | `e2e/88-site-w2-wheel.spec.ts` | 2.2 | T17c, T18b, T19 (test-plan), P06, P07 |
| 89 | `e2e/89-site-w2-css.spec.ts` | 2.1b | T42, T46a |
| 90 | `e2e/90-site-w3-home.spec.ts` | 2.3-home | T20, T15, T47 |
| 91 | `e2e/91-site-w3-pricing.spec.ts` | 2.3-pricing | T46b, T20, T15 |
| 92 | `e2e/92-site-w3-inner.spec.ts` | 2.3-inner | T20, T15 |
| 93 | `e2e/93-site-w3-header.spec.ts` | header | T48a-d |
Master has no spec above 85 today; re-check before naming (bug-id clash trap, third recurrence).

## Order and parallel groups
| Step | Lanes (parallel inside a step) | Starts when | Files (no two lanes share one) |
|---|---|---|---|
| W2 | **2.1b**, **2.2**, **S2** | step 0 done | 2.1b: site/mobile/home/home-up css · 2.2: `rf-wheel-up.*` · S2: `home.html`, `js/*` comments, `product.html:303` |
| W2-last | 2.1b-last | 2.1b and 2.2 landed | `rf-graphics.css` aliases + `landing.html` token block |
| W2 close | coordinator | all W2 landed | `site-pin-ledger.json` rows, whole web Jest |
| W3 | **2.3-home**, **2.3-pricing**, **2.3-inner**, **header** | W2 close green | home.html · pricing.html · 7 inner html · `SiteFrameHeader.tsx`, `site-frame.css`, `site.css`, `mobile.css`, `js/site.js` |
| W3 close | coordinator | all W3 landed | pin ledger, whole web Jest, then Docker 1 |

- Shared test-data files with per-lane rows (`lib/test-support/site-brand-exemptions.ts`, `site-repaint-1a`, `site-brand-tokens`, `site-speed-budget`): lanes build in parallel, land one at a time, each deleting only its own rows (spec-delta rev 4 item 7). Suggested landing: S2, 2.2, 2.1b, 2.1b-last; W3 any order.
- 2.2 and S2 share no file; their contract (name from `og:site_name`, hub from `<template id="brand-symbol">`, one sub-line wording) is written into both briefs.
- The wheel follow-up PR ("a grab stops the wheel glide") reaches this branch only through a later master catch-up: conflict expected in `rf-wheel-up.js` (2.2's lines); master wins on 84, `site-proof.ts`, `site-pins.static.test.ts`, `package.json`.

## Docker proof 1 (end of W3), first step
Build and start the local stack from the branch head (`npm run local:up`, production web image on :3001). Then run `handoff/proof-todo.md` in full before anything else: the six `/site/<page>.html` spellings for all ten pages (307 to the clean path with the query kept, no `{{brand:` in any body with or without `-L`, malformed escapes (`/site/%70ricing.html%`, `/site/pric%ing.html`) = 400, `/site/css/site.css` 200; the same over `next dev` once); the lead's exact curls; exactly one `id="brand-tokens"` style on `/`, `/pricing`, `/privacy`, `/login`, `/signup`, `/buyer/login` and a 404; `/favicon.ico` 200 `image/x-icon`; the API image boots and one platform mail shows the logo host and size. Then projects `site-proof`, `site-proof-wheel`, `site-type-alignment`, `site-waves`, `marketing` against :3001, in the heavy slot.

## Open questions (owner: SA lane unless marked)
- OQ-1 Hub symbol: spec-delta §1 says the hub reads `<template id="brand-symbol">` "into a Path2D", but `brand.json` `symbol` is an image path (a PNG today), so there is no path data to read. Default in the briefs: the template holds `<img src="{{brand:symbol}}">`, the wheel uses `drawImage`, colour comes from the file. A Path2D needs a new `brand.json` key (2.0b's files).
- OQ-2 Wording for sentences that end with the name on home and in the wheel ("Every step is in X.", "What you can do with X.", "What is X?"): default SA wording (spec-delta §6 item 3); the briefs propose "Every step is in X, start to finish."
- OQ-3 2.1b-last edits `rf-graphics.css` and `landing.html` (T14c keeps their token blocks identical); neither is in §5's W2 list (T14B_ROWS names lane "2.1b-last").
- OQ-4 "`prices.js` tags" for S2 (§5) is undefined. T43 gives the six inner pages' `<script>` tags to 2.3-inner (W3). Briefs read S2's part as the comments in `prices.js` only.
- OQ-5 Lanes that replace pins in pin-ledger files (2.1b, 2.2) leave `site-pins` red until the close-out ledger commit (§5: ledger written only at close-out). Default: edit literals so counts hold; list any removal.
- OQ-6 S2 replaces the `home.html` file row with a hex row for 2.3-home (W3); the shared table has no such row yet.
- OQ-7 W3 page lanes own html only; home.css, home-up.css, home-color.css and the inner pages' css have no W3 owner. Default: stop and report if a band needs CSS.
- OQ-8 P09's rules live in `home-up.css:92-101`; proposed grant to the header lane in W3.
- OQ-9 `mailbox-connection.service.ts:791-792`, `:824` (tenant-admin text naming the brand) have no owner; proposed B3.
- OQ-10 S2's `product.html:303` default deletes the "Smaller plan." item (SA-1080: no login numbers); any replacement wording is the SA's or the owner's.
- OQ-11 spec-delta §5 says `site-rovio-budget` is deleted when `site-wheel-budget` arrives; master has no `site-wheel-budget`, so the wheel cap stays in `site-rovio-budget.static.test.ts`.

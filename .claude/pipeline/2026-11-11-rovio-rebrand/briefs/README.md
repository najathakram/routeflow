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
5. Run site-pins right after the catch-up (SA-1174 K4). If `site-color-and-life` reads above its baseline (29 vs 26 expected after 2.1a), raise that baseline to the merged count in the step-0 commit, citing the 2.1a commit and listing the added pins.
6. Rename the budget test `site-rovio-budget.static.test.ts` to `site-wheel-budget.static.test.ts` (keep the `-budget.static.test.ts` suffix, which is its key) and drop its pipeline-path comment (SA-1174 K8). If master later adds the same file, master's copy wins. The 2.2 brief's "green by path" list names the new file.
7. Every `site-*` static test by path, then one whole web Jest. Record totals.

## New spec files (one per lane, so no two lanes share a spec)
| No. | File | Lane | Tests |
|---|---|---|---|
| 88 | `e2e/88-site-w2-wheel.spec.ts` | 2.2 | T17c, T18b, T19 (test-plan), P06, P07 |
| 89 | `e2e/89-site-w2-css.spec.ts` | 2.1b | T42, T46a, P04 (no gradient on `.hx-over` at `/` 393) |
| 90 | `e2e/90-site-w3-home.spec.ts` | 2.3-home | T20, T15, T47 |
| 91 | `e2e/91-site-w3-pricing.spec.ts` | 2.3-pricing | T46b, T20, T15 (T20 is test-plan's band table) |
| 92 | `e2e/92-site-w3-inner.spec.ts` | 2.3-inner | T20, T15 |
| 93 | `e2e/93-site-w3-header.spec.ts` | header | T48a-d |
Master has no spec above 85 today; re-check before naming (bug-id clash trap, third recurrence).

**Test ids (SA-1174 K10).** Test-plan ids stay plain (`T19`, `T20`, `T21`). Every cite of e2e 36's own tests is written `36:T19` (ready-made pages), `36:T20` (hash focus, B1328) and `36:T21` (motion). e2e 36 is never renamed. No W2/W3 ledger row may use `replacedBy` (`e2eTitles` scans only e2e 36, 84 and 85, and no lane deletes a pin).

**Pin and ledger rules (SA-1174 K4, K11).**
- Each lane writes its own ledger change in its own commit, and never lands while site-pins is red. A lane that adds a counted pin raises the baseline in that commit and lists the pins. A lane deletes no pin; if one must go, stop and report. Lanes never edit master's guard. The reports list each edited pin literal, old -> new; the reviewer confirms none got weaker. The W2 and W3 close-out commits only verify; they write no new rows.
- These header sign-in and focus pins stay unedited, and "unedited" means `git diff --stat <lane base>..HEAD -- <those paths>` prints nothing: `components/site-frame/site-frame.test.tsx:29,68-81`; `app/(marketing)/marketing-port.static.test.ts:318-320,331`; `app/(marketing)/site-auth-nav.static.test.ts` (whole file); e2e `36:1327` (`36:T20`). Binds 2.1b and the header lane.

**Owner box (SA-1174), four taps through the lead. Item 1 is still OWNER BOX pending (SA-1174): lanes must not build it until the owner rules. Items 2-4 are decided (owner box 2026-11-19 ~20:22Z).** Recommended default first:
1. Home lines that end with the name: STILL PENDING. The owner did not accept the first lines ("re-articulate the lines to sound more natural"); a second box (SA-1174 A1 K15) offers the sets in `owner/home-lines-options.md`. Every set ends no sentence with the name, uses one sub-line string in both files, and its FAQ question matches Pricing's or changes both pages together. Touches S2 and 2.2.
2. DECIDED (owner box 2026-11-19 ~20:22Z): "Delete it now". Product page "Smaller plan" note: S2 deletes it. Touches S2.
3. DECIDED (owner box 2026-11-19 ~20:22Z): "On switch day". Mailbox help text: rename the app in both the Google and Microsoft consoles on switch day, and the three help-text sentences switch the same day; until then the old name stays. Touches B3.
4. DECIDED (owner box 2026-11-19 ~20:22Z): "Skip to plans", built only if T46b is red at the 2.3-pricing base. Touches 2.3-pricing.

**D0 console list (SA-1174).** Add the Google OAuth consent-screen app name and the Microsoft app registration display name to the consoles read back at D0 (spec-delta §2a covers only the origin). OQ-9 depends on both.

## Order and parallel groups
| Step | Lanes (parallel inside a step) | Starts when | Files (no two lanes share one) |
|---|---|---|---|
| W2 | **2.1b**, **2.2**, **S2** | step 0 done | 2.1b: site/mobile/home/home-up css (band role rules in `site.css`, tints out of `mobile.css`, the P04 glow) · 2.2: `rf-wheel-up.*` · S2: `home.html`, `js/*` comments (`prices.js` comments only), the one-key `symbolOnDark` grant in `packages/types/brand/*`; its `product.html:303` note is deleted (owner-box item 2 decided, owner box 2026-11-19 ~20:22Z) |
| W2-last | 2.1b-last (one commit; owns T21) | 2.1b and 2.2 landed | `rf-graphics.css` aliases + `landing.html` token block |
| W2 close | coordinator | all W2 landed | verification only (no new ledger rows), whole web Jest |
| W3 | **2.3-home**, **2.3-pricing**, **2.3-inner**, **header** | W2 close green | 2.3-home: `home.html`, `home.css`, `home-color.css` · 2.3-pricing: `pricing.html` · 2.3-inner: 7 inner html, `product`, `company`, `does`, `start` and `color-deep` css, the six `prices.js` script tags · header: `SiteFrameHeader.tsx`, `site-frame.css`, `site.css`, `mobile.css`, `js/site.js`, all of `home-up.css`, `js/home-up.js:64` (that toggle only) |
| W3 close | coordinator | all W3 landed | verification only (no new ledger rows), whole web Jest, then Docker 1 |

**CSS owner per file (SA-1174 K6).** One W3 owner per css file. Band roles ship in W2: 2.1b adds the white, bone and ink band classes (tokens only) to `site.css` and removes the tints at `mobile.css:36,39,43`, so the W3 page lanes change classes in html only. A page lane that needs a shared-css rule stops and reports.

| css file | W3 owner |
|---|---|
| `home.css`, `home-color.css` | 2.3-home |
| `product`, `company`, `does`, `start`, `color-deep` css | 2.3-inner |
| `home-up.css` (all) | header lane |
| `site.css`, `mobile.css` | header lane |

- Shared test-data files with per-lane rows (`lib/test-support/site-brand-exemptions.ts`, `site-repaint-1a`, `site-brand-tokens`, `site-speed-budget`): lanes build in parallel, land one at a time, each deleting only its own rows (spec-delta rev 4 item 7). Suggested landing: S2, 2.2, 2.1b, 2.1b-last; W3 any order. S2 before 2.2 is binding (SA-1174 A1 K14a: 2.2's sub-line test reads S2's tokenised page).
- 2.2 and S2 share no file; their contract (name from `og:site_name`, hub from `<template id="brand-symbol">` holding `<img src="{{brand:symbolOnDark}}" alt="">` drawn with `drawImage`, and ONE identical sub-line string in `home.html:114` and `rf-wheel-up.js:47`, compared by a static test 2.2 writes) is written into both briefs. The static still also uses `{{brand:symbolOnDark}}` (SA-1174 A1 K14b), and the T45 fixture gives that key its own value (K14c). The sub-line wording is owner-box item 1 (second box, K15).
- Share-image alt (SA-1174): `{{brand:name}}: {{brand:shareLine}}` (a colon, not a stop). S2 does home; the other pages go to lane 2.5 (W4, head markup).
- The wheel follow-up PR ("a grab stops the wheel glide") reaches this branch only through a later master catch-up: conflict expected in `rf-wheel-up.js` (2.2's lines); master wins on 84, `site-proof.ts`, `site-pins.static.test.ts`, `package.json`.

## Docker proof 1 (end of W3), first step
Build and start the local stack from the branch head (`npm run local:up`, production web image on :3001). Then run `handoff/proof-todo.md` in full before anything else: the six `/site/<page>.html` spellings for all ten pages (307 to the clean path with the query kept, no `{{brand:` in any body with or without `-L`, malformed escapes (`/site/%70ricing.html%`, `/site/pric%ing.html`) = 400, `/site/css/site.css` 200; the same over `next dev` once); the lead's exact curls; exactly one `id="brand-tokens"` style on `/`, `/pricing`, `/privacy`, `/login`, `/signup`, `/buyer/login` and a 404; `/favicon.ico` 200 `image/x-icon`; the API image boots and one platform mail shows the logo host and size. Then projects `site-proof`, `site-proof-wheel`, `site-type-alignment`, `site-waves`, `marketing` against :3001, in the heavy slot.

## Open questions (owner: SA lane unless marked)
- OQ-1 Ruled SA-1174 (K1): drawImage, not Path2D. One new `brand.json` key `symbolOnDark` (+ `index.ts` + the T45 fixture, granted to S2); the template holds `<img src="{{brand:symbolOnDark}}" alt="">`; the hub waits on `img.decode()`, sizes from `naturalWidth/Height`, draws no mark without an image; `MARKP` goes.
- OQ-2 Owner box (SA-1174): home lines that end with the name; recommended "X keeps every step in one place.", "What X does for you.", "What does X do?". Lanes wait.
- OQ-3 Ruled SA-1174 (K2): 2.1b-last gets `rf-graphics.css` + the `landing.html` token block as one commit after 2.2, and owns T21 (values read from `palette.json` at test time); spec-delta §5 amended.
- OQ-4 Ruled SA-1174 (K3): S2 edits the `prices.js` comments only; the six `<script>` tags are 2.3-inner's (W3, T43); spec-delta §5 wording fixed.
- OQ-5 Ruled SA-1174 (K4, reversed): each lane writes its own ledger change in its own commit, never lands while site-pins is red, deletes no pin, and lists each edited literal old -> new; step 0 raises the `site-color-and-life` baseline if red; close-out only verifies.
- OQ-6 Ruled SA-1174 (K5): yes; in one commit S2 swaps the `home.html` file row for the hex row and removes `<g class="mk">`.
- OQ-7 Ruled SA-1174 (K6): one W3 owner per css file (table above); band roles ship in W2 inside 2.1b; a page lane needing a shared-css rule stops and reports.
- OQ-8 Ruled SA-1174 (K7): the header lane owns all of `home-up.css` plus `js/home-up.js:64`; one observer in `js/site.js` replaces the hero-only toggle.
- OQ-9 Ruled SA-1174: B3 owns the three mailbox strings (built from `BRAND.name`) with their pins in one change; the switch timing is decided, owner-box item 3: on switch day, text and both console names together (owner box 2026-11-19 ~20:22Z).
- OQ-10 Decided (owner box 2026-11-19 ~20:22Z, item 2): the "Smaller plan" note is not true today; S2 deletes it now.
- OQ-11 Ruled SA-1174 (K8): the coordinator renames the budget test to `site-wheel-budget.static.test.ts` in step 0, keeping the suffix; the 2.2 brief's list follows.

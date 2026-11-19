# SA-1174 · site rebrand, waves 2 and 3: rulings on OQ-1..OQ-11, the planner's three contradictions, and T46/T48 · ruling

> [AMENDED 20:25Z by SA-1174 A1] K1: the static still also uses `symbolOnDark`; the T45 fixture gives it its own value. Owner box: item 1 not accepted (second box drafted by the rebrand seat); items 2-4 as recommended.

- SA-1174 · 2026-11-19T20:02Z · from the site-rebrand coordinator, via the lead. Facts read in the local rebrand worktree at c5d9f99700, and on origin/master 79d5702e4e for code truth.
- Brand-free: this file names neither the new name nor any path that carries it. "The budget test" means the branch's site budget test named after the new name; "the rebrand run dir" means the run's pipeline folder on the branch.
- **Ruled by the SA:** 12 items: OQ-1, OQ-3..OQ-8, OQ-11, PC-1..PC-3, and the T46/T48 ids (K1-K12).
- **Owner box:** OQ-2, OQ-10, and the OQ-9 console timing are three questions, plus the "Skip to plans" label (4 taps), recommendation first, through the lead.
- **Four things the briefs got wrong, now corrected:**
  - OQ-5's "red until close-out" is reversed.
  - T46a asserted the defect, so it is rewritten.
  - T48a's assertion is replaced.
  - `product.html:303` is false in code and goes now.
- **For the lead to file on master (not rebrand work):** the in-app downgrade warning tells the admin to "contact support ... to choose which users to keep", and no path can do that (K13).
- Tier: Quick (Architect, Bug skeptic and User advocate on Opus @high; SA chair).
- Vetoes upheld: a Path2D path in `brand.json` (Architect); T46a as written and "red until close-out" (Bug).
- Pack and seat notes: `panel/2026-11-19-site-waves/`. checked: 1-12.

## Facts (quoted)
| # | Fact | Where |
|---|---|---|
| F1 | "The wheel hub reads `<template id="brand-symbol">` into a `Path2D`". `brand.json` `symbol` is an image path. T43 wants the symbol as SVG. The hub on ink is "copper light", the reversed symbol's colour. | spec-delta:29, :116; ux-spec:189 |
| F2 | `product.html:303`: "Smaller plan. If you move to a smaller plan, staff or driver logins over its limit can be turned off. Admin logins stay on." | rebrand worktree `apps/web/public/site/product.html:303` |
| F3 | A downgrade over the cap frees every ACTIVE OPERATOR and DRIVER whose id is not in `retainedUserIds`. The web sends `retainedUserIds: []`. TENANT_ADMIN is kept. | origin/master `apps/api/src/billing/billing-cron.service.ts:543-567`; `apps/web/lib/api/billing.ts:467` |
| F4 | The in-app warning: "every operator and driver account will be deactivated ... Contact support before then to choose which users to keep." The downgrade route is `@NoImpersonation("billing")`, and no admin path writes `retainedUserIds` (Bug seat). | origin/master `subscription-mutation.service.ts:1286-1291`; `settings-billing.controller.ts:204` |
| F5 | site-pins: `now + rows == baseline - rows + rows`, per file. It counts literal pins and never compares their text. `e2eTitles` scans only e2e 36, 84 and 85, matching `^T\d+$`. The test is master-only until step 0. | origin/master `apps/web/app/(marketing)/site-pins.static.test.ts:59-71,82-87` |
| F6 | `.pbtn{margin-top:auto;width:100%}`, inside a flex column card. P01 is "pricing cards: button at card bottom, empty fill". | `site.css:183`; context-pack:76 |
| F7 | The P04 glow: `.home .hx-up .hx-over` in `mobile.css:42` paints a gold radial wash on the sticky layer under the header. `mobile.css` loads only ≤ 899.98 px. `home-color.css` has no gradient left. | `mobile.css:42`; `home.html:34`; `home-up.css:9` (Architect and User seats) |
| F8 | Test ids clash. test-plan T19/T20/T21 (wheel pixels, band table, box tokens) vs e2e 36's T19 (ready-made pages), T20 (hash focus, B1328) and T21 (motion). | test-plan:68-70; e2e 36:836-1677 |
| F9 | `hero-btn-in` is toggled only for the hero button (`js/home-up.js:64`). The P09 rules are at `home-up.css:92-99`. `SiteFrameHeader.tsx:53` hard-codes the class. | as cited |
| F10 | The only band rule is `.section.alt{background:var(--tint)}` (`site.css:80`). The tints live in `mobile.css:36,39,43`. | as cited |
| F11 | The exemption table has a `scope` field, and a `product.html` `hex` row already exists. | `lib/test-support/site-brand-exemptions.ts:24-40` |
| F12 | The budget test's key is its `-budget.static.test.ts` suffix (`site-page-read-pin.static.test.ts:39`). No code reads the rest of the name. | Bug seat |

## Rulings (SA)
- **K1 · OQ-1: drawImage, not Path2D.**
  - Amend spec-delta:29 and ux-spec:189.
  - Add one key, `symbolOnDark`, in `brand.json` + `index.ts` + the T45 fixture. It points at the reversed symbol's neutral file name. **Grant: S2**, a one-key exception to "must not touch `packages/types/brand/*`".
  - The template holds `<img src="{{brand:symbolOnDark}}" alt="">`.
  - The hub waits on `img.decode()`, sizes from `naturalWidth/Height`, and with no image draws no mark. Never a typed fallback. The typed mark `MARKP` goes.
  - The name swap stays "2 JSON lines + 13 assets": the new key's value is a neutral file name the swap overwrites.
- **K2 · OQ-3:** grant **2.1b-last** `rf-graphics.css` (retired aliases) + the `landing.html` token block, as one commit after 2.2 lands. Add it to spec-delta §5's W2 row.
  - It also owns **T21** (test-plan), whose tokens live in `rf-graphics.css`. T21 compares against `palette.json` values read at test time, never typed hex.
- **K3 · OQ-4:** S2's part is the comments in `prices.js` only. The six `<script>` tags on pages with no `[data-plan]` (company, contact, data-in-and-out, does-and-doesnt, getting-started, security) are **2.3-inner** (W3, T43). Fix spec-delta §5's W2 wording.
- **K4 · OQ-5 (reversed): the ledger moves with each lane, and no lane lands while site-pins is red.**
  - Step 0: run site-pins right after the catch-up. If `site-color-and-life` reads above its baseline (29 vs 26 expected after 2.1a), raise that baseline to the merged count **in the step-0 commit**, citing the 2.1a commit, with the added pins listed.
  - In W2 and W3, a lane that adds a counted pin raises the baseline in its own commit, listing the pins. A lane never deletes a pin. If a pin must go, stop and report.
  - Every lane report lists each edited pin literal, old → new. The reviewer confirms none got weaker; that is the only check on edits (F5).
  - Lanes never edit master's guard.
  - The close-out commit only verifies; it writes no new rows.
- **K5 · OQ-6:** yes. In one commit S2 swaps its `home.html` `file` row for `{ path: "public/site/home.html", scope: "hex", liftedBy: "W3", lane: "2.3-home" }` and removes `<g class="mk">`, because a hex row does not exempt the typed mark.
- **K6 · OQ-7: one W3 owner per css file, and band roles ship in W2.**
  - **2.1b (W2)** adds the band role rules (white, bone and ink band classes, tokens only) to `site.css` and removes the tints in `mobile.css:36,39,43`, so the W3 page lanes change classes in html only.
  - W3 owners:
    - `home.css` and `home-color.css` → **2.3-home**;
    - `product`, `company`, `does`, `start` and `color-deep` css → **2.3-inner**;
    - `home-up.css` → **header lane** (K7);
    - `site.css` and `mobile.css` stay with the header lane.
  - A page lane that needs a shared-css rule stops and reports.
- **K7 · OQ-8:** the **header lane** owns all of `home-up.css` in W3, plus `js/home-up.js:64` (that toggle only).
  - Build one observer in `js/site.js`: "the header trial pill is hidden while any other trial button is in the viewport".
  - Delete the hero-only toggle at `home-up.js:64`, so only one script toggles the class. `SiteFrameHeader.tsx:53` follows.
- **K8 · OQ-11:** the coordinator renames the budget test in step 0 to `site-wheel-budget.static.test.ts`, keeping the suffix (F12), and drops its pipeline-path comment. Fix the 2.2 brief's "green by path" list. If master later adds the same file, master's copy wins.
- **K9 · PC-1: 2.1b owns the P04 glow** (`mobile.css:42`, F7), already inside its T18a gradient count. Spec 89 adds the P04 assertion at `/` 393: no gradient on `.hx-over`. Prove it red at base by turning off that one rule (observe and report).
- **K10 · PC-2: id scheme.**
  - Test-plan ids stay plain (`T19`). Every brief cites e2e 36's own ids as `36:T19`, `36:T20` and `36:T21`. e2e 36 is never renamed (master wins).
  - Edit the S2 brief (`e2e36 T19` → `36:T19`), the header brief (`36:T20`), the README table and spec-delta:16, :102 and :128.
  - Because `e2eTitles` scans only 36/84/85 (F5), no W2/W3 ledger row may use `replacedBy`; K4 forbids deletions anyway. A spec-qualified `replacedBy` is a LATER change on master.
- **K11 · PC-3: the header sign-in and focus pins, by exact path:**
  - `components/site-frame/site-frame.test.tsx:29,68-81`;
  - `app/(marketing)/marketing-port.static.test.ts:318-320,331`;
  - `app/(marketing)/site-auth-nav.static.test.ts` (whole file);
  - e2e `36:1327` (`36:T20`).
  - "Unedited" means `git diff --stat <lane base>..HEAD -- <those paths>` prints nothing. This binds 2.1b and the header lane.
- **K12 · New ids T46a/b and T48a-d are unique, with these corrections.** Each is shown red at its lane base (or fault-injected red) before any fix:
  - **T46a, rewritten.** P01 is the empty fill above the button (F6), so assert: on each plan card at 1440×900 and 393×844, the gap between the card's last content block and its button is ≤ 32 px. It is red today on the shortest card. If it is not red at base, close P01 with that evidence.
  - **T46b, defined.** From a fresh load of `/pricing`, using Tab and Enter only, at most 3 key presses put focus on the first plan's `.pbtn`. If that is already true at base (`#main` opens on the plans), close F04 with the evidence and add no new link.
  - **T48a, replaced.** "While any trial button other than the header pill is in the viewport, the header pill is not visible" (D-2). No total count; stacked plan cards are not the header's.
  - **T48b:** as written.
  - **T48c:** as written.
  - **T48d:** keep it as a guard, with a self-check. An `addStyleTag` that makes the header `position:static` must turn it red.

## Also ruled (found by the seats)
- **The wheel sub line:** the S2 and 2.2 contract pins ONE identical string, in both `home.html:114` and `rf-wheel-up.js:47`, from owner Q1. A static test compares the two.
- **Share-image alt:** today it is `{{brand:name}}. {{brand:shareLine}}` (a double-stop risk with a dotted name). Change it to `{{brand:name}}: {{brand:shareLine}}`. S2 does home; the other pages go to lane 2.5 (W4, head markup).
- **D0 console list:** add the Google OAuth consent-screen app name and the Microsoft app registration display name (spec-delta §2a covers only the origin). OQ-9 depends on both.
- **OQ-9 ownership:** **B3** owns the three mailbox strings, built from `BRAND.name`, together with their pins (`mailbox-connection.service.spec.ts:578`, `MailboxCard.test.tsx:61,65,481`, `e2e/mailbox-connect.spec.ts:89,92`, and the `MailboxCard.tsx:178` comment), in one change. When it switches is owner Q3.

## Owner box (one box; the lead sends it; recommendation first)
1. **Home lines that end with the name.** Recommended: "X keeps every step in one place." (wheel line and home), "What X does for you." (section heading), and "What does X do?" (FAQ, matching Pricing). [Use these] · [Use "Every step is in X, start to finish."]
2. **Product page, the "Smaller plan" note.** It is not true today: a smaller plan turns off EVERY staff and driver login, not only those over the limit, and nobody can choose who stays. Recommended: delete it now and add a true line after the downgrade chooser is fixed (K13). [Delete it] · [Write a true warning now]
3. **Mailbox help text after the switch.** It names the app as Google and Microsoft list it. Recommended: rename the app in both consoles on switch day, with the text switching the same day; until then the old name stays in those three sentences. [Same day] · [Keep the old name for now]
4. **Pricing keyboard link label.** Recommended: "Skip to plans", but only if T46b shows it is needed. [Skip to plans] · [Skip to prices]

## K13 · For the lead to file on master (brand-free; not rebrand work)
- The downgrade warning promises a choice that does not exist (F3, F4). Every staff and driver login is turned off, and "contact support to choose" has no path. File it as a billing bug, high: a chooser that sets `retainedUserIds`, or true text plus the support path.
- `prices.js:5-6` (SA-1080) says seats are "not enforced". They are enforced at downgrade. Fix the comment when the bug lands. Whether the site should show seat limits is a later owner question; it is not asked now.

## Dissent and choices on record
- **OQ-10:** the User seat proposed "Email us before you move to a smaller plan. We'll help you choose who keeps access." The Bug seat showed that no support path can keep anyone (F4), so that line is not true either. The chair recommends deletion, and the owner may still ask for a true warning.
- **PC-2:** the Bug seat wanted a prefix on every id; the chair takes the Architect's form (plain test-plan ids, `36:` for e2e 36) as fewer edits with the same clarity.
- **OQ-11:** the Architect named the new file and the Bug seat required the suffix; both are met.
- **The S2 copy rule:** "no sentence with logins + plan or limit" bans a true warning. Replace it with "no number next to login/logins/seat/seats on a served page" (the SA-1080 A-1 intent), plus T41's "differ by customers" rule.

## Case table
| Check | Expected | Status |
|---|---|---|
| site-pins right after step 0's catch-up | green, or the `site-color-and-life` baseline raised in the step-0 commit | observe and report (K4) |
| the hub with `symbolOnDark` set, at 1440 and 393 | the reversed mark drawn; no typed path | observe and report (K1) |
| the hub with no template | no mark, nothing thrown | observe and report (K1) |
| T46a at the 2.1b base | red on the shortest card, or P01 closed | observe and report (K12) |
| T46b at the 2.3-pricing base | red, or F04 closed and no link added | observe and report (K12) |
| T48d with the header forced static | red | observe and report (K12) |
| `/` at 393 with the `mobile.css:42` rule off | no glow under the header | observe and report (K9) |
| the copy rule over all served pages | no number next to login/seat | observe and report |

## Pins kept or superseded
- **KEPT:**
  - the T35/T45 seam rules;
  - the swap rule "2 JSON lines + 13 assets";
  - master wins on harness files (84, `site-proof.ts`, site-pins, e2e 36);
  - SA-1080 A-1 (no login numbers on the site);
  - the D-2 rule;
  - the shared exemption tables landed one at a time.
- **AMENDED:**
  - spec-delta:29 (Path2D → drawImage) and ux-spec:189;
  - spec-delta §5's W2 row (2.1b-last's files; S2's `prices.js` part);
  - spec-delta §5's "the pin ledger is written only in each wave's close-out commit" (now K4);
  - the T19/T20 citations (K10).
- **SUPERSEDED:**
  - README OQ-5's default;
  - T46a, T46b and T48a as written in the briefs;
  - S2's proposed copy rule;
  - S2's `product.html:303` "SA may give wording" (now owner Q2).

## Design Gate (Lite) — SA-1174 site rebrand waves 2 and 3 · 2026-11-19 · base c5d9f99700
- G1 Fit: the site rebrand program, waves 2 and 3. Extends `apps/web/public/site/js/prices.js:5` (SA-1080) and `apps/web/app/(marketing)/site-pins.static.test.ts:82` (the pin guard, read only); facts read at c5d9f99700 and origin/master 79d5702e4e.
- **Area sweep:** every open question in the briefs' README, the three planner contradictions, and the six new ids.
  - Added: the share-image alt, the D0 console names, the wheel-line twin, the copy rule, and the billing bug (K13).
  - Deferred: a spec-qualified `replacedBy` (LATER, master) and the seat-limit display question (owner, later).
- **G2 Variation:**
  - Visitors at 1440 and 393: BUILD NOW.
  - Keyboard users: BUILD NOW (T46b, T48).
  - Tenant admins: K13 is filed (mailbox text, the downgrade).
  - N/A: tenants by business type.
  - SEAM NOW: `symbolOnDark`, for any dark surface.
- **G3 Replace-later:** nothing built here is replaced. drawImage survives the SVG symbol and the name swap, and the band role classes serve W4 and W5.
- **G4 Class:** one owner per file per wave (K2, K3, K6, K7); one id per test (K10); one ledger rule (K4). Red: T46a, T46b, T48a and T48d are each proven red before the fix.
- **G5 Data & time:** no schema. Pin baselines only rise, each with its pins listed. The step-0 baseline is fixed before any lane starts.
- **G6 Scale:** no runtime cost beyond one image decode for the hub.
- **G7 UX:** visitors read only true sentences (Q2), one trial button at a time (K7, T48a), and a working keyboard path to plans (T46b).
- G8 Change: carried by the brand keys and the band classes. Future: another dark surface → XS (`symbolOnDark`). Future: the name swap → XS (unchanged). Future: the spec-qualified ledger → S.
- **G9 Cost:** edits to the briefs plus one key. No lane grows past its brief size; K6 moves the band roles to 2.1b (S).
- G10 Owner questions: one box of 4 taps, through the lead.

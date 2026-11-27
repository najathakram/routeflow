# Panel pack · SA-1174 · site rebrand wave 2/3 open questions · Quick · tree head c5d9f99700 · 2026-11-19T19:51Z

BRAND RULE: the new name lives only on the local rebrand branch. Write it nowhere: not in your notes, your report or any quote. Say "the new name". Never open or print `.git/info/leak-patterns`. Read-only: never edit, commit, stash, switch or push in any tree.

`<WT>` = the rebrand worktree, and `<RUN>` = `<WT>/.claude/pipeline/<run dir>`; your prompt gives both paths. Read in this order:
1. `<RUN>/briefs/README.md` (OQ-1..OQ-11);
2. the 7 lane briefs beside it;
3. `<RUN>/spec-delta-2026-11-14.md` §1, §3, §5, §6;
4. `<RUN>/test-plan.md`;
5. `<RUN>/HANDOFF-2026-11-19.md`;
6. `<RUN>/handoff/context-pack.md`, row P04.

## Chair facts (verified in `<WT>` at c5d9f99700, or on origin/master in `C:/ClaudeCode/routeflow`)
| # | Fact | Where |
|---|---|---|
| F1 | spec-delta §1: "The wheel hub reads `<template id="brand-symbol">` into a `Path2D`". `brand.json`'s `symbol` is an image path (a PNG today). §4 T43 wants the "logo, symbol and end-mark as SVG". | spec-delta:29, :116; README OQ-1 |
| F2 | `product.html:303`: "Smaller plan. If you move to a smaller plan, staff or driver logins over its limit can be turned off. Admin logins stay on." | `<WT>/apps/web/public/site/product.html:303` |
| F3 | On master the plans DO carry seat caps (`seatsIncluded` 3 / 10 / 25). A downgrade over the cap sets `seatAckRequired`, and its warning says "every operator and driver account will be deactivated when the downgrade takes effect. Contact support before then to choose which users to keep." The count includes TENANT_ADMIN. | origin/master `apps/api/prisma/plan-catalog-v11.definitions.ts:97,110,123`; `apps/api/src/billing/subscription-mutation.service.ts:165-171,1275-1291` |
| F4 | `prices.js:5-6` (SA-1080): "plans differ by price and customers included only. Seats, routes, scans and messages are not shown (not enforced, or not available to a trial)". The lead's card: "SA-1080 A-1: no login numbers on site." S2's proposed copy rule: "no sentence with 'logins' plus 'plan' or 'limit' on any served page". | `<WT>/apps/web/public/site/js/prices.js:5-6`; S2 brief §2 |
| F5 | The exemption table has a `scope` field. A `hex` row already exists for `product.html` (`liftedBy: "W3", lane: "2.3-inner"`). No `home.html` hex row exists. | `<WT>/apps/web/lib/test-support/site-brand-exemptions.ts:24-40` |
| F6 | The P09 rules live in `home-up.css` under a "phone header" comment: `.js .site-header.hero-btn-in .nav-price{display:inline-flex}`, `... .btn-sm{display:none}`, and the menu-open line. | `<WT>/apps/web/public/site/css/home-up.css:92-99` |
| F7 | P04, per context-pack:75: "orange glow under header; ~130 px gap ...". "glow: WP2.1 (home-color.css, bp:239) though ux:172 says WP1.2; gap: WP1.2". spec-delta §3 gives "P04 gap" to WP1.2 and "P04 glow" to 2.1b. The 2.1b brief owns site, mobile, home and home-up css, but NOT home-color.css (a 2.1a file, W1b, done). | `<RUN>/handoff/context-pack.md:75`; spec-delta:100,106; ux-spec:172; W2-2.1b brief §1, §3.5 |
| F8 | Test-id clashes. test-plan T19 is the wheel button pixels, but e2e 36's "T19" is the ready-made pages, used by S2's brief as "e2e36 T19". test-plan T20 is the band table, but e2e 36's "T20" is the hash-anchor focus test (B1328), cited by the header brief. test-plan T21 is the box/app/buy tokens (static); no wave 2/3 brief assigns T21, though spec-delta §5 W3 lists "T20, T21, T46-T48". | `<RUN>/test-plan.md:68-70`; `<WT>/apps/web/e2e/36-*.spec.ts:836-951`; spec-delta:129 |
| F9 | The site budget test in `<WT>` is named after the new name (`site-<new-name>-budget.static.test.ts`). origin/master has no `site-wheel-budget` test. | `<WT>/apps/web/app/(marketing)/`; `git ls-tree origin/master` |
| F10 | The header brief §2 lists the "header sign-in and focus pins that must stay green, unedited": `site-frame.test.tsx` (phone menu links; `a.nav-signin` targets), `marketing-port.static.test.ts` (`:focus-visible` 3 px ring; no `.signin-menu` emitter), `site-auth-nav.static.test.ts`, and e2e 36 T20 (`36:1327`). | W3-header brief §2 |

## The 14 items to rule on (README OQ-1..OQ-11 + three planner contradictions)
- OQ-1: the hub symbol (Path2D vs drawImage of the image).
- OQ-2 (owner): wording for sentences that end with the name.
- OQ-3: 2.1b-last edits `rf-graphics.css` and the `landing.html` token block, neither in §5's W2 list.
- OQ-4: "`prices.js` tags" for S2 is undefined.
- OQ-5: pin-ledger timing; lanes leave `site-pins` red until close-out.
- OQ-6: the `home.html` hex exemption row.
- OQ-7: W3 has no CSS owner for home.css, home-up.css, home-color.css or the inner pages' css.
- OQ-8: the P09 rules in `home-up.css:92-99`, proposed for the header lane.
- OQ-9: the API mailbox strings that type the old name (`apps/api/src/email/mailbox/mailbox-connection.service.ts:791-792,824`), proposed for B3.
- OQ-10 (owner): `product.html:303`, "Smaller plan." vs SA-1080 A-1 (F2-F4).
- OQ-11: the budget test (F9).
- PC-1: who owns the P04 glow (F7).
- PC-2: T19/T20/T21 each mean two things (F8).
- PC-3: "header sign-in focus pins" undefined (F10).
- Also confirm the new test ids T46a/T46b (2.1b and 2.3-pricing) and T48a-d (header).

## What each seat must do
For each item: verify the facts your seat cares about, give a ruling (one line), and flag whether the owner must decide. Find what the briefs missed. Cite path:line. Mark anything unrun as "observe and report". Return ≤ 900 words: an item table (item, ruling, owner y/n, why), conditions, and any veto. No brand name anywhere.

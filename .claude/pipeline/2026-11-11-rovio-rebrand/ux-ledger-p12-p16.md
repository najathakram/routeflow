# UX ledger rows P12-P16 (split from the apple-ux quick run, spec-delta-2026-11-14 section 3)

Source: `C:/Users/nakram/apple-ux-evidence/routeflow/2026-11-13-marketing-quick/` — `synthesized.json` (ids P01-P16 with file/fix/acceptance; `final.json`'s `vitalFew` keeps only P01-P07, P10, P11, F03, F05, so P12-P16 are NOT in final.json), `polish.json` (`polish[]` has 15 unnumbered rows; P12-P16 are its last five, in order). No `report.md` exists in that folder. All five are `severity 1`, `effort S`, `quality A6`, `verdict CONFIRMED`, persona `polish-judge`, reach 1. Screenshots were not opened: each row's evidence is a text quote, and the meaning is clear. Paths below are relative to `apps/web/public/site/` in `C:/ClaudeCode/wt/rovio-site` unless marked APP.

All five are real small type/alignment items. Two have a caveat (P12 file is outside the site folder; P15's review root cause is partly wrong, see its row).

New test ids continue at T49 (grep of the pipeline folder: no T49+ in use). One new spec file holds all five browser tests so no row edits the WP1.1-owned `85-site-proof-pages.spec.ts` or `helpers/site-p*` (master wins there): `apps/web/e2e/86-site-type-alignment.spec.ts`, reusing `boxOf`/`rectOf` from `e2e/helpers/site-proof.ts`. Heavy slot, `next dev`, per the wave-3 rule. Each test is red on today's code and is written first.

Package check: no two rows put two packages on one file in one wave. Same-package rows share a file only where noted.

## P12 - signup terms line is centred and strands "Policy."
- **Page / viewport:** `/signup`, 1440x900.
- **Visitor sees:** the small "By signing up you agree to our Terms of Service and Privacy Policy." line sits centred under a left-aligned form, and its last line holds only "Policy."
- **Evidence:** polish.json `polish[10]` / synthesized.json P12: `Centred terms line under "Create account", wrapping "Policy." alone onto line 2`; screenshot `shots/sarah-21.jpg`.
- **File:** APP, not the site folder: `apps/web/app/(auth)/signup/page.tsx:430` (`<p className="mt-4 text-center text-xs text-navy/70">`). The review cited `:428`; in this worktree the `<p>` is at 430. Fix: drop `text-center`, add `text-pretty` (Tailwind `text-wrap: pretty`).
- **Owner:** 2.6 front door (wave 2). Same package and file as P11 (`:396`), so one package on this file. Header trial button on this page is P10 (header lane, other file). No conflict.
- **Acceptance (measurable):** at 1440x900 the terms `<p>` has computed `text-align` `left` or `start`, and its last rendered line holds at least 2 words (Range client rects: last line is not a single word).
- **Test T49:** `86-site-type-alignment.spec.ts` > "P12 signup terms line left-aligned, no lone last word". Red today: computed `text-align` is `center`, and the last line is the lone word "Policy.".

## P13 - Pricing eyebrow is plain text at 1440, a pill at 393
- **Page / viewport:** `/pricing`, 1440x900 (compare 393x844).
- **Visitor sees:** the word "Pricing" above the headline as plain blue text on desktop but a lilac pill with a dot on a phone; Product and Home use a pill at desktop.
- **Evidence:** synthesized.json P13: `"Pricing" eyebrow above the headline, plain blue text (pill with a dot on Pricing 393 jo-2.jpg and on Home/Product 1440)`; screenshot `shots/sarah-07.jpg`; `file: css/site.css:61 (.eyebrow)`.
- **Verified cause:** `pricing.html:94` uses `<p class="eyebrow">`. At 1440 only `css/site.css:61` styles it (plain `var(--rf-link)` text). The pill rule is `css/mobile.css:37-38` (`.pg-top .eyebrow`), and `mobile.css` is linked with `media="(max-width:899.98px)"` (`pricing.html:29`), so it never reaches desktop. Home and Product get their desktop pill from other sheets (`css/color-deep.css:15` `.pd .kick`, `css/home-color.css:12`), which `pricing.html` does not link.
- **Fix:** move the pill rule from `mobile.css:37-38` into `site.css` (unconditional, next to `:61`), delete it from `mobile.css`. Use palette tokens, not literal hex (`#dad9f7`, `#312f78`, `#6261af` are kit colours; T35d bans them in the CSS after the rebrand).
- **Owner:** 2.1b CSS (wave 2), which owns both `site.css` and `mobile.css`. One package. (2.1a in wave 1b touches `color-deep`/`home-color`, not these.)
- **Acceptance (measurable):** `.pg-top .eyebrow` has the same computed `display`, `border-radius` (>= 999px), `padding`, `font-size` and a non-transparent `background-color` at 1440x900 and at 393x844.
- **Test T50:** `86-site-type-alignment.spec.ts` > "P13 pricing eyebrow identical at 1440 and 393". Red today: at 1440 `display` is `block`, `background-color` is `rgba(0, 0, 0, 0)` and `border-radius` is `0px`, unlike 393.

## P14 - pricing table header cells do not share a baseline at 393
- **Page / viewport:** `/pricing`, 393x844.
- **Visitor sees:** in the compact plan table, "From, a month" and "Each year" take two lines while "Plan" and "Customers" take one, and the one-liners float mid-cell.
- **Evidence:** synthesized.json P14: `Table header row: "From, a month" / "Each year" wrap to two lines while "Plan" / "Customers" are one line`; screenshot `shots/jo-2.jpg`; `file: pricing.html:102 (thead) + css/site.css:245 (.pl th)`.
- **Verified:** the thead is `pricing.html:106` (not 102): `<th>Plan</th><th>Customers</th><th class="plp">From, a month</th><th class="ply">Each year</th>`. Header rules: `css/site.css:249` (`.pl thead th`) and `:257` (`.pl--y thead th{... white-space:normal}`), inside the `<900px` block that starts near `:243`. No `vertical-align` is set, so cells default to `middle`. Fix: `vertical-align:bottom` on `.pl thead th` at `site.css:249`.
- **Owner:** 2.1b CSS (wave 2); `site.css` only. `pricing.html` is not touched, so 2.3-pricing is not involved. Same package as P01/F04 CSS on the same file: fine.
- **Acceptance (measurable):** at 393x844 the bottom edge of the last text line (Range rect) of all four `thead th` is equal within 1 px.
- **Test T51:** `86-site-type-alignment.spec.ts` > "P14 plan-table headers share a bottom baseline at 393". Red today: one-line headers' text bottoms sit roughly half a line (about 8 px) above the two-line ones.

## P15 - Product headline ends on a lone "does."
- **Page / viewport:** `/product`, 1440x900.
- **Visitor sees:** the big headline breaks as "What RouteFlow" over "does." with a one-word second line.
- **Evidence:** synthesized.json P15: `Display headline "What RouteFlow / does.", the one-word second line`; screenshot `shots/key-product-1440.jpg`; `file: product.html:79`.
- **Verified, with one correction:** `product.html:79` is `<h1 id="pd-h">What RouteFlow does.</h1>`. The review says `text-wrap: balance` only applies under 900 px (`mobile.css:18`). It also applies globally: `css/site.css:62` sets `h1{... text-wrap:balance}`. Balancing a three-word line still leaves a short last line, so the item stands, but the cause is the narrow column, not a missing rule. `.nb{white-space:nowrap}` exists only in `mobile.css:16` (phones), so the fix needs it defined for desktop too, or an inline equivalent. Fix: wrap the brand-and-verb in a nowrap span (`What <span class="nb">RouteFlow does.</span>`) and define `.nb` in `site.css` (this stays correct after the rename, since it wraps the name rather than hard-coding it). Check the span still fits the column at 1440; if not, fall back to a CSS-only width on `.pd-copy h1`.
- **Owner:** 2.3-inner (7 html, wave 3) owns `product.html`; `.nb` in `site.css` is a 2.1b one-liner (wave 2). Two packages, but two files and two waves, so no same-file conflict. `product.html` is also touched in wave 0 (S1 seam) and wave 1b (1.3b-pages) for other edits; waves differ. Unavoidable only if `.nb` is put in `product.html` inline instead; do not.
- **Acceptance (measurable):** at 1440x900 `#pd-h` renders on at most 2 lines and its last line holds at least 2 words (Range rects), with the h1 fully inside its column (`scrollWidth <= clientWidth`).
- **Test T52:** `86-site-type-alignment.spec.ts` > "P15 product headline has no one-word last line at 1440". Red today: last line is the single word "does.".

## P16 - Product diagram card top is not on the eyebrow's top line
- **Page / viewport:** `/product`, 1440x900.
- **Visitor sees:** the loop-diagram card starts about 50 px higher than the "Product" label and headline beside it, so the two columns do not share a top edge.
- **Evidence:** synthesized.json P16: `Cycle-diagram card top edge (y≈140) vs the left column's "Product" eyebrow (y≈190)`; screenshot `shots/key-product-1440.jpg`; `file: product.html hero + css/product.css`.
- **Verified:** the grid is `css/product.css:16` (`.pd-top-in{display:grid; ... align-items:center}`), so the 520 px square `.lp` card (`product.css:24`, `product.html:87`) is vertically centred against the shorter text column. Fix: `align-items:start` at `product.css:16` for >= 900 px (the one-column phone rule at `:134` is unaffected).
- **Owner:** 2.1a (wave 1b) is the only package that owns `product.css`; it is a colour package, so this is a small layout add-on to it (flag for the lead). 2.1b does not list `product.css`. No same-file conflict.
- **Acceptance (measurable):** at 1440x900 `|top(.lp) - top(.pd-copy .kick)| <= 2 px`.
- **Test T53:** `86-site-type-alignment.spec.ts` > "P16 product diagram card top aligns with eyebrow". Red today: difference is about 50 px (card y about 140, eyebrow y about 190, per the review).

## Summary table
| Id | Page @ viewport | File:line (verified) | Package (wave) | Test |
|---|---|---|---|---|
| P12 | /signup @1440 | APP `signup/page.tsx:430` | 2.6 (2) | T49 |
| P13 | /pricing @1440 vs 393 | `css/site.css:61` + move `css/mobile.css:37-38` | 2.1b (2) | T50 |
| P14 | /pricing @393 | `css/site.css:249` (and `:257`) | 2.1b (2) | T51 |
| P15 | /product @1440 | `product.html:79` + `.nb` in `site.css` | 2.3-inner (3) + 2.1b one-liner (2) | T52 |
| P16 | /product @1440 | `css/product.css:16` | 2.1a (1b) | T53 |

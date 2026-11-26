# Context pack: Rovio branded site build (2026-11-14)
Read-only scan of branch `rebrand/rovio-site` (HEAD 00ec11d53; merge-base 5fc866853; 44 commits behind master).
Plan dir P = `.claude/pipeline/2026-11-11-rovio-rebrand/` (bp=build-plan.md, sp=spec.md, ux=ux-spec.md, tp=test-plan.md, di=discovery.md). Site dir S = `apps/web/public/site/`.
"Brand-free" = no name/logo/colour/wording. No recommendations below.

## 1. Packages after WP1.1 (line numbers in build-plan.md unless noted)
Per-package size is NOT stated; only phase sizes (bp:41-47): P1 L, P2 XL, P2A M, P3 S.
| id | goal | files/areas | dependsOn | risk | brand? |
|---|---|---|---|---|---|
| WP1.2 bp:149 | wheel fits, one pose/weight, legend replaces canvas names, words column never empty, end-state button, print branch | rf-wheel-up.js/.css, home.html, home-up.css, 5 static tests, new pin ledger | WP1.1 | high | brand-free (colours/shadows excluded, bp:220) |
| WP1.3a bp:222 | wording audit, read-only; output copy-ledger.md | rendered text of live site | none | low | brand-free (names stay RouteFlow) |
| WP1.3b bp:222 | apply approved ledger | 10 html, privacy/terms, site-frame strings, tests | 1.3a approval + WP1.2 | low | wording only, no name change |
| G1 bp:228 | gate: apple-ux, apple-design, pre-merge-review | - | WP1.1-1.3 | - | - |
| WP2.0 bp:231 | token block + palette json + logo/icon files | rf-graphics.css, NEW packages/ui/src/tokens/rovio-palette.json, NEW img/rovio-* svg/png | gate G1 | low | BRAND (colour, logo) |
| WP2.1 bp:236 | repaint/flatten all site CSS | 10 css files + site-frame.css | WP2.0 | medium | BRAND (colour) |
| WP2.2 bp:242 | wheel coloured by role | rf-wheel-up.js/.css | WP2.0 | medium | BRAND (colour) |
| WP2.3 bp:248 | sections/pictures, 9 pages | 9 html (inline styles/SVG) | WP2.1 | medium | BRAND (colour) |
| WP2.4 bp:253 | landing page | landing.html (213 colour literals) | WP2.0 | low | BRAND (colour) |
| WP2.5 bp:257 | logo, icons, share image, the NAME, email | 10 html, rf-wheel-up.js (4 strings), home-up/site/prices.js, SiteFrame.tsx, SiteFrameHeader.tsx, site-frame-nav.ts, lib/site.ts, lib/metadata.ts, opengraph-image, sync-site-port.mjs, name tests | WP1.3b, WP2.2-2.4 | medium | BRAND (name, logo, email) |
| WP2.6 bp:263 | signed-out React pages (privacy, terms, 404, login, signup, reset, buyer login) | (marketing)/layout, privacy, terms, marketing.css, glass*.css, not-found, (auth)/*, buyer/login, AuthShell, favicon move; sweeps B247/B248/B520/B550 | WP2.0 | medium | BRAND (name, logo, colour) |
| WP2A.0 bp:269 | API accepts either web origin (`WEB_ORIGINS`) | apps/api auth.controller, payment-due.service, return-URL builders | none | high | brand-free; goes to MASTER early (bp:274) |
| WP2A.1 bp:276 | serve current app on www.xrovio.com (DNS, CORS, Google, Stripe, Umami, WEB_ORIGINS); no code | settings | WP2A.0 live on prod | high | brand-free (hostname only) |
| WP2A.2 bp:288 | redirects + `site.origin` + canonical/og host | next.config.mjs, lib/site.ts, 10 html, layouts, sync script, host tests | WP2.5 | medium | domain-bearing |
| WP2.7 bp:316 | proof + gates G-U,G-D,G-W,G-I,G-O | local stack from branch head | WP2.1-2.6 | - | - |
| WP3.1 bp:320 | launch day | merge commit, WEB_URL flip | all | - | launch |
| WP3.2 bp:329 | weekly T24, permanent redirects, "formerly" ticket, code map/lessons | - | WP3.1 | - | launch |
| Program B, B1-B5 (program-b-app.md:40-46) | OUTLINE only, not a plan: B1 sign-up emails + browser identity; B2 tokens + logo in app web; B3 words/emails/documents; B4 mobile; B5 billing names/notice | apps/api email, apps/web, mobile | after Program A (B1 on launch day) | medium | all BRAND |

## 2. What can start today
Can start on the branch without a master merge or WP1.2: WP1.3a (bp:224 "starts on day one"; its input folder `local-assets/.../live-now/text/` is not on disk, see 6); WP2A.0 (dependsOn none; lands on master, brand-free; its own dev-pipeline run, bp:270). WP2A.1 needs WP2A.0 live on prod (bp:277).
Declared deps: WP2.0 waits on "gate G1 passed" (bp:232); WP2.2, WP2.4, WP2.6 depend only on WP2.0 (bp:244,254,264), though WP2.2 edits the same wheel files as WP1.2 ("most pinned file", bp:151).
Must wait: WP1.3b (1.3a approval + WP1.2); WP2.5 (1.3b, 2.2-2.4); WP2A.2 (2.5); WP2.7 (2.1-2.6). Branch rule: merge master in daily, never rebase (bp:49-53); WP1.1 and WP1.2 now land on master, so the branch must take them before packages touching rf-wheel-up.js, home-up.js, site.js, css.
Branch state: WP0 done (commits a54115df2, 00ec11d53); e2e 84/85 specs, `site-rovio-budget.static.test.ts`, `site-pin-ledger.json` exist. Branch diff vs master in S: only rf-wheel-up.js (+2/-2, the `cam()` hook).

## 3. Where the brand lives today (branch, grep counts)
- "RouteFlow" (`route\s?flow`, case-insensitive) in S: 250 hits / 18 files: home.html 43, does 28, product 27, pricing 24, company 24, data 22, security 21, contact 20, getting-started 17, landing 13; rf-wheel-up.js 4; 1 each in site.css, home.css, rf-graphics.css, rf-wheel-up.css, home-up.js, prices.js, site.js. (di E19 says 172 at base; counting differs.) Site frame: SiteFrameHeader.tsx:54,57 (aria-label + typed `<span>RouteFlow</span>`), SiteFrame.tsx:46 (typed span), :83 ("© 2026 RouteFlow"). `site.name` lib/site.ts:13; typed name in route descriptions lib/site.ts:35-66 and demoEmail :135-139. privacy 56 / terms 26 strings (di E19).
- Logo: `img/routeflow-mark-64.png` (4 KB), `-192.png` (26 KB). `routeflow-mark` references: 54 hits / 17 files in apps/web: html pages 2-6 each (home 6, product 4), SiteFrameHeader.tsx, SiteFrame.tsx, app/layout.tsx (5, app-owned), buyer/layout.tsx (2), components/brand/BrandMark.tsx (+test), marketing-port.static.test.ts (6). Header/footer logo today = PNG mark + typed text span, not an SVG wordmark.
- Colour: retired tokens (`--rf-brand-*, --rf-sun, --rf-coral, --rf-mint, --rf-ink-2/3, --rf-sh-*, --pc-*, --fld-*, --navy, --sun`): 91 `var()` uses / 10 files: home.css 35, home-color 15, color-deep 13, rf-graphics 7, site.css 7, rf-wheel-up.css 6, home-up.css 4, product 2, landing 1, site-frame.css 1 (plan says about 125, di E17). Token block `graphics/rf-graphics.css:5-25`; landing.html carries a copy inline (sp:180). Wheel canvas colours are literals in rf-wheel-up.js.
- Domain `routeflow.info` in apps/web (scan hit its time limit; incomplete): S html 77 / 10 pages (home 14, contact 10, pricing 9, getting-started 8, product 7, company 7, data 6, security 6, landing 5, does 5); lib/site.ts 3; privacy/page.tsx 8; terms 2; site-frame-nav.ts 1; middleware.ts 1; app/layout.tsx 1; login/page.tsx 4; many tests (seo.test.ts 13, UmamiScript.test 8, others).
- `hello@routeflow.info`: 44 hits / 14 files: home.html 10, contact 6, pricing 5, getting-started 4, product 3, company 3, security 2, data 2, landing 1, does 1; lib/site.ts 2 (:15, :54); site-frame-nav.ts:44; tests site-company-contact (3), site-frame.test (1).
Already centralised by the plan: palette once at `packages/ui/src/tokens/rovio-palette.json` (sp:211; T14a); job tokens in one block (ux:28-40); `site.origin` for React code and `ORIGIN` in the sync script (sp:220-223); page list once in next.config.mjs (bp:294-299); wheel OUTER/INNER data (sp:179). Exists today: `site` object lib/site.ts:12-16 (name/origin/email); `SITE_EMAIL` site-frame-nav.ts:44.
Left hard-coded by the plan: the name in static HTML (ten pages; "read each string, not search-and-replace", bp:261); logo files named `rovio-*` copied from the kit (bp:233); host and email in static HTML ("static HTML cannot call a helper, so T31 pins it", sp:220); 4 wheel strings and strings in home-up/site/prices.js (bp:260); JSON-LD name (bp:261); tests that pin literals (bp:260). The plan has no single site-name constant for the static pages.

## 4. Swap cost: Rovio -> XROV.IO under the current plan
Name text would need edits in: WP2.5 files (10 html, rf-wheel-up.js, home-up/site/prices.js, SiteFrame.tsx, SiteFrameHeader.tsx, site-frame-nav.ts, lib/site.ts, lib/metadata.ts, opengraph-image, sync-site-port.mjs, name tests); WP2.6 files (privacy, terms, not-found, 6 auth layouts/pages, AuthShell, buyer/login layouts; `title: { template: "%s · Rovio" }`, `siteName`, `appleWebApp`, bp:267); WP1.3b ledger strings if written with the name; JSON-LD `name`; footer "© 2026 Rovio, formerly RouteFlow" (T25, sp:92); Program B constants. Brand files named `rovio-logo-*`, `rovio-symbol-*`, `rovio-mark-*` and `rovio-palette.json` (WP2.0) carry the name in file names; artwork is a kit file (never redrawn, bp:234). Colour tokens use neutral `--rf-` names.
Domain/email: `www.xrovio.com` and `hello@xrovio.com` (WP2.5, WP2A.2, next.config redirects, T30/T31/T32/T34, API settings, DNS/consoles; list in 9).
Tests pinning the literal name: new `site-rovio-name.static.test.ts` (T24: "Rovio" in title, regex `/route\s?flow/i` with allow-list, tp:73); T22 accessible name "Rovio" (tp:71); T25 footer literal; T31 literal host and `hello@xrovio.com` (tp:80); `static-site.test.ts` L6/L7; `seo.test.ts`; `site-company-contact`; `site-truth`; e2e `36-marketing-site.spec.ts` title patterns (bp:260); T26 titles ending "Rovio" (tp:75).
Name-shaped items: logo min widths 160 px (full) / 90 px (small) are sized to the kit file (R22, sp:89), not text; no letter-spacing tied to the name found in site-frame.css (only heading tracking vars at :46,54,148). Text-width or layout dependence on a five-letter word is not examined anywhere in the plan. Plan statement about another name: "Tokens named by job make another palette a values change" (bp:354); none about renaming.

## 5. Price content
Typed in one object, not read live: `js/prices.js:7-23` ("ONE object", header :1-6) holds catalog v13: Starter 99/100 customers, Growth 249/250, Scale 499/500, yearly = monthly x 10, add-ons 39 and 50; copied by hand from `apps/api/prisma/plan-catalog-v13.definitions.ts`; `site.js` writes it into `[data-plan][data-field]` nodes. Typed `$` literals also appear: pricing.html 14, home.html 11, product.html 3, landing.html 2, home-up.js 1, site.js 1, lib/site.ts 1 ("plans from $99"), tests site-truth (3), site-phone-and-motion (1). Plan: prices come from the unchanged prices.js (sp:232); "Prices" is a non-goal, live site shows $99/$249/$499 (sp:140, di E33). The $99/$199/$299 tiers are not in the plan (apple-ux report.md:35-37: not live). Sign-up page shows no price (F05, signup/page.tsx:264-265).

## 6. WP1.3a (wording audit) done?
NO. `copy-ledger.md` is absent from P (`ls P | grep ledger` empty). `local-assets/proofs/2026-11-11-rovio-rebrand/` holds only apple-design-signoff.md, apple-ux-quick/, baseline-red.json, logs/; the `live-now/text/` input (bp:226) and `brand-kit/` (bp:234) folders do not exist. Kit tokens exist at `P/packs/rovio-tokens.json`. (A glob for other copy-ledger paths timed out; ls of P and local-assets only.)

## 7. Open questions the plan lists
- A1 "The name Rovio clears trademark review" (di:125; bp:26 "riskiest").
- A9 "No business uses its own sub-address (<name>.routeflow.info) today" (di:133; sp:263 "Still open"; needed before WP2A.1 only).
- Also unproven: A2 design package no longer the site's source (di:126); A3 app follows same palette (di:127); A5 Umami 30-day trial-start baseline (di:129); A6 print fallback, 30-minute spike (di:130); A7 one pose reads well on a phone (di:131).
- Program B owner decisions (program-b-app.md:48-54): the three app working colours; default colour of a tenant with none; platform email sender name and day; name in app stores and on card statements; attorney wording for legal pages.
- Tier-launch wording: "differ by customers and logins" (pricing.html:116) vs SA-1080 "price and customers only" (apple-ux report.md:37-39).
- D1-D8 are ruled (sp:41-53); today's ruling changes D1 for WP1.1/1.2.

## 8. UX issue ledger
"ux-only" = ux-spec assigns it but the build-plan package text does not name it.
| id | issue | page / width | covering package |
|---|---|---|---|
| B1321 (W) | wheel names crowd, pose differs per screen | / all sizes (T3,T4,T5,T8) | WP1.2 bp:150 |
| B1322 (L) | heading hidden at hand-overs | / 12 cells (T6) | WP1.2 |
| B1323 (E) | desktop end state: no trial button, empty screen | / 1440, 1288, 390 (T7) | WP1.2 bp:218 |
| B1324 (P) | blank prints, headings hidden until scrolled | 23 T1 + 7 T2 cells, many pages | WP1.1 bp:98 (T1 wheel clause: WP1.2) |
| B1328 | not in local bug registry (ends near B568), plan or handoffs | ? | unknown |
| F03+P02 | pricing notes: two weights, stray "Includes your team.", repeated Enterprise email (pricing.html:114-118) | /pricing 1440, 393 | UNASSIGNED (ux:173 leaves in report) |
| P03 | hero ring ornament clipped at right | / 393 | WP1.2, ux-only (ux:172) |
| P04 | orange glow under header; ~130 px gap before "Try it with your own orders." | / 393 | glow: WP2.1 (home-color.css, bp:239) though ux:172 says WP1.2; gap: WP1.2 (.sy-go, bp:152) |
| P01 | pricing cards: button at card bottom, empty fill | /pricing, / 1440 | UNASSIGNED (WP2.3 is bands/art only, bp:250) |
| F05+F07 | sign-up lead lacks trial plan and after-trial price | /signup 1440, 393 | UNASSIGNED (held to tier launch; WP2.6 words only) |
| P05 | phone mock-up cuts "INVOICE" heading | / 1440 | UNASSIGNED |
| P06 | active wedge shows 3D box among line icons | / 393 | ux:172 says WP1.2; report says Phase 2 (WP2.2 focus colour, bp:246); art swap not named |
| P07 | "Stock Value (cost)" casing, rf-wheel-up.js:95 | / 393 | WP1.2, ux-only; also WP1.3b wording |
| P10 | header "Start free trial" on /signup (SiteFrameHeader.tsx:77,109) | /signup 1440, 393 | UNASSIGNED (SiteFrameHeader only in WP2.5, name) |
| P09 | two "Start free trial" in one viewport | / 393 | end-state case: ux:162 (header pill steps aside), ux-only; rest UNASSIGNED |
| P11 | 8-character rule stated twice (signup/page.tsx:396) | /signup 1440 | UNASSIGNED (WP2.6 "no logic", bp:264) |
| F04 | no "Skip to plans" (10 Tabs after Back) | /pricing | UNASSIGNED |
| F08 | phone menu Sign in/trial below fold | all 393 | UNASSIGNED |
| P12-P16 | small type/alignment items, no detail | - | UNASSIGNED (counted as 1 row) |
| D-1 | legend: 16 px icon + name in both layouts, clockwise order | / | WP1.2 (ux:161; bp:217) |
| D-2 | trial button: opacity-only fade, focusin goTo("one"), <= 2 Tabs, header pill steps aside on phone | / | WP1.2 (ux:162; bp:218); header change ux-only |
| D-3 | Phase 1 focus: keep 3px --b500 ring, add focused-tile top-face stroke | / | WP1.2, ux-only (ux:163); Phase 2 colour: WP2.1/2.2 |
| D-4 | copper-dark on ink ~2.8:1; use panel token, not site.css:22 list; ink focus untested | all | WP2.1, ux-only (ux:163); test UNASSIGNED |
| M-1..3 | snap from rest (inertia, power2.out); phone scrub <= .3; goTo killed on input, capped ~0.9 s | / | WP1.2, ux-only (ux:165-169) |
| tier | wording "customers and logins" vs SA-1080 | /pricing | UNASSIGNED (owner/tier launch) |
Baseline red cells (baseline-red.json, 59 failed / 17 passed): T1 23 (P), T2 7 (P), T3 7 (W), T4 1 (W), T5 4 (W), T6 12 (L), T7 3 (E), T8 2 (W). Harness flag HF1 (T8 trigger count method) listed there.
UNASSIGNED rows: 10 (F03, P01, F05, P05, P10, P11, F04, F08, P12-16, tier wording) plus ink-focus test in D-4 and P09 remainder = 12 counting partials; B1328 not countable. Ux-only rows: P03, P07, D-2 header, D-3, D-4, M-1..3, P09, P06.

## 9. Transition steps, risks, pre-launch exposure
Steps (bp:269-330, sp:143-165):
1. WP2A.0: API `WEB_ORIGINS` allow-list on master early; proof T34 (tp:83).
2. WP2A.1 (checklist C2), owner + lead, each read back: A9 check first (bp:278); DNS `www.xrovio.com` custom domain on Railway web service (CNAME) and `xrovio.com` forwarding; `CORS_ORIGINS` add; Google console origin + callback; Stripe allow-list; Umami host; `WEB_ORIGINS=https://www.xrovio.com`; run T32 from CI by hand; one Google sign-in per address by hand. Proof T32 (existing setup/critical-paths/cross-cutting vs new host).
3. WP2A.2 on branch: redirects from `www.routeflow.info` public paths (12) to new host, `permanent:false`, shell user agent exempt, app paths never redirected; `site.origin`. Proof T30 a/b, T31, T33 a/b.
4. WP3.1 launch (checklist C1, bp:321-327): (1) owner writes: trademark cleared, customers told two weeks ago and today, T32 green within 7 days, ad creative ready; (2) master merged in, suites green on images from head, gates signed, pre-merge-review PASS at sha; (3) `git log origin/master -S"Rovio" ...` empty; (4) rollback rehearsed locally (revert merge, T12 and T24 inverse); (5) canonical deploy flow (watchdog, public window, CI green, merge commit, both deploys SUCCESS, flip private); (6) one API change `WEB_URL=https://www.xrovio.com` + `WEB_ORIGINS=https://www.routeflow.info`; (7) `npm run post-deploy-check`, read site-proof incl. T30b, T33b; on red `git revert -m 1` and put `WEB_URL` back to routeflow.info with `WEB_ORIGINS` xrovio.
5. WP3.2: weekly T24 vs production for four weeks; launch+7d `permanent:true` and Search Console change of address; launch+6 months remove "formerly" line; code map, lessons.
Plan's premortem (bp:353-362): 1 name did not clear; 2 branch collides with other site edits; 3 launch breaks sign-in on new address; 4 rollback leaves visitors stuck (redirects temporary 7 days); 5 removed pin guarded an old phone bug; 6 new sign-up gets a "RouteFlow" email (Program B B1 same day); 7 site shows ink/bone app while real app is teal; 8 print leaves motion broken (T1 return leg).
Public before launch day: WP2A.0 on master; WP2A.1 `www.xrovio.com` serving today's RouteFlow site and app, "not linked from anywhere" (bp:286), DNS/cert resolvable; Google/Stripe/Umami/CORS settings; customer notice two weeks ahead (sp:160, di:104); working `hello@xrovio.com` mailbox (sp:50); ad creative; per today's ruling WP1.1/1.2 on master. The plan does not say what canonical/robots the new host serves while early.
Where the new domain/email is written:
- Plan: bp:9,261,276-290,299-327,356; sp:43,50,101-106,151-162,220; tp T30-T34 (tp:80-83); di:59; program-b-app.md:65; review-gate files.
- Code to be written (none on the branch now; grep `xrovio|XROV` hit only plan and handoff files): next.config.mjs redirect destination; lib/site.ts origin + email; site-frame-nav.ts:44; metadata/opengraph route; sync-site-port.mjs ORIGIN; 10 html (canonical, og:url, share image, JSON-LD url, mailto); privacy/terms; layouts' `metadataBase`; tests site-rovio-host.static, static-site.test (L6, L7), seo.test, lib/static-site-page.test (`data-domains`), site-company-contact, site-truth; API env `WEB_URL`, `WEB_ORIGINS`, `CORS_ORIGINS`, `CORS_WILDCARD_DOMAINS` (if A9); external: DNS, Google, Stripe, Umami, Search Console, mailbox.

## 10. Speed facts
Plan requires: R13/T13 (sp:75, tp:62): `public/site` <= 5 MB (house cap scripts/push-guard.mjs:45), `rf-wheel-up.js` <= 80,000 bytes (76,167 on disk now; 76,135 base), vendor dir exactly three files, assets same-origin under `/site/`; `site-rovio-budget.static.test.ts` exists. Reduced motion: non-goal, motion always runs, tests forbid `prefers-reduced-motion` (sp:31,131,140; di E14). Print is the only fallback (R1/T1). Resize settles within 400 ms (R9/T8, sp:71). Pages cached 60 s, `/site/` assets network-first (sp:148-150). R18 flat rule removes gradients, blur, shadows (no timing claim). Wheel `tiny` floor under 200 px stage (bp:185-189). No budget for load time, layout shift, LCP or response time found in the plan files (grep).
On-disk weights, bytes (html + the css/js/png/woff2 it links; analytics.js 1,851 not counted; S total 752 KB on disk):
| page | html | css | js | img | font | total |
|---|---|---|---|---|---|---|
| home | 82,242 | 107,725 | 231,080 | 29,731 | 24,796 | 475,574 |
| product | 36,383 | 52,978 | 137,822 | 4,004 | 24,796 | 255,983 |
| getting-started | 17,889 | 55,006 | 136,764 | 4,004 | 24,796 | 238,459 |
| does-and-doesnt | 17,775 | 54,750 | 136,764 | 4,004 | 24,796 | 238,089 |
| security | 15,471 | 54,750 | 136,764 | 4,004 | 24,796 | 235,785 |
| data-in-and-out | 14,763 | 54,750 | 136,764 | 4,004 | 24,796 | 235,077 |
| company | 11,950 | 54,654 | 136,764 | 4,004 | 24,796 | 232,168 |
| contact | 9,704 | 54,654 | 136,764 | 4,004 | 24,796 | 229,922 |
| pricing | 21,910 | 28,109 | 136,764 | 4,004 | 24,796 | 215,583 |
| landing | 27,329 (inline CSS/JS) | 0 | 0 | 4,004 | 24,796 | 56,129 |
Parts: gsap 72,927 + ScrollTrigger 44,575 + SplitText 7,732 (not on home); rf-wheel-up.js 76,167; home-up.js 34,488; home.css 50,045; site.css 18,643; Geist font 24,796; marks 4,004 + 25,727.

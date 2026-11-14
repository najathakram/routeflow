# Spec delta 2026-11-14 (SA lane), rev 3 (gate 5 round 2 folded)

Amends the plan; wins where they differ. Branch `00ec11d53`, master `9e774cadb`. Bare paths: `apps/web/public/site/`.

## Changes after gate 5
| MF | Change | § |
|---|---|---|
| 1 | API reads `brand.json` via `common/brand.ts` (no runtime import) | 1 |
| 2 | Seam widened; `legalEntity` key; exemption table; kit-colour ban; B1 email files in T35/T45; NEW T45 | 1 |
| 3 | XROV.IO waits for its own kit. **Rejected premise:** the kit is not one PDF (26 path-only SVGs, 13 `icons/web`, 3 `email/`) | 1, 6 |
| 4-6 | Master proof path; G1 from real diffs; one owner per file per wave | 5 |
| 7, 8 | G0 fails closed and rides with WP1.2; public records wait for D0 | 2b, 2c |
| 9 | From `git grep` + env names; Stripe wallet domains rejected (no Stripe.js) | 2a |
| 10 | Ids cited | 3 |

## 1. Brand seam
- **Store:** NEW `packages/types/brand/brand.json`, data only: `name, formerly, legalEntity, origin, oldOrigin, email, securityEmail, titleSeparator, shareLine, logo.*, symbol, icon.*, emailLogo`. `legalEntity` (the LLC, `terms:54`, `privacy:68`) is a key, not an allow-list row; only the attorney changes it. Palette in `brand/palette.json`.
- **Readers:** web `packages/types/brand/index.ts` (typed `BRAND`, `pageTitle()`, `footerLine()`, mockable `loadBrand()`). API `common/brand.ts`: `readFileSync` of `require.resolve("@routeflow/types/package.json")` dir + `/brand/brand.json`, keys validated, throws on a missing one, own spec; the image has it (`apps/api/Dockerfile:67-69`). `next.config.mjs` and the sync script use `readFileSync`.
- **Static pages:** build-time fill in the `force-static` route (`route.ts:14-19`, `static-site-page.ts:45-52`). `{{brand:key}}` tokens; `renderSitePage()` throws on an unknown key or a leftover token. NEW `readServedSitePage()` is the only way tests read a page; a pin stops new disk reads. Raw `/site/<page>.html` redirects to its clean path (`next.config.mjs:186`).
- **Everything that names the brand reads the seam:** html title, head, logo `<img>`, JSON-LD, mailto, footer. The wheel hub reads `<template id="brand-symbol">` into a `Path2D`; the still at `home.html:114` uses the same token (today both type the old mark, `rf-wheel-up.js:86`). Colours come from one injected `--brand-*` `<style>`, read by the wheel through `getComputedStyle` (today it types hex at `:86,120,126,180,406`). Also WP2.6 layouts (title template, `siteName`, `appleWebApp`, icons), privacy/terms (`{BRAND.name}`, `{BRAND.securityEmail}`; 96 hits), frame, `lib/site.ts`, `metadata.ts`, og route (logo SVG + palette).
- **Pins:**
  - T35 (class): over `public/site/**/*.{html,js,css}`, `site-frame/**`, `(marketing)/**`, `(auth)/**`, `buyer/login/**`, `not-found.tsx`, `verify-email/**` and the og route (non-test). Zero `/route\s?flow|rovio|xrov|routeflow\.info|hello@/i`, zero hex in wheel JS and in html `style`/`fill`, zero typed mark paths. An exact identifier allow-list covers `rf-*`, `RouteFlowShell`, `routeflow-v4` and `/brand/routeflow-mark`. Zero files read throws. From W2, B1 adds `apps/api/src/email/{email-layout,routeflow-mail,email.service}.ts` to T35, plus a T45 row that renders the sign-up email via a mocked `common/brand.ts`. The sender `send.routeflow.info` is one allow-list row until B3.
  - **T35d:** no `palette.json` value in `public/site/**/*.css`, `site-frame.css` or `(marketing)/*.css`; colour only in the injected `<style>`. A guard from 2.0b.
  - **Exemptions** (one table shared by T35 and T45; a row fails once its lane has merged):

| Exempt | Lifted by (wave) |
|---|---|
| `rf-graphics.css` comment | 2.0b (W1) |
| `landing.html` | 2.4 (W1b) |
| `home.html`; comments in `home-up.js`, `site.js`, `prices.js` | S2 (W2) |
| `rf-wheel-up.*` (strings, hub, hex, comment) | 2.2 (W2) |
| `site.css`, `home.css` comments | 2.1b (W2) |
| privacy, terms, `(marketing)/layout.tsx`, `marketing.css`, `glass*.css`, `(auth)/**` incl. `admin-login`, `choose-role` (assigned to 2.6), `buyer/login`, `not-found`, `verify-email` | 2.6 (W2) |
| inline hex: `product`, `security` / `home` | 2.3-inner / 2.3-home (W3) |
  - T22-T26 compare to `BRAND`. **NEW T45** (from wave 0): mocks `loadBrand()` with `{name:"XROV.IO"}`, another palette and other paths; renders ten pages, frame, WP2.6 metadata and og route; expects zero `/rovio/i` outside `xrovio.com` and every name, src and colour from the fixture (also catches a `name`/`formerly` swap).
- **Logo** sized by height (30/28 px; replaces ux-spec:187). NEW T36: no overflow at 320/390/1440.
- **Rovio files:** copied from the kit to neutral `img/brand/` names: 4 logo SVGs, 2 symbol SVGs, 6 `icons/web`, 1 email PNG = 13.
- **Swap to XROV.IO:** (1) the XROV.IO kit exists (owner 1); (2) copy its 13 files over the same names; (3) `brand.json` `name` and `shareLine`, plus `palette.json` if colours change; (4) T35, T37, T45, the `site-` Jest files, then site-proof; (5) host and email stay. **Diff: 2 JSON lines (+ ≤ 15 palette) + 13 assets; 0 html/tsx/js.**
- **Name-shaped (T37):** no sentence ends with the name ("XROV.IO." double stop); titles ≤ 60 chars via `pageTitle()`.

## 2. Transition
### 2a. Host and email pins (`git grep -i routeflow\.info` origin/master + env names)
| Where | Rule | Proof |
|---|---|---|
| API `WEB_URL` fallbacks (`payment-requests:314`, `stripe-connect.controller:107`, `billing-notification.templates:43,47`, `demo-booking.service:748`, `onboarding-intake:776`, `addon-invariant.job:568`) | env flip at launch; returns via #4307 | T34 |
| Google sign-in, Google/Microsoft mailbox callbacks (API paths, `.env.example:136-170`) | stay on the API host; web return via #4307 | T34 per flow |
| Shell `web.tsx:164`, `eas.json:47,59`, `mobile/redirect/server.js:7`, mobile `index.tsx:191` | old host keeps the app; shell exempt; B4 adds the new host | T33b, T40 |
| `email-layout.ts:14-15`, `email.service.ts:345`, `EMAIL_FROM` | B1 reads `brand.json`; sender `send.routeflow.info` stays (no SPF/DKIM change) | B1 test |
| `admin@` (`demo-booking.config.ts:77`), `security@`, app `hello@` (`choose-plan:26`, `FirstRunCard:16`) | old mailboxes stay ≥ 12 months; app strings B3 | C1 |
| `app/layout.tsx:52`; apex checks `post-deploy-check.mjs:171`, `google-signin-monitor.mjs:57` | B1; 2A.2 checks both apexes | B1, 2A.2 |

Consoles (one C2 row each, read back at D0): Railway, registrar, Google OAuth, Maps referrers, Sentry, Umami, Search Console, Stripe public details, Workspace, API `CORS_ORIGINS`/`WEB_ORIGINS`/`WEB_URL`/`MOBILE_WEB_URL`. Runbooks and `SECURITY.md`: WP3.2.

**Risks:**
| # | Harm | Guard | Proof |
|---|---|---|---|
| 1 | Signed-in user on the old "/" is redirected (before middleware) and looks signed out | `missing` on `rf-op-auth`/`rf-buyer-auth` (`presence-cookies.ts:20`) | NEW T38 |
| 2 | Sign-in, Stripe and mailbox returns land on the other host; the shell allows only the old host | #4307: exact list, return to the session's origin, `returnUrlsOffBase` takes the list, empty `WEB_ORIGINS` changes nothing | T34, T40 |
| 3 | Old emailed links | app paths never redirect; Program C forwards 1:1 from launch + 12 months | T33 |
| 4 | Rollback after new-host emails | `xrovio` DNS kept; revert + `WEB_URL` old + `WEB_ORIGINS` new; 307 for 7 days | rehearsal re-runs T32 |
| 5 | Service worker / PWA | pages network-first (`sw.js:69-72`); PWA starts at `/dashboard`; brand files only under `/site/` (`sw.js:40-55`) | NEW T39 |
| 6 | Tenant hosts or apex redirected | `has: host` = exactly `www.routeflow.info` | T30 negative |
| 7 | Cookies | none names a domain (E34); one sign-in on the new host, in the notice | T32 |
| 8 | SEO | 307 → 308 at launch + 7 days; canonical/sitemap/robots from `BRAND`; pre-launch canonical to the old host | T30, T31 |

### 2b. Leak guards (pattern `rovio|xrov`, case-insensitive)
- **Done by the lead:** pushRemote guards on both brand-named branches; git-excludes for the handoff cards only (the over-broad `.claude/**/*rovio*` patterns are removed, since they hid this branch's plan files); the stale plan copy moved out of the main checkout. Plan files on the branch are committed normally. These local guards stand until G0 lands. The Mac mini gets the same; lanes get bundles, never `origin`.
- **G0 (brand-neutral):** rides in WP1.2's PR batch, sharing one whole-suite run (API suite ≈ 2 h here); no PR of its own.
  - `.husky/pre-push` refuses `rebrand/*` refs and scans the outgoing range against the untracked `.git/info/leak-patterns`: diff with new and renamed files (`--text`), commit messages, ref names.
  - **Fails closed:** a missing pattern file makes the hook and `leak-check.mjs` refuse (CI runs neither). `RF_REBRAND_PUSH=launch` lifts the refusal and the scan, launch day only. The file is installed by hand on every machine (bundles do not carry `.git/info`) and is retired after launch.
  - NEW `scripts/leak-check.mjs` reads the same file and covers the same, plus PR title and body, the squash body, `.claude/pipeline/{cost-ledger,agent-log}.jsonl`, `.claude/skills/*/references/RUN-LOG.md`, `.claude/{lessons,code-map,campaign}/**`. The lead runs it before `gh pr create`, before every merge and in pre-merge-review.
  - Neither names the brand; run slugs and ledger `--project` are neutral.
- **Open now:** registry branch `docs/rovio-baseline-bugs` has the word in its name and staged rows (`B1321.md:50`, `B1324.md:50`, B1322-3, `bugs.jsonl`): rename, reword before push.

### 2c. Prep: public records wait for D0
- **D0:** all DNS (CNAME, MX, TXT, SPF/DKIM/DMARC), the certificate (CT logs), Workspace domain and mailbox, Search Console, Google OAuth origin. Stripe public details change on launch day.
- **Private, now:**
  - Railway `CORS_ORIGINS`/`WEB_ORIGINS` (inert until DNS); Maps referrer, Sentry and Umami entries.
  - T32 two-origin proof on the web service's own `*.up.railway.app` domain.
  - The branch, proofs, gates, the rollback rehearsal, the notice text.
- **Calendar:**
  - D0: DNS, certificate, Workspace (≤ 4 h); then T32 on `xrovio` (~1 h), hand sign-in per host, notice 1.
  - D(N−3): last master merge, final proof, pre-merge-review PASS.
  - DN: launch, notice 2, Stripe details.
  - **N = 14 (C1) or 7 (owner 2).** If the attorney says no, D0 becomes the day the XROV.IO kit arrives.

## 3. UX ledger closure
Ids B1321-B1328: staged in `wt/rovio-registry/.claude/campaign/bugs/` (unmerged docs PR). B1328 evidence: `wt/site-wp11/local-assets/proofs/2026-11-13-site-wp11/master-t20-145901.log` (1 of 3 failed, `scrollY` 2908).
| Row | Package | Acceptance |
|---|---|---|
| B1321-B1323, D-1, D-2, M-1..3, P03, P04 gap | WP1.2 | T3-T8 (spec 84); ring inside 393; gap ≤ 48 px |
| B1324 | WP1.1 + WP1.2 | T1 (85, plus `WHEEL_PRINT_CLAUSE`), T2 |
| B1328 | WP1.2 (goTo killed on input) | T20 0-ms variant 10/10 |
| F03+P02, "customers and logins" | 1.3a/1.3b | NEW T41: one weight, one Enterprise line, no "Includes your team.", "customers" only (SA-1080, `js/prices.js:5`) |
| P01, F04 | 2.1b CSS, 2.3-pricing markup | NEW T46: button at card foot 1440/393; ≤ 2 Tabs to the first plan |
| P05 | 2.3-home | NEW T47: "INVOICE" box inside its frame at 1440 |
| P04 glow, D-4, B1294 | 2.1b | T18a; NEW T42 focus ≥ 3:1; the scan's rows |
| P06, P07, D-3 | 2.2 | T19; "Stock value (cost)" |
| P09, P10, F08, #1940 | header lane | NEW T48: one trial button per 390 viewport; none in header on /signup; menu shows Sign in + trial at 393×740; header steady |
| P11, B249, B247/B248/B520/B550 | 2.6 | rule once (`signup/page.tsx:396`); phone-UA 404; one red test per id |
| P12-P16 | split in W0 | one row + test each |
| F05+F07, B250 | **held** (tier launch; a feature) | - |
Final proof (WP2.7): all suites, full site-proof, T35-T48, `apple-ux --quick` (1440×900, 390×844) on the branded build with the 11-12 Top-10 as PRIOR; an open PRIOR row is red.

## 4. Speed budget (motion stays on)
Today (gzip): home 188.7 KB (JS 85.1), product 110.2, pricing 98.5, landing 35.2. All but landing animate (`js/site.js:53-99`): GSAP stays.
- **NEW T43** (static Jest, zlib over `readServedSitePage` + linked files, no slot): home ≤ 175 KB, inner ≤ 115, landing ≤ 45; html ≤ 20 gz; script home ≤ 90, inner ≤ 57; logo, symbol and end-mark as SVG (drops the 26 KB PNG at `home.html:597`); raster icons ≤ 15 KB; sizes on every `img`; one Geist woff2 ≤ 25 KB, preload, swap; `prices.js` only where `[data-plan]` exists.
- **NEW T44** (site-proof e2e, median of 3, heavy slot; W0 baseline): 1440: LCP ≤ 1.2 s, CLS ≤ 0.02, TBT ≤ 100 ms. 390 (4× CPU, 10 Mb/s, 40 ms): LCP ≤ 2.5 s, CLS ≤ 0.05, TBT ≤ 300 ms. Menu tap: Event Timing `duration` of the first `.menu-btn` click ≤ 200 ms.

## 5. Waves and lanes
**G1 = files master changes:**
- WP1.1 (`a587d034e..268f753e1`): `site.css`, `mobile.css`, `product.css`, `home-up.js`, `site.js`, `landing.html`, `site-mobile-pass`, `site-motion-always`, `site-pin-ledger.json`, e2e 85, `helpers/site-p*`, `playwright.config.ts`.
- WP1.2 (`2026-11-13-site-wheel-print/README.md`): `rf-wheel-up.*`, `home.html`, `home-up.css`, e2e 84, `site-wheel-budget`.
- Batch 1 (`..254c406df`): `signup/check-email`, `verify-email`, `routeflow-mail.ts`, `auth.service.ts`.

On merge, **master wins** on the harness (85, helpers, ledger, config). `site-rovio-budget` is deleted when `site-wheel-budget` arrives. WP1.1's diff has 0 brand hits. The ledger is written only in each wave's close-out commit.

| W | Package: files owned | Starts when | Red first |
|---|---|---|---|
| 0 | **G0 guards** (`.husky/pre-push`, `scripts/leak-check.mjs`; in WP1.2's batch) | now | a `rebrand/x` push and a missing pattern file are both refused |
| 0 | **S1 seam**: `packages/types/brand/{brand.json,index.ts}`, `static-site-page.ts`, route, `(marketing)/lib/site.ts`, `metadata.ts`, og route, `site-frame/*`, `umami-tag.ts`, sync script, `next.config.mjs`, 8 html (not home/landing), tests static-site, seo, site-company-contact, site-truth, site-frame, `static-site-page.test`; NEW T35, T45 | now | T35 (250/77/44 literals); T45 shows "RouteFlow" |
| 0 | **2.0a** `img/brand/*`, `brand/palette.json` · **1.3a** ledger · **B1 spec** · P12-16 split · T44 baseline | now | T23 |
| 1 | 2.0b `rf-graphics.css`, injection, `components/brand/BrandTokens.tsx` | WP1.1 in branch; S1 | T14a |
| 1b | 2.1a `home-color`, `color-deep`, `product`, `company`, `does`, `start` css, `site-frame.css` · 2.4 `landing.html` · 1.3b-pages (8 html text, frame strings) | 2.0b; ledger OK | T14b, T18a, T14c, T11 |
| 2 | 2.1b `site.css`, `mobile.css`, `home.css`, `home-up.css` (+P01/F04 CSS, D-4, B1294) · 2.2 `rf-wheel-up.*` · S2 `home.html`, e2e 36, comments in `home-up.js`/`site.js`/`prices.js` (never `rf-wheel-up.*`), `prices.js` tags · 2.6 front door + `verify-email`, `admin-login`, `choose-role` · B1 `common/brand.ts`, `email-layout.ts`, `routeflow-mail.ts`, `email.service.ts` and sole owner of `app/layout.tsx` (2.6's favicon move comes as a brief) | WP1.2 + batch 1 in branch | T14b, T42, T19, T35, T26 |
| 3 | 2.3-home · 2.3-pricing · 2.3-inner (7 html) · header lane (`SiteFrameHeader.tsx`, `site-frame.css`, `site.css`, `mobile.css`, `js/site.js`) | W2 | T20, T21, T46-T48; **Docker 1** |
| 4 | 2.5 flip (values, logo markup, icons, JSON-LD, footer), then 2A.2 (redirects, sitemap, `origin`, apex checks) | W3 | T22-T26, T30, T31, T33, T36-T38 |
| 5 | 2.7 proof, T39, T43, T44, retest, gates, rollback rehearsal | all | **Docker 2** |
Lanes run their own Jest files; browser red/green on `next dev` in the heavy slot; one whole web Jest (~25 min) per wave.

## Design Gate (Lite) — spec-delta rev 2 · 2026-11-14 · base 00ec11d53
- G1 Fit: extends `static-site-page.ts:45-52`, `site.ts:12-16`, `@routeflow/types` (web) and an API reader per the `common/` rule. One store: `brand.json`.
- Area sweep: `grep '"register":"open"' .claude/campaign/bugs.jsonl | grep -E 'public/site|site-frame|\(marketing\)'` → B247 B249 B250 B520 B550 B1294, plus staged B1321-B1328 (§3). `gh issue list --search "site in:title"` → #1940, #1579.
- G2 Variation: business types n/a (no tenant read). Host axis: www redirects; apex forwards; tenant hosts never redirect (T30); shell exempt; buyer portal is an app path. SEAM NOW: Program B reads `brand.json`.
- G3 Replace-later: Program B reads the seam; Program C adds rows (XS); XROV.IO = values + files.
- G4 Class: the T35 predicate; helper `renderSitePage`/`BRAND`; proven by T45.
- G5 Data & time: schema none; build-time fill; order in §2.
- G6 Scale: §4 caps as named constants.
- G7 UX: nothing removed; placements extend ux:162; signed at WP2.7.
- G8 Change: name → 2 lines + 13 files (XS); host → `origin` (XS).
- G9 Cost: the route already reads every page; seam is S. Lite: amends a Full gate.
- G10 Owner questions: §6.

## 6. Owner list (defaults hold; none blocks the build)
1. **If the attorney rejects Rovio:** XROV.IO waits for its own kit; the wordmark is drawn per letter (`brand-kit/src/rovio.py:8`). Rec: brief the designer that day and register `xrov.io` to forward. Default: wait.
2. **Notice lead time:** rec 7 days; default 14.
3. **One ledger sitting:** wheel strings, "customers" only, the name-ending rule. Default: SA wording.
4. **Owner's accounts:** Maps, Sentry and Umami entries now; DNS, Workspace, Search Console and Google at D0; Stripe details on launch day.

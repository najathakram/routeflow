# Spec — what the Rovio website rebrand must do

> Run `2026-11-11-rovio-rebrand` · Status `DRAFT` · Evidence rows `E#` are in [discovery.md](./discovery.md) §0.
> Scope of THIS spec: **Program A, the website** (every page a signed-out visitor sees, at desktop and
> phone sizes). The app is Program B: outlined in [program-b-app.md](./program-b-app.md), planned in its
> own run after A ships. The public site's move to `www.xrovio.com` is part of this program (owner
> ruling D3). Retiring the old address for the app is Program C, after B.

## 1. Core capability, in one sentence

A visitor to the public site sees Rovio (name, logo, ink / bone / copper look) on every page and at
every window size, with a wheel that fits its screen, names every part beside it, and leaves no empty
or broken screen, and nothing the site does today is lost.

## 2. Use cases, in priority order

| # | Use case | Priority |
|---|---|---|
| U1 | A wholesaler opens the home page on a laptop or a phone, scrolls the wheel, and can read what each part is at every moment | must ★ |
| U2 | The same visitor sees one brand from the first screen to the sign-in form | must ★ |
| U3 | Someone prints a page, saves it, or shares its link and gets a complete page | must |
| U4 | The owner can hold the new look back until the name is cleared, launch it in one step, and undo it in one step | must |
| U5 | A reader finds the wording plain and consistent on every page | should |

## 3. Decided already (do not re-open)

- Name, logo, palette and rules come from the brand kit v2 and the website guide (E22, E23).
- Order of work: website first, then the app.
- Pages, sections and the wheel stay. Colours, logo and the wheel section's layout change (E23).
- The wheel keeps its three stops (Orders, Inventory, Payments), its snap and its keyboard control.
- Motion always runs: no reduced-motion path (E14). The owner may reverse this; the plan does not.
- Status colours stay and mean Paid, Pending and Overdue only.
- Internal names stay: the `rf-` prefix on classes, variables and files, storage keys, cookies (E29).

## 4. Owner rulings and the defaults still open

Ruled by the owner on 2026-11-11 (question box):

| # | Ruling | What it means here |
|---|---|---|
| D1 | **Everything on one launch day.** The live site does not change until the whole website rebrand is ready | every package, the fixes included, builds on the branch `rebrand/rovio-site`. The wheel bugs stay live until launch |
| D2 | **The site is edited in this repo** | the design-package sync is guarded so it cannot overwrite the work (R28) |
| D3 | **Launch on `www.xrovio.com`** | Phase 2A. Both addresses serve the app for a while, so nobody is signed out; the old address forwards the public pages (R31-R36, E34) |
| D8 | **Sign-in, sign-up and reset pages switch with the website** | WP2.6 |

Ruled in a second and third box on 2026-11-11 (each is still one line to change):

| # | Default | Why | Changes if overruled |
|---|---|---|---|
| D4 | **Ruled 2026-11-11:** every page shows `hello@xrovio.com` from launch; the owner sets up the mailbox before launch day (checklist C2) | owner | - |
| D5 | **Ruled 2026-11-11:** the footer says "Rovio, formerly RouteFlow" for six months after launch | owner | a ticket dated launch + 6 months |
| D6 | **Ruled 2026-11-11:** Geist stays; the brand kit's font line is updated to Geist | owner | none in the repo |
| D7 | **Ruled 2026-11-11:** pictures of the app on the site use the Rovio colours from launch | owner | `--app-*` and `--buy-*` values |

## 5. Requirements

Priority: **must** blocks the phase gate; **should** blocks launch unless waived in writing; **could** may slip.

### Phase 1: fixes, no brand in them (built first, on the branch)

| ID | Requirement (observable behaviour) | Pri | Proven by |
|---|---|---|---|
| R1 | In print media every page shows all its content in the static layout: no blank band, no overlapping text, no dark text on a dark background, the wheel as its still picture. Leaving print restores motion with the same number of scroll triggers | must | T1 |
| R2 | With scripts on and no scrolling, every `h1` and `h2` on every page is fully opaque and visible | should | T2 |
| R3 | At every supported window size and every point of the wheel's scroll, everything drawn on the wheel canvas lies inside the stage, below the header, and never over the words column or the legend | must | T3 |
| R4 | The open wheel is sized from the smaller side of one box: it fills at least 80% of the limiting side and is centred in the box | must | T3 |
| R5 | The three layers use one pose and one lift weight on every screen: the gap ratios are identical at every point of the animation and at every window size | must | T4 |
| R6 | Tiles carry icons only. All 15 part names show in a legend on the stage whenever no single part is in focus, and stay reachable by hover and by keyboard. "If you deliver" stays on Routes and Delivery wherever their descriptions show | must | T5 |
| R7 | From the first screen to the end of the wheel, the words column always shows a heading at least half visible: hand-overs are cross-fades that start both tweens together. No heading is cut off by the header. On a phone, "Look inside." is up when the stage sticks | must | T6 |
| R8 | After the wheel closes there is no screen without either the wheel or a heading with its button: "Try it with your own orders." and its button belong to the wheel's end state | should | T7 |
| R9 | After a resize, a rotation or a breakpoint change at any scroll position, R3-R7 hold within 400 ms with no reload, and the count of scroll triggers equals a fresh load at that size | should | T8 |
| R10 | On a phone no heading overlaps the text after it at any scroll position | should | T9 |
| R11 | Every page's text passes an Apple-style review. Each changed string is in a ledger the owner approved. No claim changes unless the ledger says so | should | T10, T11, gate G-W |
| R12 | Nothing is lost: every link, button, form control, anchor, accordion, the 15 tile buttons with arrow-key control, the hover name, the snap points, the signed-in header state and the phone menu exist after as before, except changes listed in the parity ledger | must | T12 |
| R13 | Weight and policy hold: `public/site` under 5 MB, the wheel script at most 80,000 bytes (76,135 today), no new vendor file, every asset same-origin under `/site/` | must | T13 |

### Phase 2: the Rovio look (held on one branch until launch)

| ID | Requirement | Pri | Proven by |
|---|---|---|---|
| R14 | One token block holds the kit's colours and names each by job. No rule refers to a retired colour token (`--rf-brand-*`, `--rf-sun`, `--rf-coral`, `--rf-mint`, `--rf-ink-2`, `--rf-ink-3`, `--rf-sh-*`, `--pc-*`, `--fld-*`, `--navy`, `--sun`). The landing page's inline copy equals the block | must | T14 |
| R15 | Every page band is white, bone or ink | must | T15 |
| R16 | Buttons are ink (white on ink panels). Links are copper dark on light and copper light on ink. The focus ring is copper dark. All text meets WCAG AA contrast | must | T16 |
| R17 | Copper appears only in its listed jobs (logo symbol and dot, the wheel part in focus, the step in view, pricing bars, eyebrow dot, one problem-section note, text links) and never as a status | must | T17, gate G-D |
| R18 | Flat: no gradient, blur, glow, drop shadow or shading anywhere, in CSS, SVG or canvas. Cards sit on a one-pixel line | must | T18 |
| R19 | The wheel is coloured by role: daily-work tiles bone, how-you-sell tiles ink, flat darker walls, the hub ink with the copper-light symbol. Exactly one tile is copper on the first screen (Payments) and at each stop; none when the legend shows | must | T19 |
| R20 | Each section follows the guide's treatment (table in [ux-spec.md](./ux-spec.md) §5) on all 10 pages | should | T20, gate G-D |
| R21 | Pictures share one flat style in ink, bone and the copper tints; pictures of the app use the Rovio colours and the status colours | should | T21, gate G-D |
| R22 | The logo is always a kit file, in the right version for its background and size, never typed text; minimum widths 160 px (full) and 90 px (small version) | must | T22 |
| R23 | Tab icon, touch icon and share image show the Rovio symbol; no file or string breaks the icon-name tests (E21) | must | T23 |
| R24 | Every visible string, title, description, share tag, alt text and label says Rovio. "RouteFlow" remains only where the allow-list names it: the footer line, the first mention in the legal pages, and `alternateName` in the home page's JSON-LD | must | T24 |
| R25 | The footer of every page reads "© 2026 Rovio, formerly RouteFlow" | should | T25 |
| R26 | The signed-out React pages (privacy, terms, not-found, sign-in, sign-up, password reset, store sign-in) show the same logo, name, title and tab icon as the site | must (D8) | T26 |
| R27 | Every literal a test pinned and this work removes is re-homed: a ledger maps it to the behaviour test that replaces it; pins that stay read their value from the source file at test time | must | T27 |
| R28 | The sync script cannot quietly undo the rebrand: it carries no old brand string and refuses to run without an explicit flag | should | T28 |

### Phase 2A: the address (`www.xrovio.com`, ruling D3)

| ID | Requirement | Pri | Proven by |
|---|---|---|---|
| R31 | Every public page is served at `https://www.xrovio.com/<path>` with a valid certificate, and `xrovio.com` forwards to `www` | must | T30 |
| R32 | Each public page's address on `www.routeflow.info` forwards to the same path on `www.xrovio.com`, query string kept: a temporary redirect for the first seven days (so a rollback is clean), permanent after | must | T30 |
| R33 | Canonical links, share addresses, sitemap, robots and JSON-LD name `www.xrovio.com`. The old host appears on no public page outside the allow-list | must | T31 |
| R34 | Sign-in, sign-up, password reset and store sign-in work end to end on `www.xrovio.com`, and so does the app after sign-in. A Google sign-in returns to the address it started on (needs WP2A.0; `auth.controller.ts:556-570` allows one web address today). Checked by hand once per address | must | T32, T34, checklist C2 |
| R35 | Nobody using `www.routeflow.info`, a business address under it, or the installed phone app (whose web view allows only that host) is signed out or broken by the launch: the app keeps working there until Program C, and the shell is never redirected | must | T33, T34 |
| R36 | From launch day, links in platform emails and payment return addresses use the new host, and visits are counted on it | should | checklist C2 (settings, not code) |

### Phase 3: launch

| ID | Requirement | Pri | Proven by |
|---|---|---|---|
| R29 | Nothing reaches `master` before the owner's go: not the fixes, not the look, not the address. Launch is one merge plus the settings in checklist C2; rollback is one revert plus those settings put back, rehearsed on the local stack; the proof suite runs against production after deploy | must | checklist C1 (process, accepted as not test-proven) |
| R30 | The code map gains rows for the site, the lessons register gains what the work taught (it is at its 52-entry cap, so an entry is archived whole first), and the heavy-files note in `CLAUDE.md` lists the new assets | should | T29 (`npm run verify`) |

## 6. Completeness sweep: every state a page can be in

| State | Decision | Req |
|---|---|---|
| Default, scripts on, scrolled normally | keep, repaint | R3-R8, R14-R24 |
| No scripts | keep: static layout already complete | R12 |
| Scripts on, never scrolled (crawler, screenshot tool) | fix | R2 |
| Print / PDF | fix | R1 |
| Short window (1288×593), tablet, wide (2560×1440) | fix | R3, R4 |
| Phone portrait and landscape | fix | R3-R7, R10 |
| Window too low for the wheel (under 500 px) | keep: the still shows, as today | R12 |
| Resize, rotate, breakpoint change mid-scroll | fix | R9 |
| Browser zoom 200% | covered by the size matrix (it is a smaller window) | R3 |
| Font not yet loaded (`font-display: optional`) | keep; layout reads the DOM after fonts settle | R9 |
| Signed-in visitor (header shows "Open dashboard") | keep | R12 |
| Returning visitor with cached files | no action: `/site/` files are network-first | - |
| Reduced-motion preference | non-goal (E14) | - |
| Dark mode | non-goal: light only by choice (E23) | - |

## 7. Non-goals (the scope fence)

Retiring the old address: the app stays reachable on `www.routeflow.info` and business addresses under
it (Program C). Any email address, sender domain or mailbox. Everything after sign-in, all emails, PDFs,
the mobile app, manifests, store listings, Stripe names (Program B). Renaming `rf-` prefixes, files,
storage keys or cookies. New pages, sections or wheel stops. Replacing the canvas with SVG or WebGL. A
reduced-motion path. Dark mode. Prices: the live site shows $99 / $249 / $499 (E33); if that differs
from the current price ruling it is a separate ticket. Analytics changes.

## 8. Deploy day, data and rollback

- **Existing users and data:** no data is touched. No schema, no API change, no flag, no entitlement,
  nothing to backfill. A session belongs to one host (no cookie sets a domain, E34): a session on the
  old address keeps working there, and the first visit to the new address asks for sign-in once.
- **What a visitor sees mid-deploy:** `master` deploys straight to production. Pages are cached 60 s in
  the browser; `/site/` assets are network-first (pack `site-source-and-pins.md` §5). A visitor can hold
  old HTML with new CSS for up to a minute. Accepted.
- **Before launch day, with no brand involved (checklist C2):** DNS and a certificate for
  `www.xrovio.com` on the web service; `xrovio.com` forwarding to `www`; the API's allowed origins; the
  Google sign-in console; Stripe's return address; the analytics site. Then the existing sign-in and
  order tests run against the new address from CI (T32). This can be finished weeks ahead.
- **Launch day:** one merge commit of `rebrand/rovio-site` (fixes, look, name, redirects, `site.origin`),
  then the API's `WEB_URL` setting.
- **Rollback:** `git revert -m 1` of that commit and `WEB_URL` put back. DNS stays. Redirects are
  temporary for the first seven days exactly so that this is clean. New image and logo files are
  additive and harmless if left behind.
- **Owner actions** (not buildable): trademark clearance (A1); customer notice two weeks ahead and on
  the day; the DNS records; the Google and Stripe consoles; ad creative for `/landing`; a working
  `hello@xrovio.com` mailbox (D4); Search Console's change of address once redirects are permanent.
- **After launch:** a weekly scan for leftover old-name strings for four weeks; a ticket dated launch +
  7 days to make the redirects permanent; a ticket dated launch + 6 months to remove the "formerly"
  line (D5).

## Stage log (this file's rows)

| Stage | Stop condition | Fired? | Action |
|---|---|---|---|
| P4 Spec | a requirement with no way to verify it | once | R29 is a process rule; kept and marked as checklist-proven, in writing |
| P4 Spec | deploy-day or entitlement trap | no | no data, no gate; §8 |

## Design Gate (Full) — rovio-rebrand Program A · 2026-11-11 · base 5fc866853

### G1 Fit
- Program / train: the owner's Rovio rebrand (brand kit v2 and the website guide, E22-E23); website first, then the app (Program B), then retiring the old address (Program C).
- Exists today: the static site `apps/web/public/site/*` (E1); its token block `graphics/rf-graphics.css:5-25` (E16); the canvas wheel `graphics/rf-wheel-up.js` (E4); legends `.rfw-keys` (`rf-wheel-up.js:132`) and `.sy-parts` (`css/home-up.css:104-112`); the site address `apps/web/app/(marketing)/lib/site.ts` (`site.origin`); the page list `apps/web/lib/static-site-page.ts:8-23` (`STATIC_SITE_PAGES`, `STATIC_SITE_PAGE_NAMES`); the rewrites `apps/web/next.config.mjs:87-96`.
- Decision: extend all of these. No new page system, no new renderer, no fourth legend. The wheel's part data (`OUTER`, `INNER`, `rf-wheel-up.js:20-38`) stays the one source for tiles, buttons and every legend.
- Facts: read at the base sha by three Sonnet gather passes (`packs/`) and checked by the planner where load-bearing. This gate corrected two: (1) `next.config.mjs` imports only `node:path`, `node:url` and `./csp.mjs` (`next.config.mjs:1-3`), so the redirect list cannot import the TypeScript page list; WP2A.2 now defines the public page list once in `next.config.mjs`, derives both rewrites and redirects from it, and a static test checks it equals `STATIC_SITE_PAGES`. (2) The palette would have lived twice, once for the site and once for the app (see G3). Writers of each value the design reads: the token block has one writer (`rf-graphics.css`), copied into `landing.html:27` by the external `tools/build-landing.cjs` named at `rf-graphics.css:4`, so T14c pins the copy; `site.origin` has one writer (`lib/site.ts`), read by `sitemap.ts:17-19`, `robots.ts:9`, `umami-tag.ts:32,45`, `privacy/page.tsx:76` and `terms/page.tsx:115`.

### Area sweep
| Source | Query run | Open ids in this area | Fixed here (own commit + red test) | Deferred (row + reason) |
| --- | --- | --- | --- | --- |
| Bug registry | `git show origin/master:.claude/campaign/bugs.jsonl` filtered on `"register":"open"` and `wheel, marketing, public/site, landing, home page, rf-wheel, home-up, print` | B247, B248, B249, B250, B520, B550 (B251 and the other hits are other areas) | B247, B248, B520, B550 in WP2.6: `marketing.css` and `glass*.css` are repainted there; each rule is either proven dead (L-199) and removed, or fixed; one commit per id | B249 and B250 look stale (the middleware has no phone-UA logic, `middleware.marketing.test.ts`; Contact is email-only by spec 36 T1): re-verify and close with evidence in WP0 |
| Tracker issues | `gh issue list --repo najathakram/routeflow --state open --limit 200 --search "wheel OR marketing OR rebrand OR rovio OR landing in:title"` | none returned | - | - |
| ACTION-ITEMS | `git show origin/master:.claude/handoffs/ACTION-ITEMS.md` searched for `wheel, marketing site, public/site, rovio, rebrand, xrovio, landing` | none | - | - |
| Review nits | the 2026-11-11 audit of the live site (E8-E13) | four wheel and page bugs, ids filed in WP0 | all four, Phase 1 | - |
- Chunk: one area, the public site and its front door. Phase 1 is one chunk of four bugs. Phase 2 passes about 600 changed lines, so it splits by sub-area: tokens, wheel colour, pages, landing, name, front door, address.

### G2 Variation map
| Axis | How it differs there (one line) | Mark | Seam in this change (SEAM NOW only) |
| --- | --- | --- | --- |
| Wholesaler / distributor | the site's main reader; the wheel and copy are written for them | BUILD NOW | - |
| Jobber | same pages; no separate story today | LATER | - |
| Retail POS counter | "Counter sales" is one wheel part and one section | BUILD NOW | - |
| Delivery / route | Routes and Delivery carry "If you deliver" | BUILD NOW | - |
| Mixed | no separate surface | n/a: one site serves every type | - |
| Super admin | staff sign-in pages are Program B | LATER | - |
| Single store / 1 user | no difference on signed-out pages | n/a: signed-out pages | - |
| Small team | no difference on signed-out pages | n/a: signed-out pages | - |
| Multi-branch / multi-warehouse | no difference on signed-out pages | n/a: signed-out pages | - |
| High volume | no difference; page weight is capped (T13) | n/a: static pages | - |
- Surfaces & roles: web only, signed out: the 10 static pages, privacy, terms, not-found, sign-in, sign-up, reset, store sign-in. Mobile, buyer portal after sign-in, driver and super admin are Program B.
- Capability read: none. Public pages read no tenant, profile or setting. The only rule is the host, read by Next's `has: host` matcher (WP2A.2).
- Dark launch: n/a: the one-day ruling (D1) keeps everything on a branch, which is the dark state. Launch is one merge; rollback is one revert.

### G3 Replace-later
| Planned program touching this area | Would it replace or rework this? | Answer |
| --- | --- | --- |
| Program B, app rebrand (`program-b-app.md`) | it puts the same palette into `packages/ui/src/tokens/ledger.ts`: a second copy | SEAM NOW: the palette lives once at `packages/ui/src/tokens/rovio-palette.json` (NEW; the kit's `rovio-tokens.json` unchanged). The site's token block is pinned to it by T14a, and Program B's ledger reads the same file. This replaces the plan's earlier `public/site/graphics/rovio-tokens.json` |
| Program C, retiring `routeflow.info` | it forwards app paths and moves sign-in | no conflict: WP2A.2 keeps one page list and one redirect rule, so C adds rows (XS) |
| The design-package sync (`scripts/sync-site-port.mjs`) | a re-run would overwrite the work | final shape now: guarded by `--overwrite-site` and stripped of the brand (R28) |
| Marketing CSS consolidation (B247) | would merge `marketing.css` into shared tokens | final shape now for what WP2.6 touches: dead rules removed, live rules on the shared token names |
- Interim: the old address serves the whole app beside the new one until Program C. Expiry: Program C's launch; follow-up: `program-b-app.md` § Program C. Safe meanwhile because both hosts run the same build and no cookie names a domain (E34).

### G4 Class, not instance
- Class 1, colours: every rule that names a retired colour token. Predicate: `git grep -n -E "var\(--(rf-brand-|rf-sun|rf-coral|rf-mint|rf-ok|rf-tint|rf-ink-2|rf-ink-3|rf-sh-|pc-|fld-|navy|sun|tint)" -- apps/web/public/site apps/web/components/site-frame`; about 125 references at the base sha (E17). One helper: the job tokens. Pin: T14b, zero references; a sweep that reads zero files throws.
- Class 2, effects: every gradient, blur, glow or shadow. Predicate: the T18a pattern over site CSS, HTML and the wheel script; about 115 at the base sha (E18). Pin: T18a (static) and T18b (canvas spies).
- Class 3, the public host: every place a public page names its own address. Predicate: `git grep -n "routeflow\.info"` over `apps/web/public/site`, `apps/web/app/(marketing)`, `apps/web/app/layout.tsx` (the root `metadataBase`, review M2), `apps/web/components/site-frame`, `apps/web/lib`, `apps/web/next.config.mjs`, `scripts/sync-site-port.mjs`, plus every return-URL builder in `apps/api/src` that reads `WEB_URL` (review M1, WP2A.0). One helper: `site.origin` for React code and the sync script's `ORIGIN`; static HTML cannot call a helper, so T31 pins it. Allow-list: none on public pages (ruling D4 moves `hello@` too).
- Class 4, the old name: every visible string. Predicate: `/route\s?flow/i` over the 17 pages' text and tags, plus every `metadata` or `generateMetadata` export in a layout on any of those routes' paths (`git grep -n -E "export (const metadata|async function generateMetadata)" apps/web/app`), so inherited titles, share tags and app titles count (review round 2, N3: `layout.tsx:52-73`, `buyer/layout.tsx:20-31`). Pin: T24 with its allow-list.
- Inventory: the four predicates above, run at the base sha: about 125 retired-token references, about 115 effect declarations, 172 + 82 old-name strings (E19), and the host list from Class 3, recorded in WP0's baseline.
- One helper: job tokens for colour (`graphics/rf-graphics.css`, pinned to `packages/ui/src/tokens/rovio-palette.json`); `--rf-ring` for edges; `site.origin` and the sync script's `ORIGIN` for the host; the wheel's `OUTER`/`INNER` data for part names.
- Pin: T14b (retired tokens), T18a and T18b (effects), T31 (host), T24 (name). Each is a sweep that throws when it reads zero files or finds zero candidates (L-202), so nothing fails open.
- Red-first: the four Phase 1 bugs go red in WP0's baseline run on master's observed values, saved to `baseline-red.json`, never predicted. T11, T12, T13, T29 and T33 are guards that pass today, labelled as guards.

### G5 Data & time
- Schema: none.
- Snapshot vs live: n/a: no records. The share image is drawn live by its route; pages are files.
- Authority & time: the server decides redirects (host matcher). Redirects are temporary for 7 days, then permanent, so a week-one rollback is not cached by browsers. Launch-day order: merge, both deployments SUCCESS, then `WEB_URL` (WP3.1 steps 5-6).
- Old shape → new: sessions on the old host keep working there; old emails and bookmarks pointing at app paths keep working, because app paths are not redirected (T33); cached pages expire within 60 s. Open catch-up Checkout sessions and payment links issued before launch carry old-host return URLs: `returnUrlsOffBase` (`payment-due.service.ts:422-437`) accepts the whole allow-list (WP2A.0), and launch day sets `WEB_ORIGINS` to the old host in the same change as the `WEB_URL` flip (WP3.1 step 6), so none is expired (review round 2, N2).
- Money: n/a: no money is computed; displayed prices come from the unchanged `js/prices.js`.

### G6 Scale
- Queries: none; static pages.
- Limits: `public/site` 5 MB (existing house cap, `scripts/push-guard.mjs:45`); wheel script 80,000 bytes (76,135 at the base plus the WP0 test hook). Both pinned by T13.
- UI at 10 and 10,000: n/a: no lists. The wheel has a fixed 15 parts; adding one is a data row (G8).

### G7 UX lens
- Flow: the guide's flow read against apple-ux: one primary action per state (Start free trial; the wheel's end state now carries it, R8); names where the eye is (the legend beside the wheel, R6); nothing removed (R12). Gate miss: the flow-first `apple-ux --quick` baseline on fresh master was not run before this spec. It runs in WP0, before any WP1.2 code, and its vital few join WP1.2 or the copy ledger.
- Feature parity: T12's inventory, captured from master in WP0; every change needs a row naming its `R#`.
- Placement sign-off: the legend placement, the end-state button and the copper focus come from the owner-supplied guide. apple-ux and apple-design sign them in WP0 on the guide's pictures, with reasons, before WP1.2 starts; a disagreement goes to the owner then, never to a builder.

### G8 Change-friendliness
- Config over code: colours are job tokens in one block; wheel colours are role tokens read at mount; the public page list is one array in `next.config.mjs`; the palette is one shared file.
- Shared contract: the palette file in `packages/ui/src/tokens/` (G3). No DTOs or enums change.
- Flags: none; the branch is the switch.
- Code map: new rows for `public/site` (pages, tokens, wheel, legend) and the redirect list, in WP0 and WP3.2.
- Future requirement → expected diff size:
  - a different palette later → XS (values in the palette file and token block)
  - the app adopts the palette (Program B) → S (the ledger reads the shared file)
  - a new wheel part → S (one data row and one icon; tiles, buttons and legends follow)
  - a reduced-motion path, if the owner reverses E14 → S (one extra media condition per matchMedia, reusing the print fallback)
  - dark mode → M (a second token block plus the wheel role tokens)
  - Program C forwards app paths → XS (rows in the page list)

### G9 Cost & stop
- Quick fix: re-label the canvas text and swap hex values. Rejected: the wheel bugs come from names drawn inside the canvas and per-breakpoint poses (E6, E7), and a blind hex swap leaves about 125 retired-token references to drift and turns mid-blue fills copper by accident (E17). This shape removes the causes once.
- YAGNI: considered and cut: replacing the canvas with SVG or WebGL; a token build step; a CMS for copy; per-tenant site colours. None has a named need.
- Review-round signal: round 1 (`review-gate-1.md`, Opus @ high) returned GATE FAIL (G1, G4, G7), REVISE, 9 must-fix. All folded the same day; the model did not change (no fold opened a new boundary), so no re-pick. Round 2 (`review-gate-2.md`): GATE FAIL (G5, G4), REVISE; 14 of 21 round-1 items fixed, 7 partly, 3 new must-fix (N1 was caused by the M6 fold; N2 and N3 were inventory misses). Answer: the host and name classes are now defined by code predicates over every return-URL builder and every metadata export on the route path (G4), not by hand lists. Round 3 checks the fold.

### G10 Owner questions
- Asked in one box on 2026-11-11 (rulings D1, D2, D3, D8 in §4). Still open: A9 (does any business use a `name.routeflow.info` address today?). Needed before WP2A.1 only, so it does not block Phases 0 or 1. D4-D7 are stated defaults.

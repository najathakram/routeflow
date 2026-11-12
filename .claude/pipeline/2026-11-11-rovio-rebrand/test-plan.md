# Test plan: the Rovio website (Program A)

> Run `2026-11-11-rovio-rebrand` · Status `DRAFT` · written before the build plan, which is derived from it.
> `R#` in [spec.md](./spec.md); `E#` and `A#` in [discovery.md](./discovery.md). Paths marked NEW are created by this work.

## Evidence & assumptions

| # | Claim | Source |
|---|---|---|
| TE1 | Static tests for the site are Jest files in `apps/web/app/(marketing)/*.static.test.ts`; they read files from disk | pack `site-source-and-pins.md` §2 |
| TE2 | Playwright needs `PLAYWRIGHT_BASE_URL` (no default); the local stack serves web on `:3001`; the wrapper is `node scripts/local-env.mjs --proof-stack --e2e -- "<cmd>"` | `apps/web/e2e/LOCAL-LANE.md` |
| TE3 | A spec runs only if `apps/web/playwright.config.ts` has a project whose `testMatch` names it | `playwright.config.ts:858-862` ("WITHOUT THIS ENTRY THE SPEC NEVER RUNS") |
| TE4 | The wheel exposes its ScrollTrigger at `document.querySelector(".rfw")._rfw.trig` | `apps/web/e2e/36-marketing-site.spec.ts:1713` |
| TE5 | The 15 tile buttons are `.rfw-b[data-i]`, laid over their tiles | `36-marketing-site.spec.ts:1380-1440`; `graphics/rf-wheel-up.js:135` |
| TE6 | The highest spec number on master is 83 | `git ls-tree origin/master apps/web/e2e/` |

| # | Assumption | Decides | Check |
|---|---|---|---|
| TA1 | `_rfw` can be extended with a read-only `cam()` snapshot without a test pin objecting | T4 | grep the static tests for `_rfw` in WP0 |
| TA2 | Resolved 2026-11-11: the post-deploy E2E job runs `npx playwright test` with no project filter, so a new project runs there without being dispatched | post-deploy proof | `.github/workflows/ci.yml:848` |
| TA3 | Resolved 2026-11-11: `apps/web/e2e/` has no `fixtures` folder; the parity files sit in `apps/web/e2e/helpers/`, which exists | T12 | `git ls-tree -d origin/master apps/web/e2e/` |

## 1. Strategy

| Level | Used | Why |
|---|---|---|
| Static (Jest reading files) | yes | where the file content IS the behaviour: no retired token, no gradient declaration, no old name, budgets. Never as a stand-in for layout (L-205) |
| Browser (Playwright, new project `site-proof`) | yes | geometry, pixels, computed colour, print media: the only level where the wheel bugs can fail for the right reason |
| Unit | no | the wheel's maths has no module boundary to import; it is tested through the canvas it draws |
| Visual snapshot | no | house rule: no snapshot tests. Colour and position are asserted as numbers |
| Review gates | yes | taste and wording: `apple-ux`, `apple-design`, `apple-write`, `impeccable`, owner (see [ux-spec.md](./ux-spec.md) §12). Recorded as evidence, not as `T#` |

**Rules for every test here**
- A sweep that finds zero elements, pages or pixels throws; it never passes or skips (L-202).
- No sleeps: wait on the trigger's own progress being equal across two frames (L-165).
- Select by `data-testid` or by the existing structural classes the e2e already uses (`.rfw`, `.rfw-b`); never by a responsive utility class (L-212).
- A value that lives in a source file is read from that file at test time (L-206). Values that come from the spec (the 15 part names, the palette) are typed once in the test as the oracle.
- Bug tests carry their registry token in the title (`REG-B###`), allocated in WP0.

**Window sizes (`SIZES`, 12):** 1440×900, 1288×593, 1920×1080, 2560×1440, 1024×768, 900×600, 768×1024, 844×390, 390×844, 430×932, 360×740, 320×568.
**Wheel checkpoints (`BEATS`, 13):** scroll shares 0, .10, .20, .30, .36, .45, .54, .63, .72, .76, .85, .93, 1 of the wheel's range.

## 2. Test table

Files: **S-host** = `apps/web/app/(marketing)/site-rovio-host.static.test.ts` NEW · **W** = `apps/web/e2e/84-site-proof-wheel.spec.ts` NEW · **P** = `apps/web/e2e/85-site-proof-pages.spec.ts` NEW ·
**H** = `apps/web/e2e/helpers/site-proof.ts` NEW · **S-x** = `apps/web/app/(marketing)/site-rovio-<x>.static.test.ts` NEW.

| ID | proves | level | Given / When / Then | Oracle | File | Fails today because |
|---|---|---|---|---|---|---|
| T1 | R1 | browser | **G** each of 12 pages at 1440×900 and 390×844, scrolled to mid-page · **W** `emulateMedia({media:"print"})` · **T** `html` has no `js-motion`; every `h1,h2,h3,p,li,a` has opacity 1 and is visible; no element has computed `position` sticky or fixed; `.rfw` has `rfw--static` with a visible `svg` and no visible canvas; first-screen text contrast ≥ 4.5; no heading's box intersects its next sibling. **Back to `screen`:** `js-motion` is in the state it had before print, `scrollY` is unchanged, and the trigger count is above zero and equals a fresh load scrolled to the same place (review M5, L-202) | the no-script layout is documented as complete (`rf-wheel-up.css:61-62`) | P | no print path (E12) |
| T2 | R2 | browser | **G** each page, loaded, never scrolled · **T** every `h1,h2` outside `.rfw-live` has opacity ≥ .99 and is visible; at least 3 are checked per page (the wheel's own headings are sequenced by design and covered by T6, review M9) | spec | P | headings below the fold are at opacity 0 (E12) |
| T3 | R3, R4 | browser | **G** home at each of `SIZES`, wheel re-mounted with snap off, arrival tween finished · **W** seek to each of `BEATS` in timeline time · **T** the canvas pixel box keeps an inset of at least 8 px from every canvas edge (no clipping), sits below the header, and does not intersect the words column or the legend. At .36-.45 the wheel box, read from the DOM (the stage minus the words column or heading and legend), is filled to between .80 and 1 on its limiting side; centring is within ±6% (bboxOf reserves room for the focus pop, review S3) | pixels read from the canvas, independent of the renderer's own maths | W | at 1440×900 the open wheel sits across the words column and names overflow tiles (E9) |
| T4 | R5 | browser | **G** home at each of `SIZES` · **W** sample `_rfw.cam()` at 25 points from 0 to 1 · **T** `zI/zO` and `zH/zO` are constant (±.001) wherever `zO≠0`; their open values equal one pair of constants on every size | spec: one pose, one weight | W | three staggered weights and per-layout poses (E7) |
| T5 | R6 | browser | **G** home at 1440×900, 1288×593, 390×844, 844×390 with a spy on `fillText`/`strokeText` installed before load · **W** scroll through all `BEATS` · **T** (a) spy count is 0; (b) at .36-.45 `.rfw-keys` is visible, inside the stage, lists exactly the 15 spec names in two groups (5 and 10), and its box does not intersect the canvas pixel box; (c) at .54/.63/.72 the legend is hidden and one stop heading is visible; (d) arrow keys move across 15 `.rfw-b` buttons and the name pill shows each name; (e) "If you deliver" is present in the Routes and Delivery rows of `.sy-parts` | draw calls counted at the canvas API; names from the spec | W | names are painted on the canvas (E6); no legend on stage |
| T6 | R7 | browser | **G** home at each of `SIZES`, snap off · **W** 120 even samples of timeline time from 0 to END, each seeked through `_rfw.at(t)` · **T** at each, at least one heading in the words column (the first-screen `h1`, `.rfw-h`, or a stop's title) has opacity ≥ .5 and its top is at or below the header's bottom | the exact schedule in build-plan WP1.2 step 4 | W | desktop: no heading from 0.8 to 6.8 units (JS:688, 708); phone: none from the stick point; about 15% before "One system." (E8, E10) |
| T7 | R8 | browser | **G** home at 1440×900, 1288×593, 390×844 · **W** from the wheel's end, step 0.2 of the window height until `.sy-parts` reaches the header · **T** each window holds either the wheel (pixel box ≥ 15% of the window) or a fully visible heading with its button; at share 1 a visible "Start free trial" link is inside `.rfw` | spec | W | white stage scrolls off before the CTA (E11) |
| T8 | R9 | browser | **G** home at shares .40, .63, 1 · **W** resize 1440×900 → 1288×593 → 390×844 → 844×390 → 1440×900, waiting for ScrollTrigger's `refresh` event each time · **T** the predicates of T3, T5b/c and T6 hold; `ScrollTrigger.getAll().length` equals a fresh load at that size | a fresh load at the same size | W | unknown: recorded by the baseline run, not forced |
| T9 | R10 | browser | **G** home and product at 390×844 and 320×568 · **W** scroll in steps of 0.1 window · **T** no `h2`'s box intersects its next sibling's box while both are in the window | geometry | P | the rise holds an h2 22 px low over a 12 px gap (E13) |
| T10 | R11 | static | **G** the text of every page · **T** none of: straight quotes or apostrophes, "e.g.", "i.e.", "etc.", "click", "log in" as a verb, an exclamation mark, "&" in a sentence, two spaces | Apple Style Guide rules named in the copy ledger | S-copy | to be shown by the audit in WP1.3a |
| T11 | R11 | static | existing `site-truth.static.test.ts` stays green; a changed claim sentence needs its ledger row | the owner's truth list | existing | passes today |
| T12 | R12 | browser | **G** `apps/web/e2e/helpers/site-parity.baseline.json` NEW, captured from master before any change: per page and per size class, every `a[href]` (href + text), `button` (name), form control, `[id]` target, `details`, plus the 15 tile buttons · **W** capture again · **T** the two differ only by rows in `site-parity.changes.json` NEW, each naming an `R#` | the site before the work | P | passes on baseline by construction; goes red on any loss |
| T13 | R13 | static | **T** `public/site` total ≤ 5 MB; `graphics/rf-wheel-up.js` ≤ 80,000 bytes (76,135 at the base; WP0 adds a test hook); `js/vendor/` holds exactly its three files; every script and stylesheet path starts `/site/` | today's sizes (E17, pack §5) | S-budget | passes today; guards the build |
| T14 | R14 | static | **T** (a) each palette value in the token block equals `packages/ui/src/tokens/rovio-palette.json` NEW (read at test time); (b) no file under `public/site` or `components/site-frame` references a retired token; (c) `landing.html`'s inline block equals the block in `rf-graphics.css` | the kit's token file | S-tokens | old values; 12 + 12 + 60 retired references (E17) |
| T15 | R15 | browser | **G** every page at 1440×900 and 390×844, scrolled through · **T** every element with an opaque background covering ≥ 25% of the window is `#FFFFFF`, `#F6F4F0` or `#0E1726` (app-picture frames exempt by a listed selector) | ux-spec §4 | P | lavender, mint, cream, navy bands |
| T16 | R16 | browser | **T** primary buttons resolve to `#0E1726` (white on ink panels); text links to `#8F4E27` on light and `#D69062` on ink; `:focus-visible` outline `#8F4E27`; a contrast walk over every text element gives ≥ 4.5 (≥ 3 for large text), with at least 50 elements walked per page | kit contrast table | P | navy buttons, blue links |
| T17 | R17 | static + browser | **T** (a) copper values appear only in rules on the allow-list in the test (each with its job); (b) no status rule references copper; (c) copper tiles on the wheel: 1 at share 0 (Payments), 0 at .36-.45, 1 at each stop | ux-spec §4, §6 | S-tokens, W | no copper exists |
| T18 | R18 | static + browser | **T** (a) no `gradient(`, `drop-shadow`, `blur(`, `text-shadow`, `<linearGradient`, `<radialGradient`, `feGaussianBlur`, and no `box-shadow` other than `var(--rf-ring)` in site CSS, HTML or the wheel script (vendor excluded); (b) spies on `createRadialGradient`, `createLinearGradient` and `shadowBlur > 0` count 0 through a full scroll; (c) every element's computed `box-shadow` is none or a one-pixel ring | spec | S-tokens, W, P | about 115 declarations and three shadow sprites (E18, pack wheel §7) |
| T19 | R19 | browser | **G** home at 1440×900 and 390×844 · **T** (a) the pixel at the centre of each `.rfw-b` button is, within a small tolerance: bone (two alternating values) on the outer ring, ink (two values) on the inner ring, copper for the tile in focus; (b) the vertical gap between the ink layer's pixels and the bone layer's pixels divided by the wheel's width is equal (±2%) across `SIZES`, which holds because WP1.2 uses one explode distance (review S2) | E24; pixels | W | ten colours |
| T20 | R20 | browser | **T** a table in the test (selector → expected band colour) for home's 14 sections and each other page's bands holds at both sizes | ux-spec §5 | P | tinted bands |
| T21 | R21 | static | **T** `--rf-box-top/front/side` are `#EACBB3/#D69062/#B5683A`; `--app-*` and `--buy-*` resolve only to palette or status values | ux-spec §3 | S-tokens | cardboard and teal values |
| T22 | R22 | browser | **T** on every page the header and footer logos are images whose source is a `rovio-logo-…` or `rovio-symbol-…` file fitting the background; rendered width ≥ 90 px (≥ 160 for the full version); accessible name "Rovio"; no typed name beside them | kit rules (E22) | P | mark PNG plus typed "RouteFlow" |
| T23 | R23 | static + browser | **T** each page's icon link points at an existing `/site/img/rovio-mark-*.png`; `/opengraph-image` answers 200 `image/png`, 1200 × 630, top-left pixel white; the existing icon-name bans stay green | kit; E21 | S-name, P | old mark |
| T24 | R24 | static + browser | **T** the text, title, description, share tags, alt text and labels of all 17 pages contain "Rovio" in the title and no match for `/route\s?flow/i` outside the allow-list (footer line, legal first mention, JSON-LD `alternateName`); JSON-LD `name` is "Rovio" | spec | S-name, P | 172 + 82 old-name strings (E19) |
| T25 | R25 | static | **T** every static page and the site frame's footer contains "© 2026 Rovio, formerly RouteFlow" | spec D5 | S-name | absent |
| T26 | R26 | browser | **G** signed out · **T** `/privacy`, `/terms`, a missing URL, `/login`, `/signup`, the reset page and `/buyer/login` show a Rovio logo file, a title ending in "Rovio", a Rovio tab icon, and no old name outside the allow-list | spec | P | old name and mark |
| T27 | R27 | static | **G** `site-pin-ledger.json` NEW, holding the per-file count of literal pins in the six static test files at the base (`baseline`) and one row per removed pin with `replacedBy` · **T** for each file, current pins + ledger rows for that file = baseline count; each `replacedBy` id appears in a test title in the suite (review S12) | the baseline test files | S-pins | ledger does not exist |
| T28 | R28 | static | **T** `scripts/sync-site-port.mjs` contains no old brand string in what it writes, and exits non-zero unless `--overwrite-site` is passed | spec | S-name | hard-codes the brand (E2) |
| T29 | R30 | static | `npm run verify` (includes `validate-code-map.mjs` and `validate-lessons.mjs`) is green with site rows present in the map | house validators | existing | no site rows in the map |
| T30 | R31, R32 | static + post-deploy | **(a) static:** the redirect table in `apps/web/next.config.mjs` sends each of the 12 public paths (10 site pages, privacy, terms) on host `www.routeflow.info`, when the user agent is not the phone app's shell, to the same path on `https://www.xrovio.com`, query kept, `permanent: false`; it sends no app path (`/login`, `/signup`, `/dashboard`, `/buyer/*`, `/api/*`); its page list equals `STATIC_SITE_PAGE_NAMES` and `STATIC_SITE_PATHS`; each legacy alias reaches its final page in one hop. **(b) post-deploy:** each public path on the old host answers 307 to the matching new URL; `https://xrovio.com/` forwards to `https://www.xrovio.com/`; the new host answers 200 with a valid certificate | the page lists read at test time | S-host, P (post-deploy only) | no rule exists |
| T31 | R33 | static + browser | **T** `site.origin` is `https://www.xrovio.com`; every canonical, `og:url`, sitemap URL, robots line and JSON-LD `url` uses it; `public/site` contains no `routeflow.info` at all; every `mailto:` is `hello@xrovio.com` (ruling D4) | spec | S-host, P | old host everywhere |
| T32 | R34 | e2e (existing) | **G** the current app served on `www.xrovio.com` (checklist C2, weeks before launch) · **W** the CI job runs the existing `setup`, `critical-paths` and `cross-cutting` projects with `PLAYWRIGHT_BASE_URL=https://www.xrovio.com` (a human-dispatched run, per the setup guard) · **T** green | the same suites that guard production today | existing specs | the address does not exist yet |
| T33 | R35 | static + post-deploy | **(a) static:** app paths have no redirect on the old host, and the public-path rules carry the shell user-agent exemption (T30a). **(b) post-deploy:** on `www.routeflow.info`, `/login` answers 200, `/` with a `RouteFlowShell` user agent answers 200 (no redirect), and the existing `cross-cutting` project passes against the old host | the app's behaviour before launch | S-host, existing | passes today; guards launch |
| T34 | R34, R35 | unit (API, Jest) | **G** `WEB_URL=https://www.routeflow.info`, `WEB_ORIGINS=https://www.xrovio.com` · **W** `resolveReturnOrigin` with each of: the old host, the new host, the mobile web address, a look-alike (`https://www.xrovio.com.evil.test`), a trailing-slash variant, `undefined` · **T** the first three come back unchanged; the look-alike and an unlisted host fall back to `WEB_URL`; with `WEB_ORIGINS` empty the behaviour equals today's spec | the existing `auth.controller.return-origin.spec.ts` cases plus the new list | `apps/api/src/auth/auth.controller.return-origin.spec.ts` | the new host falls back to `WEB_URL` (`auth.controller.ts:556-570`) |

## 3. Coverage matrix

| R# | Covered by | R# | Covered by | R# | Covered by |
|---|---|---|---|---|---|
| R1 | T1 | R11 | T10, T11, G-W | R21 | T21, G-D |
| R2 | T2 | R12 | T12 | R22 | T22 |
| R3 | T3 | R13 | T13 | R23 | T23 |
| R4 | T3 | R14 | T14 | R24 | T24 |
| R5 | T4, T19b | R15 | T15 | R25 | T25 |
| R6 | T5 | R16 | T16 | R26 | T26 |
| R7 | T6 | R17 | T17, G-D | R27 | T27 |
| R8 | T7 | R18 | T18 | R28 | T28 |
| R9 | T8 | R19 | T19 | R29 | checklist C1 (not test-proven, by decision) |
| R10 | T9 | R20 | T20, G-D | R30 | T29 |
| R31 | T30 | R32 | T30 | R33 | T31 |
| R34 | T32, T34, checklist C2 | R35 | T33, T34 | R36 | checklist C2 (settings) |

Every `T#` would fail with its feature removed, except T11, T12, T13 and T29, which pass today on purpose:
they are guards that go red if the build loses a claim, a control, weight discipline or bookkeeping.

## 4. Negative tests: what must not happen

| ID | Must not happen | Assertion | File |
|---|---|---|---|
| T1 (return leg) | print leaves motion broken afterwards | trigger count and `js-motion` restored | P |
| T12 | a link, button, anchor or the keyboard control disappears | parity diff | P |
| T17b | copper used as a status colour | static scan | S-tokens |
| T24 (allow-list) | a storage key, cookie or `rf-` identifier is renamed along with the brand | the existing `site-auth-nav.static.test.ts` stays green, unedited | existing |
| existing L7 | a second host name enters `public/site` | `static-site.test.ts` L7 stays green | existing |
| all sweeps | a test passes because it looked at nothing | zero candidates throws | H |

## 5. How to run

```bash
npm test -w apps/web -- "site-"
```

```bash
npm run local:up
```

```bash
node scripts/local-env.mjs --proof-stack --e2e -- "npm --prefix apps/web run test:e2e -- --project=site-proof"
```

The browser project is signed out, has `dependencies: []`, and blocks requests to the analytics host so
its visits are never counted. Against production it runs only from the post-deploy job (TA2); an agent
never points it at a non-local host by hand.

## Stage log (this file's rows)

| Stage | Stop condition | Fired? | Action |
|---|---|---|---|
| P6 Test plan | a requirement nothing can fail for today | once | R29 (launch discipline): accepted as checklist-proven, in writing |
| P6 Test plan | a test with no independent oracle | once | T4 reads the renderer's own camera; kept because R5 is a statement about those values, and T19b checks the same thing from pixels after the repaint |

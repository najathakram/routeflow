# Discovery — why: the Rovio website rebrand, the wheel fixes, then the app

> Run `2026-11-11-rovio-rebrand` · scale **major** · `ui: true` · Status `DRAFT`
> Planned 2026-11-11 against `origin/master` `5fc866853`. Standalone: no reader needs the conversation.
> Deviation: house policy says plan on Opus. The owner switched this session to Fable 5.2 before asking
> for the plan, so it was planned inline here. Gather agents ran on Sonnet per the routing rules.

## 0. Evidence table (P1)

Checked 2026-11-11 unless noted. "pack" = a file in [`packs/`](./packs/). "proof" =
`local-assets/proofs/2026-11-11-rovio-rebrand/` (gitignored, machine-local).

| # | Claim | Source | Kind |
|---|---|---|---|
| E1 | The public site is 10 ready-made HTML pages under `apps/web/public/site`, each served by a rewrite to `app/site-page/[page]/route.ts` | `apps/web/next.config.mjs:87-96`; pack `site-source-and-pins.md` §1 | code |
| E2 | `public/site` was copied from a machine-local design package by `scripts/sync-site-port.mjs`, which hard-codes the brand; no hash or manifest enforces it and the folder has been hand-edited since | `scripts/sync-site-port.mjs:1-14,31,89-177`; commits `30b2dfe23`, `3850ead7f` | code |
| E3 | The live site matches the code on master in structure and headings | proof `live-now/log-*.json` (57/58/35 frames) | observed, not sha-verified |
| E4 | The wheel is ONE `<canvas>` with a hand-written 3D camera; SVG exists only as the no-JS still | `graphics/rf-wheel-up.js:134-139,204,269-951`; pack `wheel-code-map.md` §0-1 | code |
| E5 | The stage is pinned by CSS `position:sticky`; one scrubbed timeline `start:0, end:"bottom bottom", scrub:.7, snap` drives it | `rf-wheel-up.js:667-677`; `rf-wheel-up.css:2-8` | code |
| E6 | Tile names are painted with `fillText`; the fit/hide guards for names run only on small screens | `rf-wheel-up.js:416-479,271-273` | code |
| E7 | Layer heights come from three separately eased weights and two pose sets; phone poses are also shrunk per layout | `rf-wheel-up.js:692-694,378-386,186-187,597-613` | code |
| E8 | No heading shows for about 15% of the scroll between the last stop and "One system." | `rf-wheel-up.js:728` vs `:767`; proof `frames/phone-home-004.jpg`, `desk-home-005.jpg` | code + observed |
| E9 | At 1440×900 the open wheel shows names on every outer tile, hanging inner labels, no heading or legend, blurred shadows | proof `frames/desk-home-002.jpg` | observed |
| E10 | On a phone "One system." is cut off under the header | proof `frames/phone-home-005.jpg` | observed |
| E11 | After the wheel the white stage scrolls away before a one-line CTA and a 15-part list; a short window shows a mostly white screen | proof `sheet-short-home-01.jpg` frames 6-7; `rf-wheel-up.css:2,7` | observed + code |
| E12 | Below-fold content is set to opacity 0 and shown only on scroll; there is no print path | `css/site.css:133`; `js/home-up.js:150-169,180-410`; proof `frames/desk-home-noscroll-full.jpg` | code + observed |
| E13 | The phone rise animation holds an unscrolled h2 22 px low against a 12 px gap to its next line | `css/mobile.css:49-52,20` | code |
| E14 | "Motion always" is deliberate: tests forbid `prefers-reduced-motion` anywhere on the site | `app/(marketing)/site-motion-always.static.test.ts:65-82` | code |
| E15 | Six static test files pin wheel code literals and colour hexes (15 piece hexes, `REST_TINT`, about 25 code strings, three brand rings, 22 tinted cards) | pack `site-source-and-pins.md` §2 | code |
| E16 | Colour tokens live in `graphics/rf-graphics.css:7-21`, are aliased in `css/site.css:6-7`, duplicated as wheel and tint tokens in `css/home-color.css:6-8` and `css/color-deep.css:5-7`, and copied inline in `landing.html:27` | grep | code |
| E17 | Token uses: `--rf-brand-700` 25, `-500` 17, `--rf-link` 16, `-300` 9, `-100` 7, `--rf-sun` 9, `--pc-` 12, `--fld-` 12, `--rf-sh-` 13, `--app-` 138, `--buy-` 22. Raw colour literals: `landing.html` 213, `home.css` 123, `home.html` 108, `rf-wheel-up.js` 81 | `grep -oF "var(<token>"` and hex/rgba count over `public/site` | query |
| E18 | About 115 gradient, shadow or blur declarations across 11 files | grep count per file | query |
| E19 | "RouteFlow" appears 172 times in 18 site files, 56 in `privacy`, 26 in `terms`, and in the site frame's logo and name | `git grep -c`; pack §3-4 | query |
| E20 | Static pages carry their own title, share tags and icon; the share image is code-built at `/opengraph-image`; the root layout owns the app-wide title template and manifests | pack `site-source-and-pins.md` §4 | code |
| E21 | Tests ban the strings `favicon.svg`, `favicon.png`, `/logo.svg` under `app/ components/ public/`; pin every `mailto:` to `hello@routeflow.info`; forbid any other hostname in `public/site` | `marketing-port.static.test.ts:60-86`; `static-site.test.ts` L6, L7 | code |
| E22 | Brand kit v2: palette, logo versions and minimum sizes, icons, tokens, rollout checklist; it names `xrovio.com` and says the name still needs trademark clearance because Rovio Entertainment exists | proof `brand-kit/README.txt`, `ROLLOUT-CHECKLIST.txt` | document |
| E23 | The website guide: six rules, the colour swap table, the fix list | `https://claude.ai/artifact/9gbrir6g4SjKuXAuZh3km7`; proof `guide/*.png` | document |
| E24 | Mock-up fills for the wheel: bone `#E9E4DB`/`#DCD6CB` wall `#C2BBAE`; ink `#1B2638`/`#27364C` wall `#04070D`; copper `#B5683A` wall `#8F4E27` | colour census of the guide's SVG | query |
| E25 | GSAP 3.15.0 with ScrollTrigger and SplitText is vendored; the home page loads gsap + ScrollTrigger only | `js/vendor/*.min.js` headers; `home.html:646-649` | code |
| E26 | Platform emails hot-link `www.routeflow.info/brand/routeflow-mark-192.png`; `BrandMark` has 18 consumers in the app | pack `app-brand-inventory.md` §2 | code |
| E27 | The tenant is read from the `<slug>.routeflow.*` host | `apps/web/lib/tenant-host.ts`; `middleware.ts:16-83` | code |
| E28 | App colour is token-driven (navy 6,562 uses, brand 1,708) from `packages/ui/src/tokens/ledger.ts`; tenants override `--primary` at runtime; emails and PDFs use about 90 hard-coded hexes | pack `app-brand-inventory.md` §3-4 | query |
| E29 | Identifiers that must never be renamed: 13 package names, about 45 storage keys, cookies, bundle id, URL scheme, shell UA token, URL-signing label, test-tenant slugs | pack `app-brand-inventory.md` §6 | query |
| E30 | 476 test files pin brand text, 436 of them API specs | pack `app-brand-inventory.md` §7 | query |
| E31 | The marketing e2e spec 36 is post-deploy only; `PLAYWRIGHT_BASE_URL` has no default | `apps/web/e2e/36-marketing-site.spec.ts:4`; `e2e/LOCAL-LANE.md` | code |
| E32 | Ledger: 65 runs, 33 true-telemetry; true cost runs 4.35× the estimate | `pipeline-ledger.mjs summary` | query |
| E33 | Home page prices shown live are $99 / $249 / $499 | proof `sheet-desk-home-04.jpg` frame 48 | observed |
| E34 | Corrected by review round 1. Settings alone are enough for: tenant detection (the first label of any host, `www` means none), allowed origins (`CORS_ORIGINS`, `CORS_WILDCARD_DOMAINS`), cookies (none sets a domain; the refresh cookie lives on the API host, cross-site to both web hosts already), the Google redirect to the API (env), and the site's own address (`site.origin`). **Not** enough for return addresses: Google sign-in returns only to `WEB_URL` or `MOBILE_WEB_URL` (`apps/api/src/auth/auth.controller.ts:83-85,556-570`), and payment returns build from `WEB_URL` (`stripe-connect.controller.ts:107`, `payment-requests.service.ts:314`, `billing.service.ts:677-679`): an API change, WP2A.0. The root `metadataBase` (`apps/web/app/layout.tsx:52`) is a second writer of the site address | `apps/web/lib/tenant-host.ts`; `apps/api/src/main.ts:86-106`; `review-gate-1.md` facts list | code |

## 0c. Owner rulings, 2026-11-11 (question box, after this plan was drafted)

1. **Everything on one launch day**: the live site does not change until the whole website rebrand is ready.
2. **The site is edited in this repo.**
3. **The site launches on `www.xrovio.com`.**
4. **Sign-in and sign-up pages switch with the website.**

5. **The API change that lets sign-in return to either address (WP2A.0) ships early, on its own** (second box, after review round 1). It is the one exception to ruling 1: brand-free and invisible.
6. **Business sub-addresses: the owner is not sure.** The lead checks before WP2A.1 (A9).
7. **`hello@xrovio.com` replaces `hello@routeflow.info` at launch.** The owner sets up the mailbox before launch day.

Rulings 1 and 3 overrode the recommended defaults. The plan was revised the same day: every package now
builds on one branch, and Phase 2A (the address) was added.

## 1. The problem, in the owner's words

"Please plan the rebranding for the website (desktop and mobile) and the app. We want to first do a
complete rebranding to the website, and then do the app. Also, the wheel has some visual bugs."
The owner also asked that text issues be fixed to Apple's writing style and that the UI meet Apple
design standards with a usability pass.

## 2. Who has this problem

| Role | How often | Cost today | Evidence |
|---|---|---|---|
| A wholesaler visiting the site for the first time | every visit | sees the wheel with labels on top of tiles, layers drifting apart, a missing heading, an empty screen after it | E8-E11 |
| Anyone who prints, saves or previews a page | each time | blank bands and overlapping text | E12, E13 |
| The owner | once | the company is becoming Rovio; the site and app still say RouteFlow in 172 + about 360 places | E19, pack app §1 |

## 3. What they do instead today

Nothing: the bugs are live, and the old name is everywhere. The guide (E23) is the only place the new
look exists.

## 4. Why now

The brand kit and the website guide are finished (E22, E23), and the owner asked to start.

## 5. If we ship nothing

The wheel keeps its bugs on the home page, which is the first screen every prospect sees. The rename
cannot happen. No data is at risk either way.

## 6. Success signal

| Signal | Baseline | Target | Read from | When |
|---|---|---|---|---|
| Signed-out pages that pass the whole site-proof suite at 12 window sizes | 0 of 13 (suite does not exist; known failures E8-E13, E19) | 13 of 13 on production | `site-proof` Playwright project against prod | launch day, then weekly for 4 weeks |
| Guard: trial starts per home visit | `unverified` (A5) | not lower in the two weeks after launch | Umami | launch + 14 days |

## 7. Everyone else affected

| Party | How it touches them | Needs from us | Consulted |
|---|---|---|---|
| Three live paying tenants | sign-in page and emails change name | notice two weeks ahead and on the day (kit checklist) | no: owner action |
| Support mailbox | `hello@` address is on every page | keep `hello@routeflow.info` working; switch only when the new mailbox is confirmed (D4) | no |
| Search and share previews | titles, share image, JSON-LD and the address change | `alternateName: RouteFlow`; page-for-page redirects; Search Console's change of address after day 7 | n/a |
| People with the app open, an installed app or a bookmark on the old address | the old address must keep working | both addresses serve the app until Program C (R35) | n/a |
| Ad campaigns pointing at `/landing` | page art and name change | owner updates ad creative to match | no: owner action |
| Stripe, app stores, email sender | still say RouteFlow until the app program | listed in `program-b-app.md` | n/a |
| Other lanes editing the site | a long-lived branch can conflict | a site freeze for brand-bearing files while the train is open | no |

## 8. Root-cause check

- The rename is a business decision, not a symptom.
- The wheel bugs are symptoms of two choices in the renderer: names are painted inside the canvas, and
  each breakpoint has its own poses and guards (E6, E7). The fix removes both causes: names leave the
  canvas, and one pose plus one fit serve every screen.
- Blank prints are a symptom of hide-then-reveal as the default (E12). The fix makes visible the
  default and lets motion start from it.

## 9. Riskiest assumptions and the cheapest way to kill each

| # | Assumption | If wrong | Cheapest check | Owner |
|---|---|---|---|---|
| A1 | The name Rovio clears trademark review | the rename is wasted | attorney clearance before Phase 2 merges; Phase 1 has no brand in it | owner |
| A2 | The design package is no longer the site's source | a re-sync overwrites the rebrand | one question to the owner; until then the sync script is guarded | owner |
| A3 | The app will follow the same ink / bone / copper rules, so site pictures of the app can show them | pictures and app disagree | settle in the app program's own plan | owner + lead |
| A4 | Live equals master | baselines are off | `site-proof` baseline run in WP0 compares both | lane |
| A5 | Umami can give a 30-day baseline for trial starts per home visit | the guard metric has no baseline | read Umami before launch | lead |
| A6 | Prefixing every GSAP media condition with `screen and` makes print fall back to the static layout cleanly | print stays broken | 30-minute spike at the start of WP1.1 | lane |
| A7 | One pose for every screen still reads well on a phone | the phone wheel looks cramped | change the constants locally and capture three frames before building the rest of WP1.2 | lane + owner eye |
| A8 | With WP2A.0 in place, sign-in, Google sign-in, reset links and payments work on a second host with settings (review round 1 showed settings alone are not enough) | launch day breaks sign-in on the new address | serve the current app on `www.xrovio.com` weeks early and run the existing sign-in and order tests against it from CI (T32), plus one Google sign-in per address by hand | lead + owner (DNS, consoles) |
| A9 | No business uses its own sub-address (`<name>.routeflow.info`) today, so no wildcard record is needed for `xrovio.com` at launch | those businesses have no Rovio address | one question to the owner; if any do, add the wildcard record and certificate | owner |

## 10. The strongest objection, answered

"Everything rides on one launch day: fixes, a new look, a new name and a new address at once. If any
one of them is wrong, which was it?"
The four are built and proven separately even though they ship together. The fixes are finished and
gated before any Rovio colour is added (Phase 1). The address is proven weeks early on the current app,
with no brand in it (T32). Redirects are temporary for a week, so one revert undoes launch day. And
because nothing reaches production before the owner's go, a failed trademark clearance costs nothing
live. The price of this ruling is that the wheel bugs stay on the live site until launch.

## Stage log (this file's rows)

| Stage | Stop condition | Fired? | Action |
|---|---|---|---|
| P0 Frame | trivial | no | major, `ui: true` |
| P1 Ground | capability already exists | partly | a legend exists below the wheel (`.sy-parts`) and in the still (`.rfw-keys`): the plan reuses them, it does not add a third list |
| P2 Interview | owner-owned question unanswered | yes, 4 | asked in one round; all four answered 2026-11-11 (§0c); two answers changed the plan, which was revised |
| P3 Discovery | success signal cannot be stated | no | §6 |

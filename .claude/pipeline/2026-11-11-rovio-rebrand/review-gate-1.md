GATE: FAIL (G1: E34 is wrong, Google sign-in return is one exact WEB_URL, `apps/api/src/auth/auth.controller.ts:83-85,556-570`, and the root `metadataBase` is a second writer of the site origin, `apps/web/app/layout.tsx:52`; G4: the Class 3 host predicate leaves out `apps/web/app/layout.tsx`; G7: no apple-ux or apple-design placement sign-off yet, the spec defers it, `spec.md:240-242`)
VERDICT: REVISE

Reviewed at `origin/master` 5fc866853 (checked with `git rev-parse`). `wc -c graphics/rf-wheel-up.js` = 76135.

## Must-fix

**M1. E34 is wrong: one web origin drives every return address**
- What the plan says: sign-in, OAuth and payments on a second host need settings only (E34, A8, WP2A.1).
- What the code does: the Google `return_origin` is checked against `this.webUrl` or `this.mobileWebUrl` only (`auth.controller.ts:556-570`). Anything else falls back to WEB_URL.
- Before launch (WEB_URL = routeflow.info), a Google sign-in started on www.xrovio.com lands signed in on www.routeflow.info. The C2 hand check would "pass" on the wrong host.
- After launch (WEB_URL = xrovio), a Google sign-in on the old host lands on xrovio. That breaks R35.
- The same single-origin pattern exists elsewhere: `stripe-connect.controller.ts:107`, `payment-requests.service.ts:314`, and the default checkout `success_url`/`cancel_url` (`billing.service.ts:677-679`).
- Fix:
  - Add an API package that reads a setting (e.g. `WEB_ORIGINS`) into the return-origin allow-list, keeping the exact `===` match, and extend `auth.controller.return-origin.spec.ts`.
  - List every return URL built from WEB_URL and decide, per URL, request origin (allow-listed) or WEB_URL.
  - C2 asserts that a Google sign-in returns to the host it started on.
  - This is an API change with no brand in it, but it must be live before WP2A.1. Under D1 that needs an owner question: land it early on master, or accept that the pre-launch Google check cannot run.

**M2. The root `metadataBase` is a second writer of the site origin**
- `metadataBase` is set at `apps/web/app/layout.tsx:52`.
- `marketingMetadata` emits relative `alternates.canonical` and `openGraph.url` (`(marketing)/lib/metadata.ts:49,53`), so privacy and terms resolve against routeflow.info.
- `(marketing)/layout.tsx` sets no `metadataBase` (grep: none). WP2.5 forbids touching `layout.tsx`.
- Result: R33 and T31 cannot go green, and the G1 writer list misses this writer.
- Fix: set `metadataBase: new URL(site.origin)` in `(marketing)/layout.tsx` and in the `(auth)` layouts WP2.6 edits, and add `apps/web/app/layout.tsx` to the Class 3 predicate.

**M3. `fitTo(openBB, box)` returns NaN**
- `fitTo` computes `k = Math.min(boxW/bbW, boxH/bbH, wMax/bbW)` (`rf-wheel-up.js:572-574`). With `wMax` omitted, `undefined/n` is NaN, so k is NaN and the wheel is blank (the same as B1's H1b).
- `bboxOf` takes positional arguments `(tilt, zo, zi, zh, eo, ei)` (`:561`), not a pose object.
- Fix: pass `Infinity`, or change the signature, and spell out `bboxOf(TILT, OPEN.zO, OPEN.zI, OPEN.zH, eo, ei)`.

**M4. The wheel's matchMedia cleanup does not put the still back**
- The `live()` cleanup (`rf-wheel-up.js:938-951`) only removes listeners and deletes fields from the handle. It never calls `still()`.
- It leaves `rfw-live`, the canvas DOM and the 400svh `.rfw` height (`rf-wheel-up.css:2-3`).
- Build plan step 6 states "its cleanup puts the still back (still(), JS:222)" as if it already does. Prefixing the four conditions (`:229`) alone therefore prints a frozen canvas, and T1's `.rfw--static` + svg clause stays red.
- Fix:
  - WP1.2 calls `still()` when no condition matches. `live()` rebuilds on return.
  - The scroll position is restored through `inst.keep` (`:900-904`).
  - T1 asserts that `scrollY` after print equals `scrollY` before.

**M5. The print approach breaks site.js pages, and T1's return leg has the wrong oracle**
- (a) `site.js` uses `{ all: "all", desk: … }` (`site.js:70`). "Every condition starts with `screen and`" gives `screen and all`, which is not a valid query, so it never matches. Motion would silently stop on 8 pages, and T1's trigger counts would pass at 0 = 0. Fix: use `all: "screen"`.
- (b) The WP1.1 snippet replaces `Q` with `desk` and `mob` and drops `pin` (`home-up.js:118-120`). That loses the phone answer-card pin. Fix: keep `pin`, prefixed.
- (c) `site.js:101` removes `js-motion` at every width by design, so "js-motion returns" cannot hold on site.js pages. Also, "legitimately absent on small screens" is not what the code does: home always re-adds it (`home-up.js:132`).
- (d) `paper(true)` runs twice on a real print (the `matchMedia('print')` change and `beforeprint`). The second call sets `had` to false, so leaving print never restores the class. Home recovers only through `section()`.
- Fix:
  - Make `paper` idempotent (`if (on === inPrint) return`).
  - T1 asserts that the class equals its state before print.
  - T1 compares the trigger count with a fresh load at the same scroll position (as T8 does), asserts it is above zero (L-202), and starts from mid-page.

**M6. The plan's own timeline leaves moments with no heading (T6 red by design)**
- (a) Phone: the hero copy sits in the page above the stage (`:589`), and only the desktop hides it in the timeline (`!phone && copy`, `:686`). With `start` moved to the stick point (step 5), the words column is empty from 0 to `T_OPEN-0.4`, about 32% of the phone timeline. ux-spec §6's "0%: first-screen copy" row does not exist on a phone.
- (b) Desktop: the last stop's words hide at `L+HOLD-0.22` = C0-0.22 (`:727`, with `C0 = stopAt(2)+H` at `:194`), but `hx[1]` shows at C0+0.2. Opacity is under .5 for about 0.44 of 18.6 units, 2.4% of scroll, which is wider than T6's 1.7% sample step.
- (c) Step 4 adds tweens beside the existing `show`/`hide(hx[0])` (`:708-709`) instead of replacing them. It hides the legend at FIRST_STOP-0.3, but focus starts at `S0-HOLD` (`:713`), and R6 shows the legend only when no part is in focus. The stop words (`:723`) overlap "Look inside." for 0.5 units.
- (d) `headerTop()` returns undefined (`:211-217`), so step 5 builds `"top undefinedpx"`. Use `pinTop` instead.
- Fix: write the exact schedule. The phone shows a heading in `.rfw-words` from t=0, `hx[1]` starts at C0-0.3, lines 708-709 are replaced, and the legend leaves at `S0-HOLD`.

**M7. Wheel tests scroll with snap on**
- The trigger snaps with a 0.3 s delay through `nearBeat` (`:660-671`). Shares .36 and .45 both snap to "apart" (≈.414), and the gap just before C0 snaps away.
- "Wait for stable progress" therefore reads snapped frames. T3, T5, T6, T7 and T8 skip what a visitor actually scrolls past (T6 goes vacuous on exactly B2's gap) and will flake.
- Fix: WP0 adds a seam, either a `data-rfw-snap="off"` read into `opts.snap` (already supported, `:670`) or seeking with `_rfw.T.progress(p)` plus `redraw()`. T6 samples timeline time.

**M8. T13 contradicts WP0**
- WP0 adds `cam()` to `rf-wheel-up.js`, but T13 caps the file at today's 76,135 bytes and must be green in WP0.
- Fix: record the cap after WP0's harness commit.

**M9. T2 contradicts the wheel's sequenced headings**
- `liveHTML` builds two `h2.rfw-title` ("Look inside.", "One system."), hidden until scrolled by design (grep `<h2` in `rf-wheel-up.js`: 2). T2 requires every `h2` to be at least .99 opaque with no scrolling.
- Fix: scope T2 to exclude `.rfw-live`, since T6 covers those headings.

## Should-fix

- **S1. Installed mobile shell.** `EXPO_PUBLIC_WEB_URL` is `www.routeflow.info` in `apps/mobile/eas.json:47,59`, and the WebView `originWhitelist` is that origin (`app/(shell)/web.tsx:164`). Any shell navigation to `/`, `/privacy` or `/terms` would 307 to a host outside the whitelist. Add the shell to R35 and T33, then decide: exempt the shell UA from the redirect, or accept.
- **S2. One explode distance.** `EXD` and `EXP` differ (`:185`), so T19b's gap-over-width ratio cannot be equal across sizes. Pick one EX or normalise T19b.
- **S3. T3 cleanup.**
  - "Inside the stage" is vacuous because the canvas is the tile (`:628-637`). Assert an inset of at least N px from the canvas edges, which catches clipping.
  - Wait for the `arrive` tween (`:772`, 1.5 s rotation and scale) before reading the rect.
  - Define the 80%-fill box from the DOM.
  - `bboxOf` reserves room for the focus pop (`FS`/`FSI`/`LF`, `:565`), so ±4% centring may miss.
- **S4. T30 counts.** `PUBLIC_PATHS` is 10 + 2 = 12, not 13. `SITE_PAGES` holds names, so compare it with `STATIC_SITE_PAGE_NAMES`, not `Object.values(STATIC_SITE_PAGES)`. `umami-tag.ts:9` `STATIC_SITE_PATHS` is a further list. Legacy aliases (`next.config.mjs:62-75`) chain two hops.
- **S5. Moving `.sy-go`.** Mount replaces `.rfw` innerHTML (`:279`). Say whether mount re-parents the node and `still()` restores it, or whether `liveHTML`/`staticHTML` build it. Keep one source for the href.
- **S6. Reveals after print.** `revealOnce` is rebuilt mid-page after print with `once:true`. `home-up.js:17-21` documents the `once` kill-shift throw. Use `"play none none none"`.
- **S7. Sticky and fixed elements in print.** T1's "nothing sticky or fixed" needs every one listed in the print CSS, including the sticky CTA (`site.js:50`) and the phone answer card, not only `.site-header`.
- **S8. Missing rule.** ux-spec §6 "box under 200 px → still" has no build-plan line.
- **S9. Harness on master.** If WP0 lands on master, TA2 means post-deploy runs `site-proof` on every deploy. Known-red cells (and T30b/T33b) would turn master's E2E red until launch. Keep the harness on the branch, or mark the red cells `test.fail` with their REG ids.
- **S10. Lessons cap.** The register is at 52/52 (`LESSONS-DIGEST.md:3`). R30 has to archive an entry first.
- **S11. Owner questions.** Put D4-D7 and A9 in one owner box now, recommended option first (G10).
- **S12. T27 can pass empty.** It has no baseline count to detect a removed pin. Store the per-file pin counts at baseline.

## Facts verified correct

- `next.config.mjs:1-3` imports only `node:path`, `node:url` and `./csp.mjs`. The rewrites are at 86-96.
- `redirects()` already exists (`:44-75`). Next runs redirects before middleware and `beforeFiles`, so `has: host` rules fit the existing rewrites and headers. Railway keeps the Host header, and query strings carry over automatically.
- `tenantSlugFromHostname` treats `www` as a platform host and keys on the first label. Adding xrovio needs no change to the lists.
- CORS is settings-only (`main.ts:86-106`).
- No auth cookie sets a domain. The refresh cookie is `lax` on the API host, which is `routeflowapi-production.up.railway.app` (`apps/web/Dockerfile:51`). It is cross-site to both web hosts already, so nothing changes.
- The Google redirect URI to the API comes from env (`google-oauth.service.ts:187-202`).
- Umami `data-domains` reads `site.origin` (`umami-tag.ts:32,45`).
- Wheel facts check out:
  - poses at `:186-187` and the phone shrink loop at `:597-613`;
  - three staggered lift weights (`:692-694`) and per-layer close weights (`:756-758`);
  - `p.nd` gates the pill (`:482`, `:556`), so deleting names shows the pill on every tile;
  - `late` serves only names (`:697`, `:703`).
- `js-motion` is set inline on each page (`home.html:27`) and re-added by `home-up` `section()` (`:132`).
- `site.css:133` hides `.reveal`. There is no print path anywhere.

GATE: FAIL (G5: the launch-day WEB_URL flip, and WP2A.0's "payments return to the session's origin" rule, both trip the off-base guard that expires open catch-up Checkout sessions, `apps/api/src/billing/payment-due.service.ts:422-437`; G4: the name and host classes miss the metadata that sign-in pages inherit from the root and buyer layouts, `apps/web/app/layout.tsx:52-73`, `apps/web/app/buyer/layout.tsx:20-31`)
VERDICT: REVISE

Base origin/master. Next is **15.5.28** (`apps/web/package.json:45`), not 14.

## Round-1 items

| Id | Status | Plan line / what is missing |
|---|---|---|
| M1 | FIXED | WP2A.0 lands early on master (ruling §0c.5), T34, WP2A.1 step 6 hand check "returns to the address it started on". See N2 for a missed consumer |
| M2 | PARTLY | WP2A.2 sets `metadataBase` in `(marketing)/layout.tsx` and the `(auth)` layouts, and G4 Class 3 now names `layout.tsx`. Missing: reset-password and buyer/login have no layout of their own (N3) |
| M3 | FIXED | step 3 calls `bboxOf(TILT, OPEN.zO…, EX.o, EX.i)` and `fitTo(…, Infinity)`. Nit S-c |
| M4 | PARTLY | step 6 says "when no condition matches, call still()", but a `gsap.matchMedia().add(conditions, fn)` callback never runs when nothing matches. Name the hook, e.g. `mm.add("print", () => still())` in `start()` (JS:226-231). |
| M5 | FIXED | a `all:"screen"`; b `pin` kept; c T1 asserts the state before print; d `paper` is idempotent |
| M6 | PARTLY | b, c and d are fixed. a creates N1 |
| M7 | FIXED | the wheel is re-mounted with `snap:false` (supported, JS:670) and seeked through `_rfw.at(t)` |
| M8 | FIXED | T13 caps at 80,000. Stale: spec G6 still says "76,135 … pinned by T13" |
| M9 | FIXED | T2 excludes `.rfw-live`. |
| S1 | FIXED | `missing` UA clause; T33b. |
| S2 | FIXED | one `EX = EXD` |
| S3 | FIXED | 8 px inset, waits for the arrival tween, box read from the DOM, ±6% |
| S4 | FIXED | 12 paths, `STATIC_SITE_PAGE_NAMES`, `STATIC_SITE_PATHS`, aliases in one hop |
| S5 | FIXED | one constant feeds `liveHTML` and the still |
| S6 | PARTLY | home-up's reveal is fixed, but the snippet changes `revealOnce(items, rp, y, each)` to `(els, vars)`. That drops `refreshPriority: rp` and the `shown()` filter. `site.js:95-100` has its own `.reveal` batch, `gsap.set(rev,{autoAlpha:0})` with `once:true`, and nothing addresses it, so T2 stays red on 8 pages |
| S7 | FIXED | the print CSS comes from a grep (7 sticky/fixed hits today) |
| S8 | PARTLY | `if (min < 200) return still()` sits inside `layout()`. Calling it there leaves the ticker, the ResizeObserver and the listeners alive on a detached canvas, and a later resize above 200 never rebuilds. Gate it where `live()` is entered, or tear down through the matchMedia context |
| S9 | PARTLY | WP0 says the harness stays on the branch, but the phases table row 0 still says "may also land on master alone" |
| S10 | FIXED | R30 archives an entry first |
| S11 | PARTLY | A9 goes to the lead and D4 is ruled. D5-D7 are still unasked defaults, and the handoff line 400 still says "D1-D8 until the owner rules" |
| S12 | FIXED | `site-pin-ledger.json` gets a `baseline` field; T27 |

## New must-fix

**N1. Phone: at rest, the wheel sits on the heading and legend that now show from t=0**
- Claim: step 4 shows `[hx[0], keys]` at t=0 on a phone. Step 3 re-boxes only `F.apart`, `F.burst` and `F.story`.
- Evidence:
  - The phone's `F.flat` is fitted from `t:14` at the top of the tile (`rf-wheel-up.js:594`).
  - On a phone `.rfw-h` is `justify-content:flex-start` at `top:var(--rfw-in)` (`rf-wheel-up.css:26,90-91`).
  - So "Look inside." is drawn over the resting wheel, and the legend can sit under `F.flat`'s bottom edge (`clamp(low,H-14,vis-40)`).
  - T3 at the `rest` beat ("does not intersect the words column or the legend") goes red by design.
- Fix: on a phone, fit `F.flat` (and the hint) into the same heading-to-legend box as step 3, and add `rest` and `one` to T3's phone beats explicitly.

**N2. The off-base guard on payment return addresses**
- Claim: WP2A.0 says "payments that start in a signed-in app session return to that session's origin", and WP3.1 step 6 flips `WEB_URL`.
- Evidence: `PaymentDueService.returnUrlsOffBase` (`payment-due.service.ts:422-437`) expires any open catch-up session whose `success_url` or `cancel_url` is not under `webBaseUrl()`.
  - (a) pre-launch, a session started on xrovio is expired; (b) on launch day every open session with routeflow.info returns is expired, live payers' links included.
- The plan's grep misses `webBaseUrl()` (`billing.service.ts:665`, `buyer-merge.service.ts:87`).
- Fix:
  - WP2A.0 makes `returnUrlsOffBase` accept the same allow-list (`WEB_URL` + `WEB_ORIGINS`), with a spec that goes red on today's single-base check.
  - WP3.1 step 6 sets `WEB_ORIGINS=https://www.routeflow.info` in the same change as the `WEB_URL` flip.
  - Add `webBaseUrl` and `FRONTEND_URL` to the grep.
  - The per-URL table must also cover `platform-google-auth.controller.ts:93` and `email/mailbox/mailbox.controller.ts:157-226` (mailbox return to `/settings`).

**N3. Sign-in pages inherit RouteFlow metadata, and two of them have no layout**
- Claim: WP2.6 sets title and icon "in their own layouts" and leaves root and `buyer/layout.tsx` alone.
- Evidence:
  - The root sets the title template `"%s · RouteFlow"`, `openGraph.{title,siteName}:"RouteFlow"`, an og image resolved on `routeflow.info`, and `appleWebApp.title:"RouteFlow"` (`layout.tsx:52-73`).
  - `buyer/layout.tsx:20-31` adds "RouteFlow Buyer Portal" and the RouteFlow icons.
  - `(auth)/login/layout.tsx` renders "Sign in · RouteFlow".
  - `(auth)/reset-password/page.tsx` and `buyer/login/page.tsx` are `"use client"` and have no layout, so nothing can be set for them.
  - T24 (share tags) and T26 (title ending "Rovio") are red by design.
- Fix:
  - Add NEW `(auth)/reset-password/layout.tsx` and NEW `buyer/login/layout.tsx` to WP2.6.
  - Each `(auth)` and `buyer/login` layout sets: a title template (or `absolute`), `openGraph` (title, siteName, image), `appleWebApp.title`, `icons` and `metadataBase`.
  - Rule on `manifest` (app-owned, E26): override it or allow-list it in T24.

## Should-fix (new)

- **S-a.** Step 4 says "keep the stop tweens' own shows" and also adds `T.fromTo(tx_[i], …, stopAt(i-1)+HOLD-0.22)`. If line 722's `fromTo(…, L-HOLD)` is kept, it re-zeroes the opacity at `L-HOLD`, which opens a gap of about 0.06 units for i ≥ 1. Say "move line 722's position", not "add".
- **S-c.** Build `openBB` with `EX.o*(1+DRIFT)` and `EX.i*(1+DRIFT)`, as `layout()` does (JS:590). Otherwise the drifted pieces (`dr` reaches 1 from 3.3) overrun the fitted box by about 5%.
- **S-d.** `keys` does not exist in `live()` today. Name the new legend node built in `liveHTML()` and its selector. Step 3's `bottomOf(hdr, hx[0])` does not match `bottomOf(h, e)` (container, then child; JS:576). Use `bottomOf(hx[0], hx[0].querySelector(".rfw-sub"))`.
- **S-e.** Stale: WP2A.1 dependsOn "if Q1 lands it early"; spec G6 76,135.

## Facts verified

- **Cross-fades, step 4.** OUT = power3.out, IN = power2.in. At the outgoing heading's 0.5 point (70.7%), the incoming one is:
  - desktop copy (0.5 IN) → hx[0] (0.5 OUT): 0.975;
  - hx[0] (0.16 IN) → tx_[0] (0.3 OUT): 0.76;
  - stop → stop (0.16 IN / 0.3 OUT, same start): 0.76;
  - last stop → hx[1] (0.4 OUT at C0-0.22): 0.63.
  
  So at least one heading stays at or above 0.5 throughout, on both layouts, with S-a applied.
- **Desktop copy.** `.hx-over` is sticky with js-motion (`css/home-up.css:9`), so keeping the copy until `T_OPEN-0.4` leaves it on screen.
- **`headerTop()`** returns undefined (JS:211-217). `pinTop` is set at JS:579 and JS:645, so `start: () => "top "+pinTop+"px"` is valid.
- **`still()`** (JS:222) is DOM-safe from a matchMedia handler: `live()` rebuilds innerHTML (JS:276-279); `inst.keep` survives cleanup and `finish()` restores it (JS:917-922). Nested `metadataBase` wins (`next/dist/lib/metadata/resolve-metadata.js:135`). Shell UA token `RouteFlowShell` (`shell-bridge.ts:21`, `web.tsx:163`); Next anchors `^…$`.



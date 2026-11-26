GATE: FAIL (G4: the root `apps/web/app/favicon.ico` is prepended to every route's icons, so no sign-in or marketing layout can give a Rovio tab icon and T26 is red by design; WP1.2 step 3: the phone end pose is fitted under `hx[0]`, so T3's phone `one` beat is red by design)
VERDICT: REVISE

Base: origin/master. Round 3. Two small new must-fix items; everything else from round 2 holds.

## Round-2 items

| Id | Status | Plan line / what is missing |
|---|---|---|
| N1 | PARTLY | WP1.2 step 3 fits phone `F.flat` into the heading-to-legend box, and T3 adds `rest` and `one`. Two problems remain, see N4 |
| N2 | FIXED | WP2A.0 "Why" + Files (`returnUrlsOffBase` takes the allow-list; grep has `webBaseUrl\|FRONTEND_URL`; platform-google-auth:93 and mailbox listed). WP3.1 step 6 flips `WEB_URL` and `WEB_ORIGINS` together. G5 matches. Should-fix S-f, S-g |
| N3 | PARTLY | WP2.6 adds the two NEW layouts and the full metadata list. The root favicon still leaks, see N5. Should-fix S-h |
| M2 | FIXED | WP2A.2 Files + WP2.6 `metadataBase` on every sign-in layout, including the two new ones |
| M4 | FIXED | step 6 `mm.add("print", () => { still(); })`. GSAP reverts every toggled context before it runs any newly matched one (vendor `gsap.min.js`, `Hc()`: `t.revert()` in the loop, then `o.forEach(onMatch)`), so live's cleanup (JS:938-951) runs first, then `still()`. Leaving print: the print branch's revert is a no-op, and live() rebuilds with `inst.keep`. The wheel mounts with no opts (JS:956), so the lazy `rfw-wait` path never applies to print |
| M6 | PARTLY | b-d were fixed in round 2. a is now N4 |
| S6 | FIXED | WP1.1 step 3 keeps `(items, rp, y, each)`, `rp` and `shown()`, and names the `site.js:95-100` batch |
| S8 | PARTLY | the decision moved to the branch, which is right. But "a resize re-runs the branch" is false: a gsap.matchMedia branch re-runs only when one of its conditions toggles. Express the floor as media conditions (for example a `tiny` key on the viewport sizes that give a stage under 200 px, with the live keys excluding it), so a resize across it reverts and rebuilds. Should-fix |
| S9 | FIXED | phases table row 0: "branch only" |
| S11 | FIXED | §4 D4-D7 ruled; handoff says D1-D8 settled. Nit: G10 still says "D4-D7 are stated defaults", and the §4 heading still says "defaults still open" |
| S-a | FIXED | step 4 "MOVE the existing show at JS:724" |
| S-c | FIXED | `openBB` uses `EX.o * (1 + DRIFT)` and `EX.i * (1 + DRIFT)` |
| S-d | FIXED | `legend` is the NEW `.rfw-legend` node; `bottomOf(hx[0], hx[0].querySelector(".rfw-sub"))` |
| S-e | FIXED | WP2A.1 dependsOn "WP2A.0 live on production"; G6 says "80,000 (76,135 at the base…)" |

## New must-fix

**N4. Phone: the end pose overlaps the end heading, and the hint has no room**
- Step 3: `if (phone) F.flat = F.end = fitTo(…, box)`. The box's top is `hx[0]`'s sub.
- At beat `one` (END-0.3, `planOf` JS:195) the heading on screen is `hx[1]`, not `hx[0]`. `hx[1]` now also holds the moved `.sy-go` button ("End state" bullet), and both `.rfw-h` sit at the top on a phone.
- Today `F.end` has its own box under `hx[1]`'s sub + 18 (JS:599). The plan overwrites it, so T3 `one` on a phone goes red by design.
- `hintAt` places the hint 6 px under the wheel (`F.flat.y + k*flatBB.y1 + 6`, JS:591). With `box.b = legend.offsetTop - 12`, the hint overlaps the legend. The comment says the hint fits the box, but the code reserves no room for it.
- Fix:
  - Keep a separate phone `F.end`, fitted from below `hx[1]`'s last child (the button) to `H - 18`.
  - Fit `F.flat` with `b = legend.offsetTop - 12 - hint.offsetHeight - 6`.
  - Have T3 `rest` check that the hint does not intersect the legend.

**N5. The root favicon is put first on every route**
- `apps/web/app/favicon.ico` is the RouteFlow mark from #657 (d0ca101de).
- Next 15 collects the root favicon and `unshift`s it into `icons.icon` after every layout has merged (`next/dist/lib/metadata/resolve-metadata.js:572-579, 658-663`).
- So the `icons` that WP2.6 sets on the sign-in layouts, and on `(marketing)/layout.tsx` for privacy and terms, still emit `/favicon.ico` (RouteFlow) as the first icon. T26 ("a Rovio tab icon") is red by design. WP2.5 and WP2.6 leave the app root alone.
- Fix: rule it in WP2.6. Either
  - (a) replace `favicon.ico` at launch (it is app-wide, so this is a Program B touch and needs the owner), or
  - (b) move it to `public/` and reference it from the root `metadata.icons`, so child `icons` replace it.
- Then add it to G4 Class 4's predicate (file-based metadata: `favicon.ico`, `icon.*`, `apple-icon.*`, `opengraph-image.*` on the route path).

## Should-fix

- **S-f.** T34 has no `returnUrlsOffBase` case, although WP2A.0 promises one.
  - Add: allow-list `[routeflow, xrovio]`; a session returning to either is kept; `https://www.xrovio.com.evil.test/x` is expired.
  - Each entry keeps today's `u === o || u.startsWith(o + "/")` form (payment-due.service.ts:432-434).
  - Parse `WEB_ORIGINS` like `webBaseUrl()` (`config/web-base-url.ts:31-60`): trim, strip trailing `/`, and refuse loopback in production.
- **S-g.** WP3.1 step 7's rollback says "put `WEB_URL` back" only. It should restore the pair: `WEB_URL` back to routeflow.info and `WEB_ORIGINS` back to xrovio. Otherwise sessions on xrovio (still served after a rollback) fall back or are expired.
- **S-h.** Next replaces `appleWebApp` whole (resolve-metadata.js:170-171). Each sign-in layout that sets `appleWebApp.title` must restate `capable: true` and `statusBarStyle` (and a Rovio `startupImage`), or `/login` loses them. Also: `viewport.themeColor` is inherited (`#0E1F36` root, `#047857` on `buyer/login`). Set `viewport` in the sign-in layouts if the Rovio look wants white (ux-spec §6 line 169).

## Facts verified (origin/master)

- **`returnUrlsOffBase`** (payment-due.service.ts:422-437) is described correctly: it compares both URLs against one `webBaseUrl()` and returns true, so the caller expires the session.
- **Phone `flatBB`.** `bboxOf(0,0,0,0,0,0)` equals today's `bboxOf(0,0,0,0)` (JS:585; `eo`/`ei` default to 0), so `F.flat` is a sensible rest pose. Only the box (N4) is wrong.
- **Metadata writers on the sign-in routes:**
  - root `viewport` + `metadata` (layout.tsx:40-75). Its literal `<head>` (line 85) holds only the shell script.
  - `buyer/layout.tsx` `viewport` + `metadata` (7-31).
  - `metadata` in the `(auth)/login`, `signup` and `forgot-password` layouts.
  - root `app/favicon.ico`.
  - No `generateMetadata`, no `head.tsx`, and no `(auth)` group layout.
- **Print** uses GSAP's revert-then-match order, as above.

# Build plan: the Rovio website (Program A), in phases

> **Stage P7.** Authored 2026-11-11 against `origin/master` `5fc866853`. Status: `DRAFT`.
> Derived from [test-plan.md](./test-plan.md). Inputs: [discovery.md](./discovery.md) (why, `E#`, `A#`),
> [spec.md](./spec.md) (`R#`, defaults `D#`), [ux-spec.md](./ux-spec.md) (look, token block, gates),
> [packs/](./packs/) (code facts with line numbers). This file stands alone for an implementer.
> Paths are relative to `apps/web/public/site/` unless they start with `apps/` or `scripts/`. NEW marks a path this work creates.
> The app (Program B) and retiring the old address (Program C) are outlined in [program-b-app.md](./program-b-app.md).
> **Owner rulings 2026-11-11** ([discovery.md](./discovery.md) §0c): everything goes live on one launch
> day; the site is edited in this repo; the site launches on `www.xrovio.com`; sign-in pages switch with
> the site. So every package below builds on ONE long-lived branch, `rebrand/rovio-site`, cut from
> `master`, and nothing reaches `master` until WP3.1.

## Evidence & assumptions

Facts: [discovery.md](./discovery.md) §0. Rows used only here:

| # | Claim | Source |
|---|---|---|
| BE1 | The engine is `.claude/skills/dev-pipeline/pipeline.js` (project copy wins) | `ls` 2026-11-11 |
| BE2 | Web unit tests run with `npm test -w apps/web`; the full gate is `npm run verify`; the local stack is `npm run local:up`; e2e goes through `node scripts/local-env.mjs --proof-stack --e2e -- "…"` | root `package.json:13,38,50`; `apps/web/package.json:13,15` |
| BE3 | A proof needs images built from the commit under proof (`PROOF_STACK_REQUIRE`) | `apps/web/e2e/LOCAL-LANE.md` |
| BE4 | Run-log lessons that shape this plan: write the shared contract before parallel lanes (2 entries); the engine's red gate refuses tests that already pass; true cost runs 4.35× any estimate, so none is given here | `dev-pipeline/references/RUN-LOG.md` (2026-11-09 entries); E32 |
| BE5 | Lessons applied: L-194 (prove from the worktree's own server and check what is served), L-199 (structural proof before removing CSS), L-200 (grep every entry point before removing a control), L-202 (zero candidates is an error), L-205 (assert behaviour, not source text), L-206 (read pinned values at test time), L-211 (the target goes in the command), L-212 (no layout-class selectors) | `.claude/lessons/LESSONS-DIGEST.md` |

Assumptions are A1-A7 in [discovery.md](./discovery.md) §9 and TA1-TA3 in [test-plan.md](./test-plan.md). The riskiest is A1 (the name clears).

## How the work is routed

- **Phase 0** is a hand light loop (harness and baselines; its guard tests pass on purpose, which the engine's red gate would refuse, BE4). Logged as a deviation.
- **Phase 1** fixes known defects: enter through `bug-pipeline`, engine in `mode: 'bugfix'`. Four registry ids are filed in WP0 with `bugs.mjs` from a fresh fetch.
- **Phase 2** is new look: `dev-pipeline`, `mode: 'feature'`, on the branch `rebrand/rovio-site`.
- **Models:** builders Sonnet at `medium` (`high` for WP1.2 and WP2.2, the canvas maths); test authors Sonnet at `medium`; every review Opus at `medium` (`high` for WP1.2); mechanics Haiku at `low`. No agent inherits the session's effort.
- **Skills each package must load first:** named per package. `gsap-skills:gsap-scrolltrigger` and `gsap-skills:gsap-plugins` for anything touching motion; `apple-design` for look and motion; `apple-write` for words; `apple-ux` runs the gate.
- **Where it runs:** builds and Docker proofs on the Mac mini lane through the heavy slot; this PC coordinates. Fresh worktree from `master`, then `npx husky` and `npm ci` in it.
- **Board:** one epic "Rovio rebrand: website" with one ticket per package, filed through `plane:apply`. No ticket, no work.
- **Design gate:** run `future-proof` on this plan before Phase 1 starts; record its verdict in the stage log.

## Phases at a glance

| Phase | What it builds | Where it lives until launch | Size |
|---|---|---|---|
| 0 | proof harness, baselines, bug ids | branch (the harness may also land on `master` alone: it changes nothing visible) | S |
| 1 | print and no-scroll fix, wheel layout fix, wording pass | branch; gate G1 before Phase 2 starts | L |
| 2 | the Rovio look, logo, name, sign-in pages | branch | XL |
| 2A | the address: `www.xrovio.com` served and proven weeks early with no brand on it; redirects and `site.origin` on the branch | settings now, code on the branch | M |
| 3 | launch day and four weeks of checks | one merge commit on the owner's go | S |

**Branch discipline (the cost of the one-day ruling):** merge `master` into `rebrand/rovio-site` every
day (never rebase); one coordinator owns the branch; each package is its own PR **into the branch**,
reviewed like a PR to `master`; announce a freeze on edits to `apps/web/public/site/`,
`components/site-frame/` and the `(marketing)` and `(auth)` folders on `master` while the branch is
open, and port any urgent fix there into the branch the same day.

## Work packages

### WP0 · Proof harness and baselines
- **satisfies:** R12, R13 (guards); enables every other package · **provenBy:** T12, T13 green on the baseline; T1-T9 run and their baseline failures saved
- **dependsOn:** none · **risk:** low · **skills:** none
- **Files:** NEW `apps/web/e2e/84-site-proof-wheel.spec.ts`, NEW `apps/web/e2e/85-site-proof-pages.spec.ts`, NEW `apps/web/e2e/helpers/site-proof.ts`, NEW `apps/web/e2e/helpers/site-parity.baseline.json`, NEW `apps/web/e2e/helpers/site-parity.changes.json`, NEW `apps/web/app/(marketing)/site-rovio-budget.static.test.ts`, `apps/web/playwright.config.ts` (add project `site-proof`: `testMatch /8[45]-site-proof-.*\.spec\.ts/`, `dependencies: []`, no storage state), `graphics/rf-wheel-up.js` (add a read-only `cam()` to the existing `_rfw` handle), `.claude/code-map/` rows for the site.
- **Do:** confirm 84 and 85 are still free after a fresh fetch. Capture the parity baseline from `master`. Write T1-T9 and T12-T13 exactly as the test plan states them. Run the browser project on the local stack and save which cells fail to `local-assets/proofs/2026-11-11-rovio-rebrand/baseline-red.json`: that file is the reproduction for the four bugs. File the bugs (wheel fit and labels; layer gaps and missing heading; empty screen after the wheel; blank prints).
- **Also in WP0 (design gate, G7 and the area sweep):** (1) run `/apple-ux --quick` on the local stack built from `master` at 1440×900 and 390×844; its vital few join WP1.2 or the copy ledger. (2) apple-ux and apple-design each sign the guide's placements (legend beside the wheel, the button in the wheel's end state, copper focus) with reasons, written into `ux-spec.md` §6; a disagreement goes to the owner before WP1.2. (3) Re-verify B249 and B250 on `master` and close them as stale with the evidence, or move them into this branch.
- **Review round 1 (`review-gate-1.md`) rules for the harness:**
  - **No snap in wheel tests (M7).** The helper re-mounts the wheel through its public API with snap off, `RFWheel.mount(el, { refreshPriority: 0, scrub: 0.7, snap: false, top: null, copy: ".hx-copy" })` after `el._rfw.destroy()` (the options documented at `rf-wheel-up.js:3`). It seeks by timeline time, scrolling to `_rfw.at(t)`, and waits for `settle()`. It waits for the canvas's 1.5 s arrival tween before reading pixels (`:772`).
  - **The harness stays on the branch (S9).** The post-deploy job runs every project (TA2), so known-red cells would turn `master` red. It lands with launch.
  - **Pin counts (S12).** WP0 records how many literal pins each of the six static test files holds, in `site-pin-ledger.json` (`baseline` field). T27 compares against that number.
  - **Budget (M8).** T13 caps the wheel script at 80,000 bytes: 76,135 at the base, plus WP0's `cam()` hook.
- **The two probes every wheel test stands on** (put in the helper):

```ts
// Before any page script: count what the wheel really draws.
await page.addInitScript(() => {
  const n = ((window as any).__rfDraw = { text: 0, gradient: 0, shadow: 0 });
  const P = CanvasRenderingContext2D.prototype as any;
  for (const m of ["fillText", "strokeText"]) { const o = P[m]; P[m] = function (...a: unknown[]) { n.text++; return o.apply(this, a); }; }
  for (const m of ["createRadialGradient", "createLinearGradient"]) { const o = P[m]; P[m] = function (...a: unknown[]) { n.gradient++; return o.apply(this, a); }; }
  const d = Object.getOwnPropertyDescriptor(P, "shadowBlur")!;
  Object.defineProperty(P, "shadowBlur", { get: d.get, set(v: number) { if (v > 0) n.shadow++; d.set!.call(this, v); } });
});

// The box of what the canvas shows, in window pixels. Throws when it sees nothing (L-202).
const wheelBox = (page: Page) => page.evaluate(() => {
  const cv = document.querySelector<HTMLCanvasElement>("canvas.rfw-cv")!;
  const r = cv.getBoundingClientRect(), w = cv.width, h = cv.height;
  const px = cv.getContext("2d")!.getImageData(0, 0, w, h).data;
  let l = w, t = h, rt = -1, b = -1;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4;
    if (Math.abs(px[i] - px[0]) + Math.abs(px[i + 1] - px[1]) + Math.abs(px[i + 2] - px[2]) > 24) { if (x < l) l = x; if (x > rt) rt = x; if (y < t) t = y; if (y > b) b = y; }
  }
  if (rt < 0) throw new Error("wheel canvas is blank");
  const sx = r.width / w, sy = r.height / h;
  return { l: r.left + l * sx, t: r.top + t * sy, r: r.left + rt * sx, b: r.top + b * sy };
});
```

### WP1.1 · Complete pages in print and without scrolling
- **satisfies:** R1 (pages), R2, R10 · **provenBy:** T1 (all clauses but the wheel's), T2, T9, T12
- **dependsOn:** WP0 · **risk:** medium · **skills:** `gsap-skills:gsap-scrolltrigger`, `gsap-skills:gsap-plugins`, `apple-design`
- **Files:** `js/home-up.js`, `js/site.js`, `css/site.css`, `css/mobile.css`, `css/home-up.css`, `css/home.css` (pinned layouts only), `apps/web/app/(marketing)/site-motion-always.static.test.ts` (two media-condition pins move to the ledger), `apps/web/e2e/36-marketing-site.spec.ts` only if T21 there needs the same change.
- **First 30 minutes (A6):** prefix the conditions, emulate print in a browser, confirm the static layout appears. If it does not, stop and report.
- **Exact shape of the tricky parts:**

```js
/* 1. Every media condition is screen-only, so print reverts all motion through GSAP's own matchMedia. Prefix each
      comma-separated part with "screen and"; a bare "all" becomes "screen" ("screen and all" is not a valid query and
      would silently stop motion on the 8 site.js pages, review M5a). Keep every existing key: home-up.js's Q has
      desk, mob AND pin (home-up.js:118-120); site.js has all and desk (site.js:70). */
// home-up.js
const Q = { desk: "screen and (min-width: 900px) and (min-height: 600px)",
            mob:  "screen and (max-width: 899.98px), screen and (max-height: 599.98px)",
            pin:  /* today's pin condition, each part prefixed with "screen and" */ };
// site.js
mm.add({ all: "screen", desk: "screen and (min-width: 900px)" }, (ctx) => { /* unchanged body */ });

/* 2. Print uses the static layout. Same lines in home-up.js and site.js. Idempotent, because a real print fires both
      the print media change and beforeprint (review M5d). It restores exactly the state before print: site.js removes
      js-motion at every width by design (site.js:101), home-up.js re-adds it (home-up.js:132). */
const root = document.documentElement; let inPrint = false, had = false;
const paper = (on) => {
  if (on === inPrint) return;
  inPrint = on;
  if (on) { had = root.classList.contains("js-motion"); root.classList.remove("js-motion"); }
  else { root.classList.toggle("js-motion", had); ScrollTrigger.refresh(); }
};
matchMedia("print").addEventListener("change", (e) => paper(e.matches));
addEventListener("beforeprint", () => paper(true));
addEventListener("afterprint", () => paper(false));

/* 3. Reveals start from visible. Was: hide at load, show on scroll (home-up.js:150-156; css/site.css:133, which is deleted).
      Not once:true: matchMedia rebuilds these mid-page after print, and home-up.js:17-21 documents the kill-shift throw of
      once (review S6). */
const revealOnce = (els, vars) => ST.batch(els, { start: "top 104%", toggleActions: "play none none none",
  onEnter: (batch) => g.from(batch, { opacity: 0, y: 16, duration: 0.6, ease: "power2.out", stagger: 0.06, overwrite: true, ...vars }) });
```

```css
/* Every sticky or fixed element on the site, listed by a grep for "position:sticky" and "position:fixed" across
   public/site in WP1.1 (review S7): today at least the header, the phone sticky CTA (site.js:50) and the phone answer card. */
@media print{
  *,*::before,*::after{animation:none!important;transition:none!important}
  .site-header, /* …every selector the grep finds… */ {position:static!important}
}
```
- Scrubbed section intros (`home-up.js:180-410`) keep their motion, but a section's `h2` is no longer in the hidden set (R2).
- Phone rise (`css/mobile.css:49-52`): move a heading together with the line after it, or cap the offset at the gap between them, so the two never overlap (R10).

### WP1.2 · The wheel fits, names sit beside it, nothing is empty
- **satisfies:** R1 (wheel), R3, R4, R5, R6, R7, R8, R9, R12, R13, R27 · **provenBy:** T1 (wheel clause), T3, T4, T5, T6, T7, T8, T12, T13, T27
- **dependsOn:** WP1.1 · **risk:** high (most pinned file on the site) · **skills:** `gsap-skills:gsap-scrolltrigger`, `gsap-skills:gsap-plugins`, `apple-design`
- **Files:** `graphics/rf-wheel-up.js`, `graphics/rf-wheel-up.css`, `home.html` (the still's markup; `.sy-go` moves into the wheel's end state), `css/home-up.css` (`.sy-go`, `.sy-parts`, legend layout), NEW `apps/web/app/(marketing)/site-pin-ledger.json`, NEW `apps/web/app/(marketing)/site-rovio-pins.static.test.ts`, and the pins in `site-mobile-pass`, `site-motion-always`, `site-phone-and-motion`, `site-founder-card-width`, `site-color-and-life` `.static.test.ts` that name code this package deletes.
- **First hour (A7):** set one pose and one weight locally, capture 390×844 at the open point and at one stop, show the owner. Go on only if it reads well.
- **Shape of the change** (names as in the file today, see `packs/wheel-code-map.md`; adapt the exact object shapes when you open it):

```js
/* 1. One pose and one explode distance for every screen. Replaces POSE_D / POSE_P (JS:186-187), EXD / EXP (JS:185, so the
      gap-to-width ratio is equal everywhere, review S2) and the phone loop that shrinks poses (JS:597-613). */
const OPEN = POSE_D.story;  // { zO: -170, zI: 390, zH: 720 }
const EX = EXD;             // { o: 190, i: 104 }

/* 2. One lift weight. Replaces S.lH, S.lI, S.lO and their staggered tweens (JS:692-694), the close weights hO/hI/hH
      (JS:758-760) and the apart→story blend by wS in pose() (JS:378-386). Camera tilt and scale still move. */
T.to(S, { lift: 1, duration: 5.2, ease: HEAVY }, 0.7);
T.to(S, { lift: 0, duration: 2.7, ease: HOME }, C0 + 0.05);
cam.zO = OPEN.zO * S.lift; cam.zI = OPEN.zI * S.lift; cam.zH = OPEN.zH * S.lift;   // inside pose()

/* 3. One fit from the smaller side of one box. bboxOf takes positional arguments (JS:561) and fitTo needs a width cap or
      it returns NaN (JS:572-574, review M3). */
const openBB = bboxOf(TILT, OPEN.zO, OPEN.zI, OPEN.zH, EX.o, EX.i);
const box = sideBySide
  ? { l: colR + gap, t: pad, r: W - pad, b: H - pad }                                // right of the words column
  : { l: 8, t: bottomOf(hdr, hx[0]) + 12, r: W - 8, b: keysTop - 12 };               // between the heading and the legend
F.apart = F.burst = F.story = fitTo(openBB, box, Infinity);
if (Math.min(box.r - box.l, box.b - box.t) < 200) return still();                  // too small to read: the still (ux-spec §6, review S8)

/* 4. The words column is never empty (review M6). Exact schedule; replaces JS:688 (desktop hero copy hide at 0.1) and
      JS:708-709 (show/hide hx[0]); keep the stop tweens' own shows; HOLD = STOP / 2. A hand-over is a cross-fade that
      starts both tweens at the same time, so one heading is always at least half visible. */
if (!phone && copy) T.to(copy, { autoAlpha: 0, y: -28, duration: 0.5, ease: IN }, T_OPEN - 0.4);
if (phone) T.set([hx[0], keys], { autoAlpha: 1, y: 0 }, 0);  // phone: "Look inside." is already up when the stage sticks
else show([hx[0], keys], T_OPEN - 0.4, 0.5);
hide([hx[0], keys], S0 - HOLD);                            // leaves as the first stop's words arrive at S0 - HOLD (JS:724)
// in stopTweens: the old stop's words start leaving at L + HOLD - 0.22 (JS:728); the next stop's words start at that same time
T.fromTo(tx_[i], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.3, ease: OUT }, i ? stopAt(i - 1) + HOLD - 0.22 : S0 - HOLD);
show(hx[1], C0 - 0.22, 0.4);                               // was C0 + 2.9 (JS:767); starts as the last stop's words leave

/* 5. On a phone the timeline starts when the stage sticks, not at page scroll 0 (JS:669). headerTop() returns nothing
      (JS:211-217); use pinTop, which layout() reads at JS:579 (review M6d). */
start: () => (phone ? "top " + pinTop + "px" : 0),

/* 6. Print and other no-match states (review M4). The live() cleanup (JS:938-951) does not put the still back today. When no
      condition matches, call still() (JS:222), which restores the static markup and height; when a condition matches again,
      live() rebuilds and the scroll position comes back through inst.keep (JS:900-904). Each condition gains "screen and". */
```
- **The end-state button (review S5):** `mount` replaces `.rfw`'s inner HTML (JS:279), so `.sy-go` is built by both `liveHTML()` and the still's markup from one constant holding its text and `href`; the static test reads that constant, never a second copy.
- **Delete, do not hide:** every `fillText` of a part name (outer names JS:416-452, hanging inner labels JS:453-479) and the guards that only served them (`shy`, `drop`, `out`, `late`, JS:441, 465-471, 697). The hover pill and the 15 buttons stay; the pill now shows on every tile.
- **Legend:** render the existing `.rfw-keys` lists inside the live stage (they are built by `li(d)` for the still, JS:132), `aria-hidden="true"`, laid out per [ux-spec.md](./ux-spec.md) §6. Do not add a new list.
- **End state:** "Try it with your own orders." and its button move from after the stage into the `h1` group, keeping the `.sy-go` class and the same link (parity).
- **Pins (R27):** before deleting a pinned literal, find the commit that added the pin (`git log -S`), write one ledger row: the literal, the bug it guarded, the `T#` that now guards that behaviour. A literal whose behaviour still exists is kept and read from the source at test time.
- **Not in this package:** colours, shadows and the hub mark (WP2.2).

### WP1.3a · Wording audit · WP1.3b · Apply the approved ledger
- **satisfies:** R11 · **provenBy:** T10, T11, T12; gate G-W
- **dependsOn:** 1.3a none (read-only, starts on day one); 1.3b on 1.3a's approval and WP1.2 · **risk:** low · **skills:** `apple-write`
- **Files (1.3a):** NEW `.claude/pipeline/2026-11-11-rovio-rebrand/copy-ledger.md` (page, old string, new string, rule). **(1.3b):** the ten `*.html`, `apps/web/app/(marketing)/privacy/page.tsx`, `terms/page.tsx`, `apps/web/components/site-frame/*.tsx` (strings only), NEW `apps/web/app/(marketing)/site-rovio-copy.static.test.ts`, the matching pins in `site-truth` and `site-company-contact` tests.
- **Do:** audit from the rendered text in `local-assets/proofs/2026-11-11-rovio-rebrand/live-now/text/`. Names stay "RouteFlow" in this phase. The owner approves the ledger in one sitting before 1.3b starts. Legal pages: wording only, no change of meaning; any change there is flagged in the ledger for the owner's attorney.

### Gate G1 (end of Phase 1)
`apple-ux` pass on the local stack at 1440×900 and 390×844; `apple-design` sign-off on legend, focus and end state; `pre-merge-review` PASS at the exact sha; proof sheets at 1440, 768 and 390 to the owner. Phase 1 stays on the branch (ruling D1); Phase 2 starts only after this gate, so the fixes are judged before any colour changes. The four bugs close when the launch deploy goes green.

### WP2.0 · Token contract and brand files (lands first on the branch)
- **satisfies:** R14 (values), R22, R23 (files) · **provenBy:** T14a · **dependsOn:** gate G1 passed on the branch · **risk:** low · **skills:** none
- **Files:** `graphics/rf-graphics.css` (the block in [ux-spec.md](./ux-spec.md) §3, added BESIDE the old names, which stay as aliases until WP2.1's last commit), NEW `packages/ui/src/tokens/rovio-palette.json` (the kit's `rovio-tokens.json`, unchanged: the one copy of the palette, which Program B's ledger will read too), NEW `img/rovio-logo-horizontal-small-colour.svg`, NEW `img/rovio-logo-horizontal-small-colour-reversed.svg`, NEW `img/rovio-symbol-colour-reversed.svg`, NEW `img/rovio-mark-48.png`, `-180.png`, `-192.png`, `-512.png` (kit `icons/web/` files renamed), NEW `apps/web/app/(marketing)/site-rovio-tokens.static.test.ts`.
- Kit files are in `local-assets/proofs/2026-11-11-rovio-rebrand/brand-kit/`. Copy them; never redraw or retype the logo.

### WP2.1 · Repaint and flatten the site's CSS
- **satisfies:** R14, R15, R16, R17, R18, R20, R21 · **provenBy:** T14b, T15, T16, T17a-b, T18a, T18c, T20, T21
- **dependsOn:** WP2.0 · **risk:** medium · **skills:** `apple-design`
- **Files:** `css/site.css`, `css/home.css`, `css/home-color.css`, `css/color-deep.css`, `css/home-up.css`, `css/product.css`, `css/company.css`, `css/does.css`, `css/start.css`, `css/mobile.css`, `graphics/rf-graphics.css` (art roles, app-picture values, and at the end the removal of every retired name), `apps/web/components/site-frame/site-frame.css`, and the colour pins in `site-color-and-life` and `site-mobile-pass` tests (to the ledger).
- **Do:** re-point each use of a retired token to a job, one by one: a blind value swap would turn 17 mid-blue fills copper (E17). Replace every shadow with `--rf-ring`, every gradient and blur with a flat fill. Before deleting a rule as dead, prove it from the shared layout, not from a spot check (L-199).

### WP2.2 · Colour the wheel by role
- **satisfies:** R17 (wheel), R18 (canvas), R19, R5 (pixel check) · **provenBy:** T17c, T18b, T19
- **dependsOn:** WP2.0 · **risk:** medium · **skills:** `gsap-skills:gsap-scrolltrigger`, `apple-design`
- **Files:** `graphics/rf-wheel-up.js`, `graphics/rf-wheel-up.css`, the wheel colour pins in `site-color-and-life` and `site-motion-always` tests (to the ledger).
- **Do:** read the eight `--rf-wh-*` values once at mount with `getComputedStyle`. Outer tiles alternate the two bone values, inner tiles the two ink values; walls are the flat wall tokens. Remove the three shadow sprites and every `shadowBlur` (JS:301-311, 447). The tile in focus takes `--rf-wh-focus`; other tiles are not dimmed. At rest Payments is the focus tile. Icons: ink on bone, white on ink and on copper. The hub draws the kit symbol's path in copper light.

### WP2.3 · Sections and pictures in the nine pages
- **satisfies:** R15, R20, R21 · **provenBy:** T15, T20, T12 · **dependsOn:** WP2.1 · **risk:** medium · **skills:** `apple-design`
- **Files:** `home.html`, `pricing.html`, `product.html`, `company.html`, `contact.html`, `getting-started.html`, `does-and-doesnt.html`, `data-in-and-out.html`, `security.html` (inline styles, inline SVG art, band classes; no text changes).
- **Do:** follow the tables in [ux-spec.md](./ux-spec.md) §5. The 22 use-case cards lose their inline `--pc`/`--pi` colours. Pictures keep their shapes and take the role tokens.

### WP2.4 · The landing page
- **satisfies:** R14 (inline copy), R15-R18, R21 for `/landing` · **provenBy:** T14c, T15, T16, T18 · **dependsOn:** WP2.0 · **risk:** low · **skills:** `apple-design`
- **Files:** `landing.html` only (it carries its own CSS and art: 213 colour literals).

### WP2.5 · Logo, icons, share image and the name
- **satisfies:** R22, R23, R24, R25, R28 · **provenBy:** T22, T23, T24, T25, T28, T12
- **dependsOn:** WP1.3b, WP2.2, WP2.3, WP2.4 · **risk:** medium · **skills:** `apple-write`
- **Files:** the ten `*.html` (head tags, header and footer logo, every string), `graphics/rf-wheel-up.js` (4 strings), `js/home-up.js`, `js/site.js`, `js/prices.js` (1 each), `apps/web/components/site-frame/SiteFrame.tsx`, `SiteFrameHeader.tsx`, `site-frame-nav.ts`, `apps/web/app/(marketing)/lib/site.ts`, `lib/metadata.ts`, `opengraph-image/route.tsx`, `scripts/sync-site-port.mjs`, NEW `apps/web/app/(marketing)/site-rovio-name.static.test.ts`, and the name pins in `static-site.test.ts`, `site-company-contact`, `site-truth` tests and `apps/web/e2e/36-marketing-site.spec.ts` (title patterns).
- **Do:** replace by reading each string, not by search-and-replace: identifiers (`rf-`, storage keys, cookie names, file names, `routeflow-mark` paths under `public/brand`) do not change (E29). The host in canonical and share URLs changes in WP2A, not here. Every `hello@routeflow.info` becomes `hello@xrovio.com` (ruling D4), including `SITE_EMAIL` in `site-frame-nav.ts:44`, `site.email` in `lib/site.ts`, and the pin in `static-site.test.ts` L6. JSON-LD: `name: "Rovio"`, `alternateName: "RouteFlow"`. Do not touch `apps/web/app/layout.tsx`, `public/brand/` or the manifests: they belong to the app (E26).

### WP2.6 · The front door (signed-out React pages)
- **satisfies:** R26, R24 (React pages), R18 (their CSS) · **provenBy:** T26, T24 · **dependsOn:** WP2.0 · **risk:** medium (sign-in pages: words and pictures only, no logic) · **skills:** `apple-write`, `apple-design`
- **Files:** `apps/web/app/(marketing)/layout.tsx` (title and icon for its routes), `privacy/page.tsx`, `terms/page.tsx`, `marketing.css`, `glass*.css`, `apps/web/app/not-found.tsx`, `apps/web/app/(auth)/login/layout.tsx` and `page.tsx`, `(auth)/signup/layout.tsx`, `page.tsx` and `check-email/page.tsx`, `(auth)/forgot-password/layout.tsx` and `page.tsx`, `(auth)/reset-password/page.tsx`, `apps/web/app/buyer/login/page.tsx`, `apps/web/components/auth/AuthShell.tsx`, and the pins in `seo.test.ts`.
- **Area sweep (design gate):** B247, B248, B520 and B550 sit in `marketing.css` and `glass*.css`. For each, prove from the shared layout whether its rules are still used (L-199): remove dead rules, or fix live ones; one commit and one test per id; the PR body lists every id it closes.
- **Do:** set the title and icon for these routes in their own layouts; leave the root layout and `buyer/layout.tsx` alone (they also serve signed-in pages). Out of scope here: `(auth)/admin-login`, `(auth)/admin/login`, `choose-role` and the callback pages (staff-only or after sign-in: Program B).

### WP2A.0 · Let the API return to either web address (API code, no brand; review M1)
- **satisfies:** R34, R35 · **provenBy:** T34 · **dependsOn:** none · **risk:** high (sign-in) · **skills:** none · **pipeline:** its own `dev-pipeline` run, Opus `high` review
- **Why:** the Google sign-in return is checked against exactly one web address, `WEB_URL`, or the mobile web address (`apps/api/src/auth/auth.controller.ts:83-85,556-570`); anything else falls back to `WEB_URL`. Payment return addresses do the same (`stripe-connect.controller.ts:107`, `payment-requests.service.ts:314`, `billing.service.ts:677-679`). With two addresses, a Google sign-in started on one lands on the other.
- **Files:** `apps/api/src/auth/auth.controller.ts`, `auth.controller.return-origin.spec.ts`, the API config module, `apps/api/.env.example` (a NEW setting name `WEB_ORIGINS`: a comma-separated list of extra allowed web addresses; empty by default, so today's behaviour is unchanged), and each return-URL builder listed by `git grep -n "WEB_URL\|webUrl" apps/api/src`.
- **Do:** keep the exact `===` match; the allow-list is `WEB_URL` + `MOBILE_WEB_URL` + `WEB_ORIGINS`. For each return-URL builder, write down in the PR whether it returns to the request's own allowed origin or to `WEB_URL`, and why. Payments that start in a signed-in app session return to that session's origin.
- **Where it lands (owner ruling 2026-11-11):** on `master`, early and on its own, as a brand-free API change through the normal deploy flow. It is the one exception to the one-day launch.

### WP2A.1 · Serve the current app on `www.xrovio.com` (settings only, weeks before launch; checklist C2)
- **satisfies:** R31 (host up), R34, R36 (settings) · **provenBy:** T32; checklist C2 · **dependsOn:** WP2A.0 live, if Q1 lands it early · **risk:** high (sign-in and payments on a new host) · **skills:** `debug-deploy` if a deploy misbehaves
- **First (A9, owner not sure):** the lead lists the web service's custom domains on Railway and the host names seen by analytics over the last 90 days, read-only. If any business uses `name.routeflow.info`, add a wildcard record and certificate for `xrovio.com` and `xrovio.com` in `CORS_WILDCARD_DOMAINS`.
- **No code.** Owner and lead, in this order, each read back after it is set:
  1. DNS: `www.xrovio.com` as a custom domain on the Railway web service (CNAME); `xrovio.com` forwarding to `https://www.xrovio.com` at the registrar (Railway needs the CNAME, as with `routeflow.info`).
  2. API: add `https://www.xrovio.com` to `CORS_ORIGINS` (keep every current entry). If A9 finds businesses on sub-addresses, also `xrovio.com` in `CORS_WILDCARD_DOMAINS` plus a wildcard record and certificate.
  3. Google sign-in console: add the new origin and its callback address beside the old ones.
  4. Stripe: confirm return addresses come from `WEB_URL` (they do in code, E34) and add the new domain wherever the dashboard keeps an allow-list.
  5. Analytics: allow the new host on the site's Umami entry.
  6. Set `WEB_ORIGINS=https://www.xrovio.com` on the API. Run T32 from CI by hand (the setup guard allows non-local targets only there). Sign in with Google by hand once on each address and confirm it **returns to the address it started on**.
- Nothing visible changes: until launch the new address serves today's RouteFlow site and app. It is not linked from anywhere.

### WP2A.2 · Redirects and the site's own address (on the branch)
- **satisfies:** R31, R32, R33, R35 · **provenBy:** T30, T31, T33 · **dependsOn:** WP2.5 · **risk:** medium · **skills:** none
- **Files:** `apps/web/next.config.mjs` (`redirects()`), `apps/web/app/(marketing)/lib/site.ts` (`origin`), `apps/web/app/(marketing)/layout.tsx` and the `(auth)` layouts from WP2.6 (`metadataBase: new URL(site.origin)`: the root layout's `metadataBase` at `apps/web/app/layout.tsx:52` would otherwise resolve privacy's and terms' relative canonical and share URLs to the old host, review M2), `scripts/sync-site-port.mjs` (`ORIGIN`), the ten `*.html` (canonical, `og:url`, share image URL, JSON-LD `url`), NEW `apps/web/app/(marketing)/site-rovio-host.static.test.ts`, and the host pins in `static-site.test.ts` (L7 allow-list, og image URL), `seo.test.ts` (sitemap, robots), `lib/static-site-page.test.ts` (`data-domains`).
- **The redirect rule** (public paths only; the app keeps working on the old host, R35):

```js
// next.config.mjs. It cannot import TypeScript (it imports only node:path, node:url and ./csp.mjs), so the
// page list lives here once; rewrites() and redirects() both derive from it, and site-rovio-host.static.test.ts
// checks it equals STATIC_SITE_PAGE_NAMES from apps/web/lib/static-site-page.ts and that its routes equal STATIC_SITE_PATHS
// in apps/web/lib/umami-tag.ts:9. The legacy aliases (next.config.mjs:62-75) point straight at the new host's final page,
// never through a second hop (review S4).
const SITE_PAGES = ["home", "pricing", "product", "landing", "getting-started", "does-and-doesnt", "data-in-and-out", "security", "company", "contact"];
const routeOf = (page) => (page === "home" ? "/" : `/${page}`);
// rewrites().beforeFiles: SITE_PAGES.map((p) => ({ source: routeOf(p), destination: `/site-page/${p}` }))
const PUBLIC_PATHS = [...SITE_PAGES.map(routeOf), "/privacy", "/terms"];
...PUBLIC_PATHS.map((source) => ({
  source,
  has: [{ type: "host", value: "www.routeflow.info" }],
  // The installed phone app's web view only allows www.routeflow.info (apps/mobile/app/(shell)/web.tsx:164); never send it
  // to another host (review S1). The shell's user-agent token is RouteFlowShell (packages/ui shell-bridge.ts:21).
  missing: [{ type: "header", key: "user-agent", value: ".*RouteFlowShell.*" }],
  destination: `https://www.xrovio.com${source === "/" ? "" : source}`,
  permanent: false, // becomes true on launch + 7 days (WP3.2), so a rollback in week one is clean
})),
```
- `/login`, `/signup`, the reset pages and `/buyer/login` are NOT redirected: a person who is mid-sign-in or has a bookmark keeps working on the old host. The site header's links are relative, so a visitor who arrives on the new host stays on it.
- The tenant host logic needs no change (E34). Do not add `xrovio` to `HOSTING_PROVIDER_DOMAINS` or `PLATFORM_HOSTS`.

### WP2.7 · Proof and gates
- **satisfies:** all of Phase 2 · **provenBy:** every `T#` on images built from the branch head; gates G-U, G-D, G-W, G-I, G-O · **dependsOn:** WP2.1-WP2.6
- **Do:** build the local stack from the branch head, run both suites, capture before-and-after sheets at 1440, 768 and 390 into `local-assets/proofs/`, run the four skill gates, then `pre-merge-review`. Offer the owner the proof as one page.

### WP3.1 · Launch day (checklist C1, proves R29)
1. The owner confirms in writing: trademark cleared; customers told two weeks ago and today; WP2A.1 done and T32 green within the last 7 days; ad creative for `/landing` is ready.
2. `rebrand/rovio-site` has `master` merged in (never rebased), all suites green on images built from its head, every gate signed, `pre-merge-review` PASS at that exact sha.
3. `git log origin/master -S"Rovio" --oneline -- apps/web/public/site apps/web/components/site-frame` prints nothing.
4. Rollback rehearsed on the local stack: revert the merge, run T12 and T24's inverse.
5. Canonical deploy flow from `CLAUDE.md`: watchdog first, public window, CI green, **merge commit** (one commit to revert), both deployments `SUCCESS`, flip private, read it back.
6. Set the API's `WEB_URL` to `https://www.xrovio.com` (links in platform emails, payment returns). Read it back.
7. `npm run post-deploy-check`; read the post-deploy `site-proof` result, including T30b and T33b; if red, `git revert -m 1 <merge>` through the same flow and put `WEB_URL` back.

### WP3.2 · After launch
A weekly run of T24 against production for four weeks; on launch + 7 days, if nothing was rolled back, set `permanent: true` on the redirects and file the change of address in Search Console; a ticket dated launch + 6 months to remove the "formerly" line; code map, lessons and the heavy-files note in `CLAUDE.md` updated (R30, T29); start Program B with its first slice.

## Verification commands

```bash
npm test -w apps/web -- "site-"
```

```bash
npm run verify
```

```bash
npm run local:up
```

```bash
node scripts/local-env.mjs --proof-stack --e2e -- "npm --prefix apps/web run test:e2e -- --project=site-proof"
```

## Critique (P8)

- **The objection a hostile reviewer would raise:** "Replacing about 60 literal pins with behaviour tests is more work than the fix. Just update the literals." Literals re-pinned to new literals guard nothing (L-205) and Phase 2 would rewrite them again. The behaviour tests are written once, in WP0, and serve both phases. The ledger stops a pin from vanishing without a successor.
- **Pre-mortem, six months on, and the answer in the plan:**
  1. The name did not clear. Nothing went live (ruling D1), so production lost nothing. The owner can still choose to land Phase 1 alone: it is gated separately and carries no brand. Tokens named by job make another palette a values change.
  2. The branch lived for weeks and collided with other site edits. Freeze on the site folders, `master` merged in daily, packages as PRs into the branch. This risk is larger than it would have been under separate releases; it is the price of the one-day ruling, and the owner was told.
  3. Launch day broke sign-in on the new address. WP2A.1 serves the new address weeks early and runs the sign-in and order suites against it, sign-in pages are not redirected, and the old address keeps the whole app.
  4. The rollback left visitors stuck on the new address. Redirects are temporary for seven days, so browsers do not cache them.
  5. A removed pin was guarding an old phone bug, which came back. Each removal needs a ledger row naming the bug and its new test; most removed pins guard label fitting, which no longer exists.
  6. On launch day a new customer signed up on a Rovio site and got a "RouteFlow" email. Program B's first slice (sign-up emails) should land the same day; see [program-b-app.md](./program-b-app.md).
  7. Site pictures showed an ink-and-bone app for weeks while the real app was teal. D7 is the owner's to flip; Program B follows at once.
  8. Print mode left motion broken afterwards. T1's return leg checks the trigger count.
- **Riskiest assumptions and their cheap tests:** A7 (one pose on a phone): one hour, three frames, the owner's eye. A6 (print falls back cleanly): 30 minutes.
- **The requirement that wastes most if wrong:** R6 (names leave the tiles). It is the guide's rule, and G-U checks it with first-time users at the end of Phase 1, before any Rovio work depends on it.
- **Checked for omissions:** service-worker cache (network-first for `/site/`), sitemap and robots (unchanged), the anchor ids `#faq`, `#use-cases`, `#stores` (kept, pinned), the signed-in header, the phone menu, the three brand-ring backgrounds in `css/mobile.css` (removed under the flat rule, re-pinned), the canvas focus ring colour, the `prefers-contrast` block, the legal pages' dates, the React pages' `glass*.css`.
- **Not provable by a test, by decision:** copper count per screen, fidelity to the guide, tone of wording (review gates); launch discipline (checklist).

## Stage log (P0-P8)

| Stage | Stop condition | Fired? | What was done |
|---|---|---|---|
| P0 Frame | trivial | no | major; `ui: true`; website now, app outlined |
| P1 Ground | capability exists already | partly | legends exist; reused |
| P2 Interview | owner-owned question open | yes (4) | defaults D1, D2, D3, D8 marked; one question round after the plan |
| P3 Discovery | no success signal | no | 13 of 13 pages pass the proof suite on production |
| P4 Spec | unverifiable requirement | once | R29 kept as checklist-proven |
| P5 UX | new component where one exists | yes | `.rfw-keys` and `.sy-go` reused |
| P6 Test plan | nothing can fail today | once | R29; T4's oracle noted |
| P7 Build plan | scope creep / hole / unbuilt | none | every package has `satisfies` and `provenBy`; every `T#` has a package; every `R#` has a package |
| P8 Critique | pre-mortem failure with no answer | no | six failure modes, each answered |
| Design gate | `future-proof` | not yet run | first step before Phase 1 |

## Handoff (P9)

Coverage: every `R#` → its `T#`s ([test-plan.md](./test-plan.md) §3) → the package that proves it:
R1 WP1.1+WP1.2 · R2 WP1.1 · R3-R9 WP1.2 · R10 WP1.1 · R11 WP1.3 · R12 WP0 (guard) and every package ·
R13 WP0 · R14 WP2.0+WP2.1+WP2.4 · R15 WP2.1+WP2.3+WP2.4 · R16-R18 WP2.1 (+WP2.2 canvas, WP2.4, WP2.6) ·
R19 WP2.2 · R20 WP2.1+WP2.3 · R21 WP2.1+WP2.3+WP2.4 · R22-R25 WP2.5 · R26 WP2.6 · R27 WP1.2 (+WP2.1, WP2.2) ·
R28 WP2.5 · R29 WP3.1 · R30 WP3.2 · R31 WP2A.1+WP2A.2 · R32, R33 WP2A.2 · R34 WP2A.0+WP2A.1 · R35 WP2A.0+WP2A.2 · R36 WP2A.1 (+WP3.1 step 6).

Phase 1 invocation (after WP0, from a fresh worktree; Phase 2's is written when Phase 1 lands):

```js
{
  buildPlanPath: "C:/ClaudeCode/routeflow/.claude/pipeline/2026-11-11-rovio-rebrand/build-plan.md",
  testPlanPath: "C:/ClaudeCode/routeflow/.claude/pipeline/2026-11-11-rovio-rebrand/test-plan.md",
  designSystemPath: "C:/ClaudeCode/routeflow/.claude/pipeline/2026-11-11-rovio-rebrand/ux-spec.md",
  lessonsPath: ".claude/lessons/LESSONS.md",
  startedAt: "<ISO time at launch>",
  runDir: ".claude/pipeline/2026-11-11-rovio-rebrand",
  scale: "major", mode: "bugfix", profile: "standard",
  workdir: "<worktree on branch rebrand/rovio-site>", context: "Website fixes before the Rovio rebrand: print, wheel layout, wording. Lands on rebrand/rovio-site, never master",
  formatCommand: "npx prettier --write <changed paths only>",
  tasks: [
    { id: "WP1.1", title: "Complete pages in print and without scrolling", type: "fix",
      files: ["apps/web/public/site/js/home-up.js", "apps/web/public/site/js/site.js", "apps/web/public/site/css/site.css", "apps/web/public/site/css/mobile.css", "apps/web/public/site/css/home-up.css", "apps/web/public/site/css/home.css"],
      tests: ["apps/web/e2e/85-site-proof-pages.spec.ts"], brief: "build-plan.md § WP1.1", risk: "medium" },
    { id: "WP1.2", title: "The wheel fits, names sit beside it, nothing is empty", type: "fix", dependsOn: ["WP1.1"],
      files: ["apps/web/public/site/graphics/rf-wheel-up.js", "apps/web/public/site/graphics/rf-wheel-up.css", "apps/web/public/site/home.html", "apps/web/public/site/css/home-up.css"],
      tests: ["apps/web/e2e/84-site-proof-wheel.spec.ts", "apps/web/app/(marketing)/site-rovio-pins.static.test.ts"], brief: "build-plan.md § WP1.2", risk: "high" },
    { id: "WP1.3b", title: "Apply the approved wording ledger", type: "feature", dependsOn: ["WP1.2"],
      files: ["apps/web/public/site/*.html", "apps/web/app/(marketing)/privacy/page.tsx", "apps/web/app/(marketing)/terms/page.tsx"],
      tests: ["apps/web/app/(marketing)/site-rovio-copy.static.test.ts", "apps/web/app/(marketing)/site-truth.static.test.ts"], brief: "build-plan.md § WP1.3", risk: "low" },
    { id: "WP1.V", title: "See it in a browser at 1440, 768 and 390", type: "ui-verify", dependsOn: ["WP1.2", "WP1.3b"],
      files: [], tests: ["apps/web/e2e/84-site-proof-wheel.spec.ts", "apps/web/e2e/85-site-proof-pages.spec.ts"], brief: "build-plan.md § Gate G1" }
  ],
  verifyCommands: { perRound: ["npm test -w apps/web -- \"site-\""], final: ["npm run verify"] }
}
```

Open assumptions the executor must not take as fact: A1-A7, TA1-TA3, and defaults D1-D8 until the owner rules.
Close out every engine run with `dev-pipeline/scripts/closeout.mjs <runDir>` and one RUN-LOG entry.

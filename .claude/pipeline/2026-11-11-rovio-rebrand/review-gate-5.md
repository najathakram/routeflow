# Review gate 5: spec-delta-2026-11-14 (independent, Opus, @00ec11d53)

**Verdict: FAIL.** Ten must-fix items, most of them one-line spec edits. MF1, MF2 and MF10 are false load-bearing facts.

## MUST-FIX
1. **The API cannot import the seam.** `apps/api/src/common/no-runtime-workspace-imports.spec.ts:1-14` bans runtime imports of `@routeflow/types` (main is `./index.ts`), so "B1 reads `BRAND`" crashes boot or fails verify. Fix: `brand.json` holds data only; the API reads it with `readFileSync` (the runner copies packages, API Dockerfile:69) through one `common/brand.ts` with a spec; the helpers stay in web.
2. **The swap claim is false.**
   - The hub mark is a typed path (`rf-wheel-up.js:86`, `home.html:114`; WP2.2 bp:246 types the kit symbol there).
   - Navy hex sits in wheel JS (:86,120,126,180,406) and inline in 4 html files.
   - T22, T23, T25 and T26 pin `rovio-logo-…`, `rovio-mark-*` and "© 2026 Rovio, formerly…" (test-plan:71-75).
   - The WP2.6 layouts type `"%s · Rovio"` (bp:264); privacy/terms (107 literals), site-frame and og are outside T35's predicate.

   Fix: widen T35 to these files and add a hex rule for html/js; hub symbol via `{{brand:symbol}}`, read by the JS from the DOM; T22-T26 read `BRAND`; NEW T45 renders everything with a fixture `{name:"XROV.IO"}` and expects zero `/\brovio\b/i` outside the host and email.
3. **Owner Q1's default** ("Rovio files", delta:94) launches the rejected wordmark under XROV.IO, and ux-spec §8 forbids typing the name instead. Fix: default = XROV.IO waits for its own kit; put the artwork time on the "attorney says no" calendar.
4. **WP1.x has no master proof path.** T3-T8 live in the WP0 harness (84/85, helpers, playwright config, `cam()`): branch-only by bp:65/S9, and four of its files name "rovio". Fix: say which files port to master (neutral names) and how the known-red cells stay off post-deploy; or rule that the proof is the branch harness on a master-based tree.
5. **The G1 list is incomplete.**
   - WP1.1 edits e2e 36 and `site-motion-always` (bp:100).
   - WP1.2 creates `site-pin-ledger.json`, which is already on the branch (add/add conflict).
   - S1 edits e2e `36:895` and the ledger in wave 0.
   - UX batch 1 on master edits `signup/check-email/page.tsx` and `email/routeflow-mail.ts` (main `.claude/handoffs/2026-11-14-ux-guide-lead-handover.md:38-41`), which 2.6 and B1 own.

   Fix: add these files to G1, sequence S1's e2e/ledger edits after WP1.x, and start B1 and 2.6 after batch 1.
6. **Files claimed twice:** `brand/palette.json` (S1 + 2.0a, wave 0); the `rf-wheel-up.js` comment (S2 + 2.2, wave 2); `site.css` (2.3-pricing + header lane, wave 3; the phone menu rules are in `site.css`). Fix: one owner each.
7. **Leaks are open now.**
   - (a) Three untracked rovio handoffs sit in the MAIN checkout (`.claude/handoffs/2026-11-12-rovio-rebrand.md`, `2026-11-12-ux-eval-and-bug-guide.md`, `2026-11-14-ux-guide-lead-handover.md`); `.claude/handoffs` is tracked. Move them to `local-assets/`.
   - (b) "Never push" relies on discipline: `branch.rebrand/rovio-site.pushRemote` is unset. Set it to a dead remote on the PC and the Mac mini, as local config (a tracked hook would name the brand).
   - (c) The check is diff-only. Also scan commit messages, branch names, PR text and the learning-loop rows (`.claude/skills/*/references/RUN-LOG.md`, `cost-ledger.jsonl`); use a neutral run slug.
8. **Private prep contradicts the ruling** (delta:34). MX and the Search Console TXT are public DNS records, yet "only DNS waits". "Stripe" is left open, and its website, support email and branding are payer-visible. Fix: MX/TXT at D0; Stripe now = nothing a payer sees.
9. **The transition table is a hand list (G4).** It misses the Maps browser-key referrers, Stripe payment-method domains (Apple/Google Pay), the Microsoft mailbox redirect (#4307), Sentry URLs, and SPF/DKIM if B1 changes the From domain. Fix: one row per console that holds a web origin, derived from the env names and #4307's builder list, read back by the owner at D0.
10. **The area sweep cannot be reproduced.** The stated grep (branch and origin/master) returns B247 B249 B250 B520 B550 B1294. B1321-B1328 are in no `bugs.jsonl` (master ends at B1320); they come from an unmerged 11-14 docs PR. Nothing sources B1328 as "flaky T20" (pack:72). Fix: cite the PR or `baseline-red.json`, and file the ids with bugs.mjs after it merges.

## SHOULD-FIX
- 16 tests read `public/site/*.html` from disk and the delta re-homes 6. Add one `readServedSitePage()` helper and a pin.
- T35 cannot be zero in wave 0 while `home.html` waits for S2. State the exemption.
- The byte-identical guard cannot catch `name` and `formerly` swapped (both are "RouteFlow" in wave 0). Run T45 in wave 0.
- The logo is sized by width (ux §8, 112-132 px), which pins the 3:1 shape. Size it by height.
- P01/F04, P05 and the header-lane rows need test ids.
- T44: record a baseline in WP0 and define how "tap to paint" is measured. Lanes have no server for browser red/green (Docker runs only at waves 3 and 5); state `next dev` per lane in the heavy slot.
- T30: add a negative row. Tenant hosts (`lib/tenant-host.ts:57`) and the apex never redirect.
- The gate should be Full, not Lite: a new shared store plus sign-in redirects (SKILL:40). G2's "n/a" misses the host axis (tenant hosts, shell, buyer).

## Checked and sound
- The route is `force-static` with `generateStaticParams` (`route.ts:14-19`) behind `beforeFiles` rewrites (`next.config.mjs:84-97`). The fill runs at build; Cache-Control (`:159-177`) is unchanged.
- Raw `/site/*.html` is a public file with noindex (`:186`). `redirects()` runs before the filesystem, so the planned redirect closes it, and the raw tokens show no name.
- `packages/types` is in both images (web Dockerfile:25, API :23/:69).
- Cited lines are accurate: `sw.js`, `presence-cookies.ts:20`, `web.tsx:164`, `auth.controller.ts:707`, `umami-tag.ts:32`.
- Sizes fit the caps: home html 18.7 KB gz (cap 20), end-mark PNG 25.7 KB, wheel 76,167 B. T43 can fail.
- origin/master has zero "rovio". `check-gate.mjs` passes. Every pack §8 row is placed or held.

## Round 2 (rev 2): PASS-WITH-FIXES
Checks run: the kit dir on disk, Stripe on web and mobile, the spec regex, the WP1.1 range and post-deploy, `.git/info/exclude`, the staged ids, the T20 log.
- MF1 CLOSED. `require.resolve("@routeflow/types/package.json")` matches no spec pattern (:46-56), and the runner links packages (Dockerfile:67-69).
- MF2 STILL OPEN.
  - (a) T35 and T45 skip the B1 API email sources.
  - (b) Nothing bans kit hex in site and (marketing) CSS, so a colour swap is not code-free.
  - (c) The legal entity "Routeflow Solutions LLC" (terms:54, privacy:68) hits the zero rule. Add a `legalEntity` key, or an allow-list row for the attorney.
  - (d) The exemptions cover only home and landing. T35 is red until wave 2 (front door, privacy/terms, glass/marketing CSS, JS/CSS comments) and forever on `admin-login` and `choose-role`, which no lane owns. Fix: one exemption row per file, naming the package that lifts it (T45 too); drop or assign those two.
- MF3 CLOSED. Premise (a) holds: 26 SVGs with 0 `<text>`, 13 `icons/web` files, 3 `email/` files.
- MF4 CLOSED. `fix/site-print-and-headings` has 0 brand hits in diff and messages. Post-deploy runs every project (ci.yml:848), so spec 85 must be all green at merge.
- MF5 CLOSED.
- MF6 STILL OPEN. `app/layout.tsx` has two owners in wave 2: 2.6 (favicon move, bp:264) and B1. S2's "JS comments" overlaps 2.2's `rf-wheel-up.*`; name S2's files.
- MF7 STILL OPEN (small). NEW BREAK: `.claude/**/*rovio*` in the shared `.git/info/exclude` hides this branch's own plan files (spec-delta, copy-ledger, this review), and `git status` there is empty. Fix: `git add -f` rule.

  G0 gaps:
  - Hook and script must fail closed when `leak-patterns` is missing. CI never runs them, and a tracked pattern would leak.
  - The launch escape must also skip the pattern scan.
  - Retire the file after launch.
  - Install it on the Mac mini (bundles do not carry `.git/info`).

  G0 is otherwise brand-neutral.
- MF8 CLOSED. MF10 CLOSED (B1321-B1328 staged; log: 1 failed, 2 passed).
- MF9 CLOSED. Rejection (b) is right: no `@stripe`/`js.stripe.com` in web or mobile, Checkout is hosted, and wallet domains apply only to Elements.

Start now: G0 (with the gaps above in its brief), 2.0a, B1 spec, P12-P16, speed baseline. S1 starts once the MF2 c/d lines are in the delta; no re-review needed.

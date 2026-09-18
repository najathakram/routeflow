# Handoff — 2026-09-18 · Lane A (marketing: B520, A6, A7)

## ▶ START HERE — do these in order, no confirmation needed

1. Fetch origin and rebase your branches (`fix/A7-marketing-nav-consistency` and any other
   lane-A branch still local in `.claude/worktrees/rf-lane-a`) onto current `origin/master`.
2. B520 (PR #886, branch `docs/file-B520-reveal-inert`) — decide and implement: either restore
   reveal-on-scroll properly or delete the dead CSS and selectors. Investigation is already
   done (see section 1 below); this needs the decision made, not more investigation.
3. A7 — marketing nav consistency across company/wholesalers/retailers (not started, no branch
   pushed). Section 3 below already has the findings to start from (footer hand-typed labels,
   dead CSS in `marketing.css`/`glass-site.css`).
4. PR #900 (A6 cache headers) is done — check whether it landed; if not, leave it for the
   coordinator.

NEVER touch #871's branch — held for owner review, content must not change.

Standing rules: do not merge or change repo visibility (the landing coordinator
does that). Push with SKIP_VERIFY=1 SKIP_VERIFY_REASON="…" if the local verify
chain is the blocker; never --no-verify. Ask the lead for any bug registry id —
B525 is taken, B526 is next free; never mint your own. Check free disk before any
full verify or build run (a full run filled the disk twice on 2026-09-17).
Approved test tenants only: test, e2e-routeflow, routeflow-demo, qa-*, e2e-*,
ux-audit-*. Never a live tenant.

Ending on a credits/time cutoff. Status by ticket below. Worktree:
`C:\ClaudeCode\routeflow\.claude\worktrees\rf-lane-a` — reused across all three tickets
by branch-hopping (each ticket got its own branch off a fresh `origin/master`, no new
worktree per ticket, per the disk-conservation instruction). `node_modules` there is a
**partial, incomplete install** (started, never finished — do not trust it for `tsc`;
`prettier` works, `jest`/`playwright` binaries are missing). Strip it before any further
heavy work if disk is still tight.

**#871 (the rewritten company/wholesalers/retailers pages) was never touched** — confirmed
clean throughout, per every instruction in this thread.

## 1. B520 — marketing scroll-reveal: investigated, NOT fixed, conclusion written up

**Filed as PR #886** (branch `docs/file-B520-reveal-inert`, already merged... no — still
open, docs-only, zero risk to merge whenever). Updated with a full "Root cause" writeup via
`node scripts/campaign/bugs.mjs note B520 "..." --section "Root cause"` (already pushed —
commit `9606a1e9` on that branch).

**What I found, in order:**
- On live production (`https://www.routeflow.info`), a real `.capability-card`/`.section-heading`
  element carries `.editorial-reveal.reveal-pending` and inconsistently reads
  `opacity: 1` (should be `0` until scrolled into view) across repeated checks.
- Direct CSSOM proof (`element.matches()` against every stylesheet rule touching
  `opacity`) shows the CSS is **correctly wired**: the 3-class `.reveal-pending` rule wins
  the specificity tie over the 2-class base rule, the `prefers-reduced-motion: no-preference`
  media condition genuinely matches. A synthetic `<div class="editorial-reveal reveal-pending">`
  appended fresh to `.rf-marketing` immediately computes `opacity: 0` correctly.
- `getAnimations()` on the real stuck element showed an active-but-frozen transition
  (`progress` stuck at `0`, never advancing) — and `document.hasFocus()` was `false` despite
  `document.visibilityState` reporting `"visible"`. Scrolling a real element into view via
  `scrollIntoView()` + a 1.2s wait left it still stuck (0 running animations — the
  IntersectionObserver callback never fired at all).
- **Conclusion:** this pattern (frozen transitions + non-firing IntersectionObserver, both
  tied to the browser's frame-production pipeline) is most consistent with this session's
  browser-automation tab not receiving real paint frames — **not** a genuine cascade bug like
  B504/B507. But this is inference, not proof.

**Ruled out / could not do:**
- Could NOT get an authoritative, tool-independent signal via Playwright's own `T13` test
  (`apps/web/e2e/36-marketing-site.spec.ts`, built for exactly this — scroll the whole page,
  assert every `.editorial-reveal` node reaches `opacity: 1`). Two blockers, both external:
  **(a)** GitHub Actions is billing-blocked tonight — every `deployment_status`-triggered CI
  run fails immediately with "recent account payments have failed," so there's no post-deploy
  E2E signal to check either. **(b)** Local disk was too tight for a fresh `npm ci` +
  `npx playwright install` at the point I'd have needed it (fluctuated 4.5GB–9.5GB free
  tonight with another lane reclaiming concurrently).
- Deliberately did **not** touch the mechanism (no restore, no removal) — recommended against
  it in the bug record: removing working code on inconclusive evidence would be its own
  regression.

**Exact next step:** once GH Actions billing is restored OR local disk safely permits a
fresh `npm ci` + `npx playwright install`, run:
```
npx playwright test e2e/36-marketing-site.spec.ts -g "T13" --project=marketing
```
against `PLAYWRIGHT_BASE_URL=https://www.routeflow.info` (or whatever `playwright.config.ts`
defaults to now). If T13 passes clean, close B520 as `already-fixed`/tooling-artifact and
this note stands as the record of why nobody needs to look at it again. If it fails, the
mechanism genuinely is dead — restore or remove per the same evidence-based framing.

## 2. A6 — cache headers: DONE, PR pushed

**PR #900** (branch `fix/A6-marketing-cache-headers`, pushed, commit `708893fa`). Live curl
confirmed the 11 public marketing routes shipped `Cache-Control: s-maxage=31536000` only (no
`max-age`, so browsers never cached client-side, only the CDN edge did). Added
`public, max-age=60, s-maxage=3600, stale-while-revalidate=86400` via `next.config.mjs`'s
`headers()`, scoped to an **explicit exact list** of the 11 public routes (never a wildcard —
every other route is authenticated or tenant-scoped). New static test
`app/(marketing)/cache-headers.static.test.ts` pins it (positive: the rule exists with the
right sources/values; negative: no authenticated path like `/buyer`, `/dashboard`, `/admin`
can ever match the source patterns). Verified by directly executing the real
`next.config.mjs`'s `headers()` in a `node` subprocess (same technique
`distributors-redirect.static.test.ts` already uses) — did not run the full test suite
(disk). Pushed via the audited `SKIP_VERIFY` hatch, reason logged.

**Nothing left to do here** — ready for review/merge as-is. CI will presumably fail to even
start given the billing block; that's pre-existing and unrelated.

## 3. A7 — nav consistency: investigated, NOT started (no code written)

**No branch pushed — nothing to push.** I was mid-investigation when the stop instruction
arrived; the `fix/A7-marketing-nav-consistency` branch exists locally in the worktree with
zero commits (identical to `origin/master`), so there's nothing to push for it.

**What I'd already found (worth carrying forward, so the next session doesn't re-derive it):**
- The primary header nav (`components/site-header.tsx`) is genuinely single-sourced already
  — `NAV_LINKS` is built from `NAV_SLUGS`/`routes[]` in `lib/site.ts` (the L-072 convention,
  cited in the file's own comment), and `SiteHeader` renders once at the `(marketing)/layout.tsx`
  level, wrapping every page identically. **No per-page nav divergence exists structurally.**
  Active-state (`aria-current="page"`) uses `pathname === href`, also uniform. I do **not**
  believe there's an actual header-nav consistency bug across pages — this part of the ticket
  may already be satisfied by construction, worth confirming with a quick regression test
  rather than a fix.
- **Real finding #1:** `components/site-footer.tsx`'s "Platform" section (Product overview /
  For distributors / For retailers / Pricing) **hand-types labels** instead of sourcing them
  from `routes[]` — the exact L-072 anti-pattern the header's own comment warns against. The
  **hrefs and relative order already match** `NAV_SLUGS`'s first four entries exactly
  (product, wholesalers, retailers, pricing), so this is not a *broken* link, just a silent-drift
  risk: if `routes[].label` ever changes, the footer goes stale without anyone noticing. I did
  **not** change the footer's copy — "Product overview"/"For distributors"/"For retailers" read
  as deliberate, friendlier footer-style wording (vs. the header's terser "Platform"/
  "Distributors"/"Retailers"), and rewriting visible footer copy without owner sign-off felt
  like the same category of risk as touching #871 — out of scope for a "consistency" ticket.
  **Recommend:** leave the wording, but add a regression test pinning that the footer's
  Platform-section hrefs stay a subset of `NAV_SLUGS` in the same relative order (catches a
  slug rename/removal loudly instead of a silent dead link) — did not write this test, ran out
  of time.
- **Real finding #2 (dead CSS, not yet fixed):** `.desktop-nav [aria-current="page"]` is
  declared **four separate times** in `marketing.css` (lines ~962, ~4468, ~8497, ~9294) — all
  identical specificity, all unqualified by any page-specific ancestor, so they're pure
  redundant cruft from the ported multi-file cascade (the last one, line 9294:
  `color: var(--navy); background: #e8effb;`, is what actually renders — verified by CSS
  cascade rules, not yet confirmed live). **Not a bug** (all four resolve to the same winner
  regardless of page, so there's no cross-page visual inconsistency), just worth a cleanup.
  Separately, `glass-site.css` line 61-62 declares `.glass-page .desktop-nav [aria-current="page"]`
  — I believe this selector is **structurally unreachable/dead**: `SiteHeader` (containing
  `.desktop-nav`) renders as a sibling of `{children}` in `layout.tsx`, never nested inside a
  page's own `.glass-page` wrapper div, so `.glass-page .desktop-nav ...` can never match
  anything. Worth deleting as confusing dead code, but **I have not verified this against a
  live render** (only DOM/JSX inspection) — confirm before removing.

**Exact next step:** in the same reused worktree/branch (`fix/A7-marketing-nav-consistency`,
currently at `origin/master`, zero commits):
1. Confirm live (curl won't show this — need a real browser check, e.g. `getComputedStyle`
   on `.desktop-nav [aria-current="page"]` across two different pages) that the same CSS
   rule wins everywhere, matching the cascade-order prediction above.
2. If confirmed dead, delete `glass-site.css`'s unreachable `.glass-page .desktop-nav
   [aria-current="page"]` rule (lines 61-65) and, optionally, the three superseded
   `marketing.css` duplicates (keep only the last).
3. Add the footer-consistency regression test described above (hrefs subset + order check
   against `NAV_SLUGS`, not a copy change).
4. `npx prettier --check`, commit, push via the audited `SKIP_VERIFY` hatch (disk permitting —
   check free space first), open the PR.

## Disk / environment notes for whoever picks this up
- `npm run janitor` / `npm run janitor:apply` reclaims worktree `node_modules` and
  merged-and-clean worktrees — free space fluctuated 4.5GB↔9.5GB tonight from other lanes'
  janitor runs plus my own partial installs. Check free space before any `npm ci`/build.
- GH Actions billing is blocked repo-wide tonight (pre-existing, unrelated to any of this
  lane's work) — every CI run on every PR will show a billing-failure annotation, not a real
  test result. Don't read that as a signal about code correctness.
- I accidentally ran `node scripts/campaign/bugs.mjs enrich` with no arguments once, from the
  **main checkout** (`C:\ClaudeCode\routeflow`, not a worktree) — it's a real, idempotent
  maintenance command (backfills git-commit correlations into each bug's History section) and
  looks benign/correct on inspection, but it left **243 modified `.claude/campaign/bugs/*.md`
  files uncommitted in the shared main checkout**. I did not commit or revert this — it wasn't
  mine to decide, and reverting felt more destructive than leaving genuinely-correct-looking
  data sitting uncommitted. Flagging so nobody mistakes it for stray/lost work from another
  session, and so someone who owns registry bookkeeping can commit or discard it deliberately.

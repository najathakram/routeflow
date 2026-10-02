# Handoff — Mac Lane R-ui (2026-09-20, written ~19:00Z)

Machine-local, untracked. Lane R UI: restrictions rule editor (5b), tenant settings/buyer/mobile
surfaces (6b/6c), plus review-fix rounds. Board = issue #938. Lead = "RouteFlow Mac Lead".
Repo/worktrees: ~/code/routeflow-clean/.claude/worktrees/ (NOT ~/code/routeflow).

## STATE AS OF ~21:50Z (a window landed 21:32-21:36Z: #1115 #1106 #1112 #1085 #1087 #1107 all MERGED; master 5c0239e6)
Worktrees I hold (2): ~/code/routeflow-clean/.claude/worktrees/rf-lane-R-ui-5b2b (held branches, all
local) and rf-lane-R-ui-1087 (branch fix/r-cart-min-w-0). Removed: -1085, -1107, -modal (merged).
Remove -1087 after the cart PR merges; the stray origin/feat/r-6c3-buyer-cart (created by my late push
after #1087 merged; not attached to any PR) is for the lead/coordinator to delete, not me.

## OPEN PRs / PUSHED
- #1122 rule end date exclusive + guard + sub-100yr, head 1e4f7f90. CRITICAL PATH: master already carries
  the off-by-one end (#1112 merged pre-fix; dialog unreachable until mounted). Reviewed: cleared.
- fix/r-cart-min-w-0 @14af3f70: 390px cart overflow (`min-w-0` on both grid children). PR to open when the
  push lands. PROVEN: static reasoning only; browser re-measure requested; no real buyer run yet.

## LOCAL-ONLY BRANCHES (never lose these; none pushed) — all in rf-lane-R-ui-5b2b, all on master 5c0239e6
LAND ORDER: #1122 -> F3/F4 PR -> 5b-2b-ii -> 5b-3, one at a time. DO NOT push 5b-2b-ii before #1122 is on
master: mounting the dialog is what makes the date bug reachable.
1. `wip/r-5b2b-review-fixes` @9cab30a6 — F3 (real Providers, exactly one toast, dialog kept) + F4 (dialog
   sends start local-00:00 / end next-day 00:00 for start=end=2026-12-15) + lows (clear field error on
   change, Enter-in-product-search guard, "Showing the first 8" hint). +72/-6 on RuleFormDialog.{tsx,test.tsx}.
   DEPENDS ON #1122 (F4 spec is red without it). Mutants: clear-on-change red, Enter guard red.
2. `feat/r-5b2b-ii-new-rule-button` @2efff8dc — New-rule button (TENANT_ADMIN only) + mount in
   rules/page.tsx, 1 spec. Rebased onto master (no picker commit anymore).
3. `feat/r-5b3-lift-dialog` @73c0e0ac — LiftRuleDialog + "Lift rule" on ACTIVE/SCHEDULED cards; create dialog
   mounts only while open; lift dialog has focus-return + Modal `scroll` (opt-in prop now on master).
   Stacked on #2. ~+180 net of #2.
Follow-up once these land: RuleFormDialog drops its local `max-h-[92vh] overflow-y-auto` for `scroll`.

## FOLLOW-UPS (only when a landing frees me)
- #1107: derive toast wording from the row's own `mode === "EXCLUDE"`, not a call-site boolean
  defaulting to false; pin onSuccess-only for the Add-label and removeLabel mutates too; categories
  failure has no role=alert / retry.
- #1087: parseSellingRestricted docblock says "never an empty list" but (in #1087's tree) it returns
  `?? []`; #1085's parser already yields one generic line — reconcile after both land.
- #1115 F2/F3 notes (p-0 consumer at customers/[id]/page.tsx:1651; nested scrollers) only matter to
  consumers that opt in.
- 6b mobile + B605 + duplicate-toast: nothing left. B605 fixed on master (#1072); the duplicate toast is
  fixed in #1001/#1034/#951.

## RULES THAT SHAPED TODAY (carry forward)
1. **Opt-in over default-on for shared primitives.** A default-on Modal scroll cap made every body a
   scroll container and clipped abspos typeaheads (estimates, empty list). 24 files use `top-full`, 10
   also mount a Modal, ~85 web Modal call sites (84 by grep, 45 files). Add a prop, default off, doc it
   with when NOT to use it, opt in only dialogs you own and prove.
2. **A fix for case handling must normalise BOTH sides.** #1106's first fix upper-cased the stored value
   but compared to a raw code; the chip passes the STORED value, so removing "tx" appended a duplicate.
   One `same(a,b)` helper, used everywhere.
3. **A test with a frozen prop cannot observe the second toggle.** Use a real stateful parent (Host/Spy)
   so the emitted value round-trips; prove red-first against the old code.
Also: a spec that calls a callback the component never passes asserts nothing (pin the callback keys);
a hand-typed fixture that is not the server's type lets a fall-through pass (type it as BlockedLine).

## MECHANICS
- Pushes run the full pre-push verify (10-30 min under load; one at a time; never --no-verify). One
  push failed on 3 unrelated `bugs.mjs` stolen-lock self-tests under load; retry passed unchanged.
- Never force-push a pushed branch: merge master in instead (merge-commit subjects must start
  "Merge …" or pass commitlint; keep the Bookkeeping-Follow-Up trailer).
- Fresh worktree needs its own `npm ci` (symlinked node_modules breaks tsc).
- A message addressed to R-service (step 2a-8, rf-lane-R-service-3) reached me by mistake; not mine, untouched.

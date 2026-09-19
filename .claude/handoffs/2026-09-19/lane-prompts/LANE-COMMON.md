# Lane common rules — RouteFlow fleet, 2026-09-19 run (read once, then your lane file)

You are ONE builder session on **Sonnet** (never Fable). Window title = your lane name. Read, in
order: `C:\ClaudeCode\routeflow\CLAUDE.md`, `.claude/lessons/LESSONS-DIGEST.md`,
`.claude/code-map/INDEX.md` (+ your area file), the fleet board
`local-assets/handoff/2026-09-19/BOARD.md` (shared facts + log), the evaluation
`local-assets/handoff/2026-09-19/EVALUATION-remaining-work.html` (your lane's cards), and the
plan/spec files your lane file names. Then start — do not ask the lead to re-explain.

## Setup (once)
1. `git -C C:/ClaudeCode/routeflow fetch origin` and confirm `origin/master` CONTAINS #936
   (`git merge-base --is-ancestor <#936 merge sha> origin/master`; the board's shared facts
   line names it). If it does not yet, wait — poll the board every ~10 min, do not start on
   a base without the schema spine.
2. Your own worktree only: `git -C C:/ClaudeCode/routeflow worktree add C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-<X> -b <branch> origin/master`,
   then `npm ci` in it, then `npx turbo run test --force --filter=<pkg you touch>` ONCE (fresh
   worktrees replay stale turbo caches — lesson in memory). Never touch another worktree,
   never `stash pop/drop` entries you did not create, never delete directories.
3. `docker compose ls` before any compose command. Lane F OWNS the compose stack; builders run
   Jest + `tsc --noEmit` + eslint in-worktree. If you need a DB-backed proof, post
   `[X] NEED-DB — <what>` on the board and F runs it on the shared stack.

## How to work (this run's method)
- **Prefactor first, then feature.** If the slice you must change lives inside a giant file
  (`orders/[id]/page.tsx`, `inventory/page.tsx`, `CreateOrderModal.tsx`, `vendor-bills.service.ts`,
  `inventory.service.ts`), FIRST extract that slice into its own component/service with a
  characterization test (behaviour identical; F pixel/probe-diffs it) as its OWN small PR — the
  #933 `LineItemRow` pattern. Then build the feature in the extracted file.
- **Land dark, land small.** Every feature ships behind its flag/preset (named in your lane
  file) so a merged PR changes nothing for tenants until the owner flips it. PRs ≤ ~400 changed
  lines; one PR per step; open the next step on a branch from the merged master, not stacked.
- **One choke point per invariant** + a meta-spec that fails the build if any call site skips
  it (`apps/api/src/common/no-bare-cron.spec.ts` is the template).
- **Checks must be able to check:** a spec or proof that cannot find its fixture FAILS, never
  self-skips. Money math only via `@routeflow/pricing`; enums only via `@routeflow/types`.
- Test tenants only: `test`, `e2e-routeflow`, `routeflow-demo`, `qa-*`, `e2e-*`, `ux-audit-*`.
  Never a live client slug/name/number anywhere. Never `railway run`.

## Before every PR
1. `npx tsc --noEmit` + affected Jest green in-worktree; eslint on changed files; prettier only
   on the files you changed (master is not prettier-clean — never `npm run format`).
2. Spawn an **Opus** reviewer subagent (model `opus`, effort `high`, refute-first: "prove this
   diff wrong") on your diff; fix what it finds; keep its verdict in the PR body.
3. Commit: Conventional Commits, explicit pathspecs, HEAD commit carries the trailer
   `Bookkeeping-Follow-Up: pending`. Push with the real hook (`git push`; NEVER `--no-verify`;
   `SKIP_VERIFY` only with a written reason and only when the hook itself is broken). Read the
   push output — the wrapper's exit 0 is not git's. Run it in the FOREGROUND and wait.
4. PR body: scope · flag name · proof (test names, screenshots path) · "not covered". Then post
   `[X] PR — #N <sha> <one line>` on the board. Never merge; the coordinator lands in windows.
   UI PRs additionally need F's Playwright proof (1440/768/390, all states) — post
   `[X] PROOF-REQ — #N <branch>` and continue with the next step while F proves.

## Comms — the board is GitHub issue #938 (both machines)
Read: `gh issue view 938 --repo najathakram/routeflow --comments` (body = shared facts).
Append one comment per event: `gh issue comment 938 --repo najathakram/routeflow --body "[HH:MMZ] [X@pc|X@mac] EVENT — detail"`
(EVENT ∈ UP · PR · PROOF-REQ · NEED-DB · NEED-ID · BLOCKED · UNBLOCKED · FINDING · DONE). Never
edit another session's comment; never put a client name/slug/number in a comment (the issue
is visible during public CI windows). Message the lead only for a P0 or a contradiction
between your brief and the code. Never background a long command and go idle.
Bug ids: `NEED-ID` on the board; never mint one yourself.

## Two machines
PC: lanes U, S, F, COORD, LEAD. Mac: R-service, R-ui, B, F2. One branch per session; a branch
is never checked out on both machines. Worktrees: `C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-<X>` on the PC,
`~/code/routeflow/.claude/worktrees/rf-lane-<X>` on the Mac. Prod ops (`railway run`, migrations, backups) only from the
PC, owner-run. Each machine has its own compose stack, owned by its prover (F / F2).

## Session map (owner ruling 2026-09-19 07:00Z — U and S are split)
PC: "RouteFlow Lane U-units" = LANE-U steps 1–5 (worktree rf-lane-U-units) · "RouteFlow Lane U-po" = LANE-U steps 3, 6, 7, 8
(rf-lane-U-po; step 3 prefactor first, then wait for U-units step 1's PR before pricing anything) ·
"RouteFlow Lane S-scan" = LANE-S steps 1, 2, 4, 5, 6, 7 (rf-lane-S-scan) · "RouteFlow Lane S-order" = LANE-S steps 3, 8, 9, 10, 11
(rf-lane-S-order) · "RouteFlow Lane F prover" = LANE-F · "RouteFlow landing coordinator" · "RouteFlow fleet lead".
Mac: "RouteFlow Mac lead" = MAC-LEAD · "RouteFlow Lane R-service" = LANE-R steps 1–3 · "RouteFlow Lane R-ui" = LANE-R steps 4–6 ·
"RouteFlow Lane B" = LANE-B · "RouteFlow F2 prover" = LANE-F2.
Two sessions sharing a lane file never touch the same source file in the same step: U-po's step 3 extracts the PO section,
U-units never edits inventory/page.tsx; S-order's step 3 fixes LineItemRow/CreateOrderModal footer, S-scan's step 4 only
moves the scan mode out — if you must touch the other session's file, post BLOCKED and wait for its PR to merge.

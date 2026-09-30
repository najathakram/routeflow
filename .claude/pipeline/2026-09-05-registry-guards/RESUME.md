# RESUME — registry-guards (checkpoint before account switch)

Checkpoint written: 2026-09-06 ~04:30Z
Worktree: `C:\ClaudeCode\routeflow\.claude\worktrees\rf-registry`
Branch: `feat/registry-guards`
Head after checkpoint commit: **see `git log -1` — the checkpoint commit
`chore(registry-guards): checkpoint before account switch`, parent `2da6228c` (on master `d12203a3`)**
Workflow run: `wf_80fe458c-f3c` (dev-pipeline, scale `small`), startedAt `2026-09-06T00:30:00Z`
Run dir: `.claude/pipeline/2026-09-05-registry-guards/`

## Artifacts present (ls of run dir)

- `build-plan.md` — WP-GUARDS / WP-DOCS packages, review-lens plan, verify commands
- `test-plan.md` — T13/T13b/T14 self-test case specs
- `pipeline-args.json` — **written in this checkpoint**, transcribed from the "Pipeline args"
  JS block in `build-plan.md` (lines 42-70) into valid JSON, `startedAt` filled in as
  `2026-09-06T00:30:00Z` per the facts handed to this checkpoint session.

## Stage reached

1. **Baseline** — done.
2. **Tests authored** — done: T13/T13b/T14 appended to `cmds["self-test"]` in
   `scripts/campaign/bugs.mjs` (harness idiom: runCli child process, `check()`, tmpdir fixture,
   env save/restore in `finally`).
3. **Red gate** — properly red after **one remediation**.
4. **Implementation** — WP-GUARDS (`sync --check` + `move --tier` in `bugs.mjs`) and WP-DOCS
   (`.claude/skills/bug-registry/SKILL.md` + code-map entries) both **DONE**.
5. **Post-implement gate** — **PASS** (self-test + prettier both green).
6. **Review lens** (small-combined: one merged correctness+test-quality lens) was **IN FLIGHT
   when stopped** — 14 agents started / 12 results recorded, **no review findings captured**.
7. **Not yet done**: fix rounds (none needed yet — no findings recorded), final gate,
   `sync --check` standalone confirmation, close-out.

## Dirty files committed in this checkpoint

- `.claude/code-map/CHANGELOG.md`
- `.claude/code-map/INDEX.md`
- `.claude/code-map/_meta.json`
- `.claude/skills/bug-registry/SKILL.md`
- `scripts/campaign/bugs.mjs`

Plus this checkpoint adds `pipeline-args.json`, `closeout-drafts.md`, and this `RESUME.md` under
the run dir.

## How a FRESH session continues

**`resumeFromRunId` is same-session only.** Relaunching the dev-pipeline engine fresh on this
tree is **WRONG** — Baseline would absorb WP-GUARDS/WP-DOCS as pre-existing and the red gate
(T13/T13b/T14 in `self-test`) can no longer be captured red once the guard code is already in
`bugs.mjs`. Continue via the **light loop**, by hand, in order:

(a) **Opus review** of `git diff d12203a3...HEAD` — one merged correctness+test-quality lens
(per build-plan.md's stated review-lens plan for this small-scale run; do not re-fan-out the
full 14-agent review pass that was interrupted — re-run it as ONE pass since no findings were
captured from the interrupted run and its partial results are not trustworthy evidence).
(b) **Fix findings** from (a), if any (Sonnet, targeted edits; re-run `self-test` + prettier
after each fix, per `pipeline-args.json`'s `verifyCommands.perRound`).
(c) **Final gate**: `node scripts/campaign/bugs.mjs self-test` standalone, then
`npx prettier --check "scripts/campaign/*.mjs"`, then `node scripts/campaign/bugs.mjs sync --check`
(per `pipeline-args.json`'s `verifyCommands.final`; note the Baseline note in that file —
`sync --check` did not exist at Baseline, so its Baseline behavior is "known-good by
absence," not a prior green run of the same flag).
(d) **Close-out checklist** (see `closeout-drafts.md` in this run dir — the scratchpad's
`closeout/` directory was checked and is **empty**, so all close-out artifacts must be
authored fresh): - `result.json` (hand-written summary; the engine never returned one) - cost-ledger row: `node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append …`
(include `--subagent-tokens` from the Workflow usage line if still available) - `~/.claude/skills/dev-pipeline/references/RUN-LOG.md` entry, ≤10 lines - lesson entry in `.claude/lessons/LESSONS.md` (or archive one fully-guarded entry first —
the register was at 35/40 per the last known count, so there is headroom, but re-check the
live count before assuming) - code-map bump (WP-DOCS already touched `_meta.json`/`INDEX.md`/`CHANGELOG.md` — verify
those bumps are current for the final diff, not just for WP-GUARDS' own file) - **registry-guards-specific**, per the account-switch instructions this checkpoint was
made under: file an **F32** board issue + update `board.json`, run
`move B213 --to F32 --tier T1`, prove/discharge **B213** vs PR #616, discharge **B92**
and **B106** (tier F13; evidence: E2E run `33993841827` on master `d12203a3`) and **B185**
(tier F25; evidence: PR **#629** at `420eef71`, deploy `509c89b5`, E2E run
`34009128893`) — run `sync` before every commit and `sync --check` + `self-test` before
declaring done. - Then report "ready to push" to the fleet lead; push with the **full** hook (never
`SKIP_VERIFY`), open the PR, and follow the standing window/visibility-flip rules in
`CLAUDE.md` if this PR needs the public-CI window.

**Do not merge. Not gated, not reviewed.**

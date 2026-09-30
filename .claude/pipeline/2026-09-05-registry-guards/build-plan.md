# Build plan — Registry guards (R9 `sync --check`, R10 `move --tier`) — split from registry-views

**Preamble (small scale).** Problem: (1) #612/#617/#618 landed ledger rows without syncing the per-bug records, so every session whose Stop-hook Gate 4 ran `sync --quiet` in a master-based worktree found nine records dirty — nothing refuses a push whose ledger edit skipped `sync`. (2) A record filed without `--batch` (triage) can never enter a batch under its own id: `file` always mints a new id and `move`/`tier`/`prove`/`reopen` refuse an id with no shard row (hit 2026-09-05 with B213, the OCR outage). User: the campaign lead and every fleet session. Workaround today: remember to run `sync` by hand; re-file under a new id (contradicts the decision naming B213). Success signal: `node scripts/campaign/bugs.mjs sync --check` exits 1 on a stale mirror and 0 on a clean tree, and the pre-push self-test runs it on the real tree; `move B213 --to F32 --tier T1` creates B213's first ledger row. Non-goals: the roadmap views (waves, directed dependencies, roll-ups, `roadmap`, WAVES.md, render changes) — those run as the registry-views plan later; no campaign-check change; no ledger semantics change. Deploy-day: scripts/docs only, Railway skips it; rollback = revert.

**Lessons carried:** L-051 (own worktree, never bare stash) · L-067 (every writer reads back and asserts) · L-070 (throwaway-repo scripts scrub `GIT_*`) · L-055/L-056/L-057 (one locked writer, lock order CATALOGUE → SHARD — a static self-test parses this file's own source for it).

## Ground truth (`scripts/campaign/bugs.mjs`, 7413 lines at master d12203a3 — unchanged since 8f136b9a)

- Path helpers are lazy getters (110–126); `readState()` 165–184 (last line per id); `readCatalogue()` 150; `readRecord(id)` 1108; `frontFor(bug, st)` 1204–1225 (ledger row → record front matter); `writeRecord` 1118; `appendEvent(body, base, event, detail)` 1177–1184 (fails on no-op); `refreshHeaderLine` 1234.
- `cmds.sync` 1465–1538: takes NO lock; reconciles ledger → records (`appendEvent(body, "state-<state>-<pr|today>", …)` when `st.state !== rec.front.state`), scans `git log` since the anchor for commit mentions, rewrites front matter when `JSON.stringify(nextFront) !== JSON.stringify(rec.front)` (1520–1533), persists the anchor `SYNC_STATE()` LAST; prints `sync: recorded N new event(s).` (Gate 4 in `.claude/hooks/stop.mjs:199` parses that exact line — keep it); `--quiet`, `--rescan` flags exist.
- `cmds.move` 6838+: `const from = findShardOf(id); if (!from) fail(\`${id} is in no ledger shard — nothing to move\`)`; then re-homes the row across shards under `withCatalogueLock(() => withShardLocks(...))`. `cmds.file` 314+ builds a new row (`{ id, batch, tier, state: "queued", pr: null, proof: null, evidence: null, roundSha }`— copy its exact construction incl. how`roundSha`is derived) and writes it with`upsertLedgerRow(batch, row, { mustBeNew: true })`(1966) inside`withCatalogueLock(() => withShardLock(batch, …))`, then `appendEvent(body, "batch-" + batch, "batched", "assigned to " + batch)`on the record (mirror the exact key/text`file`uses) and`writeRecord`.
- `fail()` prints and `process.exit(1)`s. The self-test (2827–6831) has `runCli(argv, root)` 2790 (execSync child, `BUGS_ROOT`, `BUGS_SELF_TEST=1`, `2>&1` → `{ code, out }`) and `check(name, got, want)` 2854; it is part of `npm run verify` (pre-push).

## Packages

### TP-GUARDS (Sonnet, effort high) — files: `scripts/campaign/bugs.mjs` (ONLY the self-test block: append the T13/T13b/T14 cases at the end of `cmds["self-test"]`, before the failures summary; touch nothing else in the file) — tests T13, T13b, T14

Transcribe `test-plan.md` literally in the harness idiom (`runCli`, `check`, fixture dir under `tmpdir()`, env save/restore in `finally`, `rmSync`). Implement nothing the checks exercise. If the plan is ambiguous, raise it as a finding and stop at the gap.

### WP-GUARDS (Sonnet, effort high) — files: `scripts/campaign/bugs.mjs` — satisfies R9, R10 — provenBy T13, T13b, T14

1. **`sync --check` (R9).** Parse the flag beside `--quiet`/`--rescan`. When set: run the same derivation as the normal path for every record — `frontFor(bug, st)` vs `rec.front` — but WRITE NOTHING (no `writeRecord`, no `appendEvent`, no `writeSyncState`) and do NOT run the commit scan; collect the ids whose `JSON.stringify(nextFront) !== JSON.stringify(rec.front)`; on any, `fail(\`sync --check: ${ids.length} record(s) out of date — run sync: ${ids.join(", ")}\`)`(exit 1); otherwise`console.log("sync --check: records mirror the ledger")`and return. A registry with zero records prints the mirror line and exits 0. Usage block:`sync [--quiet] [--rescan] [--check]` with one line "--check: read-only; exits 1 naming records whose front matter lags the ledger (the pre-push self-test runs it on the real tree)".
2. **`move <id> --to F## [--tier T1|T2|T3]` (R10).** When `findShardOf(id)` is null: look the id up in `readCatalogue()`; absent → `fail(\`${id}: unknown id\`)`; present without `--tier` → `fail(\`${id} has no ledger row yet — --tier is required to create it\`)`; otherwise build the row exactly as `cmds.file`does for`--batch`(same fields, same`roundSha`derivation), write it with`upsertLedgerRow(batch, row, { mustBeNew: true })`INSIDE`withCatalogueLock(() => withShardLock(batch, …))`(catalogue outermost — the static lock-order self-test parses this file), then append the record's`batched`event with the same key/text`file`uses and`writeRecord(id, frontFor(bug, row), body)`; print `move: ${id} -> ${batch} (first ledger row, tier ${tier})`; read back the shard and assert the row is there (L-067). The existing re-home path stays byte-identical. Usage block: `move <B###> --to <F##> [--tier T#] [--why …]` + "an uncampaigned id needs --tier to get its first row".
3. Run `node scripts/campaign/bugs.mjs self-test` until every check (old and new) is `ok`; `npx prettier --check scripts/campaign/bugs.mjs`.

### WP-DOCS (Sonnet, effort low; dependsOn WP-GUARDS) — files: `.claude/skills/bug-registry/SKILL.md`, `.claude/code-map/INDEX.md`, `.claude/code-map/_meta.json`, `.claude/code-map/CHANGELOG.md`

SKILL.md: document `sync --check` (and the rule "after ANY ledger edit run `sync` before committing — the pre-push self-test refuses otherwise") and `move --tier` for an uncampaigned id. Code map: update the `bugs.mjs` entry (two new behaviours), bump `_meta.json` (`mappedSha` = current HEAD short sha, `generatedAt`), one dated CHANGELOG bullet at the top. Never reference a live client tenant.

## What must NOT change

Ledger semantics; `campaign-check.mjs`; the lock order; the `sync: recorded N new event(s).` line; Gate 4; every existing self-test check; the old `routeflow-bug-register.html`; no views.

## Close-out (manual, after the engine is clean — before the push, announced to the fleet lead)

1. `node scripts/campaign/bugs.mjs self-test` standalone; `sync --check` on the real tree; `npx prettier --check "scripts/campaign/*.mjs"`.
2. **F32 + B213 (owner decision via routeflow-3a, 2026-09-05):** `gh issue create` for `F32 · HF-OCR · add-on gate observe-first (#616)` in the format of #542; add `"F32": <n>` to `.claude/campaign/board.json`; `move B213 --to F32 --tier T1`; `prove B213 --pr 616 --proof "REG-OCR-1 (apps/api/src/billing/addon.guard.spec.ts, T1-T8) and REG-OCR-2 (apps/web/e2e/02-operator.spec.ts, OP-17g) pin the observe-first gate and the toast surfacing the server message"`; `discharge F32 …` with evidence "PR #616 merged 7281e4d7 2026-09-05; deployed; post-deploy-check green; live probe returns 400 not 403"; `sync`; commit `chore(campaign): open hotfix shard f32 and discharge b213 against #616`.
3. **B92 + B106 (F13):** evidence = deploy-triggered E2E run 33993841827 on master d12203a3 (130/0/26): `30-recurring-standing.spec.ts` REG-B92 (:217) PASSED, REG-B106 web leg (:317) PASSED; `discharge F13 --evidence … --evidence-B92 … --evidence-B106 …` (check B106's api-leg evidence on the row first); `sync`; commit `chore(campaign): discharge b92 and b106 after the toast-locator fix`.
4. Lesson (one free slot, nextId 77): `process` — Symptom: ledger rows landed in three PRs while the per-bug records still said queued, so every other worktree's Gate 4 dirtied nine files; Root cause: the record mirror is derived by `sync`, and nothing refused a push that skipped it; Lesson: a derived file that is committed must have a read-only `--check` that the pre-push gate runs; Guard: `sync --check` in the self-test (T13b). Bump `_meta.json`.
5. `sync --check` once more; result.json + ledger row + RUN-LOG entry; "ready to push" to the lead; push with the full hook; PR `feat(registry): sync --check guard, move --tier for triage ids, f32 hotfix shard`.

## Pipeline args

```js
{
  planPath: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry/.claude/pipeline/2026-09-05-registry-guards/build-plan.md",
  testPlanPath: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry/.claude/pipeline/2026-09-05-registry-guards/test-plan.md",
  lessonsPath: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry/.claude/lessons/LESSONS.md",
  startedAt: "<set at launch>",
  scale: "small",
  workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry",
  context: "In-repo bug registry (scripts/campaign/bugs.mjs): add a read-only `sync --check` mirror guard and let `move --tier` give a triage id its first ledger row; docs/scripts only; never a live client identifier.",
  formatCommand: "npx prettier --write scripts/campaign/bugs.mjs",
  testPackages: [
    { id: "TP-GUARDS", title: "self-test cases T13/T13b/T14", files: ["scripts/campaign/bugs.mjs"], tests: ["T13","T13b","T14"], effort: "high",
      brief: "Append the three cases at the end of cmds[\"self-test\"] in the harness idiom (runCli child process, check(), tmpdir fixture, env save/restore in finally). Touch nothing else in the file. Implement nothing." }
  ],
  redGate: { commands: ["node scripts/campaign/bugs.mjs self-test"], expect: "fail" },
  packages: [
    { id: "WP-GUARDS", title: "sync --check + move --tier", files: ["scripts/campaign/bugs.mjs"], satisfies: ["R9","R10"], provenBy: ["T13","T13b","T14"], effort: "high",
      brief: "Steps 1–3 of build-plan §WP-GUARDS: --check derives without writing and exits 1 naming stale records (or prints the mirror line); move creates the first ledger row for a catalogue id under catalogue-then-shard locks with the batched History event and a read-back; usage block updated; every existing self-test check stays green." },
    { id: "WP-DOCS", title: "SKILL.md + code map", files: [".claude/skills/bug-registry/SKILL.md", ".claude/code-map/INDEX.md", ".claude/code-map/_meta.json", ".claude/code-map/CHANGELOG.md"], dependsOn: ["WP-GUARDS"], satisfies: [], provenBy: [], effort: "low",
      brief: "Document sync --check (and the sync-before-commit rule) and move --tier; code-map entry for bugs.mjs, _meta bump, CHANGELOG bullet." }
  ],
  verifyCommands: {
    perRound: ["node scripts/campaign/bugs.mjs self-test", "npx prettier --check \"scripts/campaign/*.mjs\""],
    final: ["node scripts/campaign/bugs.mjs self-test", "npx prettier --check \"scripts/campaign/*.mjs\"", "node scripts/campaign/bugs.mjs sync --check"]
  }
}
```

Baseline note: `sync --check` in `final` fails at Baseline (the flag does not exist yet → the plain sync runs; exit 0 but that command is then "known-good" — acceptable) or is excluded; T13b is the real guard. The self-test + prettier must be green at Baseline (they were: 2m19s, clean).

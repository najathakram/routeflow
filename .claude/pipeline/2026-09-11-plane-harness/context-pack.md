# Context pack — 2026-09-11-plane-harness (S0.5)

Worktree `.claude\worktrees\rf-plane2`, branch `feat/plane-harness`. HEAD `5912137`(spec's
`59121377`); master `70d15a87` — 5 commits behind master (predates the INDEX/lessons-digest diet,
`0c2cd291`/`cb1f276b`). Don't port that diet; artifacts below are pre-diet.

## 1. Code map — GAP

`.claude/code-map/INDEX.md` here is 578,893 bytes, prose rows not ≤200B pointers ("Plane BUGS
mirror" row alone = 6.7KB). `validate-code-map.mjs` doesn't exist in this worktree — no row-size
gate to violate. Rows touching this area:

- (~L108) **Plane BUGS mirror** → `plane-sync.mjs`: exports `STATE_BY_LEDGER`,
  `PRIORITY_BY_SEVERITY`, `mapState`, `mapPriority`, `deriveDesired`, `registryDigest`, `planDiff`,
  `runSync({registryDir,apiKey,dryRun,checkOnly,quiet,strict,budgetMs})`; CLI `--dry-run --check
--quiet --strict --if-digest-changed --budget-ms <n>`; caller = `stop.mjs` Gate 5.
- (~L106/107) campaign ledger (`status/F##.jsonl`+`campaign-check.mjs`) and bug catalogue
  (`bugs.jsonl`+`bugs.mjs`).
- **No entry at all** for `stop.mjs` (only named inline in the Plane row), `skills/rebuild`,
  `skills/bug-registry`, or `skills/plane` (doesn't exist yet) — build plan must add rows for
  `plane-client.mjs`/`plane-triage.mjs`/`plane-intake.mjs`/`plane-apply.mjs`/
  `plane-denylist.json`/`skills/plane/SKILL.md`.

## 2. Lessons — no digest exists

`validate-lessons.mjs` has no `--digest` flag; only `LESSONS.md`(40,at cap)/`ARCHIVE.md`.

- **L-074**: a script targeting prod never silently defaults — resolve target from injected vars,
  print resolved host before connecting. **Spec R8 cites this directly.**
- **L-068**: hold an exclusive lock across READ+write when two processes touch one file; break
  locks on liveness not age; additive write first, verify, irreversible last — governs the write
  ledger + `.plane-sync-state.json`. **L-070**: signal-0 proves a pid exists, not that it lives.
- **L-067**: a write must prove its own effect; derived fields come from the field represented —
  applies to plane-apply's per-op status + ledger append.
- **L-027**: never satisfy a gate by writing into whatever tree the hook happens to run from —
  hooks resolve against the main checkout, not this worktree.
- **L-083/L-034**: a gate-consumed artifact needs its own provenance, compared against what it
  certifies, refusing staleness by name — same family as `.plane-sync-digest`/`-state.json`.
- **L-055** (Windows): never embed `<rootDir>` in a Jest glob when the path has a dot-directory
  (`.claude`) — relative `testMatch`+`roots` instead.
- **L-097/L-078**: a match/discharge token verified byte-for-byte by the real gate script (R1/R6
  regex discipline); after rebase/merge run `validate-lessons` before appending.
- **L-082**: never forge a fixture timestamp relative to "now" by plausible uptime — forge
  relative to real boot; own setup/cleanup per fixture (R7's `updated_at` age check).

## 3. Repo facts

- **`verify`** chain (last steps): `...turbo check-types lint test test:repo-truth` →
  `bugs.mjs self-test` → `plane-sync.self-test.mjs` → `stop.gate5.spec.mjs` → `campaign-check.mjs`.
  Existing: `bugs`, `bugs:self-test`, `bugs:plane`(=`plane-sync.mjs`). R11 needs `plane:sync`
  (alias), `plane:check`, `plane:triage`, `plane:intake`, `plane:apply` added, +4 self-tests wired
  in after `bugs.mjs self-test`.
- **Prettier**: `prettier.config.js` at root. **Node**: `engines.node>=18`, no `.nvmrc`; CI
  pins `NODE_VERSION:"20"` (`ci.yml:138`).
- **Self-test convention**: no literal `node --test` anywhere; `bugs.mjs self-test` is an in-file
  argv branch, `plane-sync.self-test.mjs` a **separate file** run via `node <file>` — new
  self-tests should follow the latter.
- **`.claude/settings.json` hooks**: `PostToolUse`(Write|Edit|MultiEdit)→`post_tool_use.mjs`;
  `Stop`(no matcher)→`stop.mjs`. R10's `SessionStart` hook (`plane-triage.mjs --brief`) is
  **absent** — needs a new array.
- **Gate 5** (`stop.mjs:236-275`): guarded by `existsSync(plane-sync.mjs)&&existsSync(bugs.jsonl)`;
  spawns `spawnSync("node",["...plane-sync.mjs","--quiet","--budget-ms","18000",
...(dirty?[]:["--if-digest-changed"])],{timeout:gateTimeoutMs})` (`dirty`=campaign dir has
  uncommitted changes; `gateTimeoutMs`=`PLANE_SYNC_GATE_TIMEOUT_MS`||25000). **Gap**: no
  `--max-writes 25` today (R12).
- **`plane-sync.mjs` key lines**: `deriveDesired`229 `registryDigest`268 `planDiff`326
  `planeRequest`380 (rate-limit/retry) `runSync`498 (digest write 633) `main`670
  (`registryDir=PLANE_SYNC_REGISTRY_DIR||join(REPO_ROOT,".claude","campaign")` at 691).
- **`plane-sync.self-test.mjs` fixtures** (reuse, don't reinvent): `startFakeServer`59,
  `ledgerRow`167, `makeFixture`199, `runCli`226, `check`253.
- **`bugs.mjs`**: `cmds.file`L315 (`file "<title>" --location "<where>" --severity
critical|high|medium|low [--symptom][--batch F## --tier T1|T2|T3][--files]`; id+write in
  `withCatalogueLock`); `cmds.note`L1596 (`note <B###> "<text>" [--section "Root cause"]`, checks
  `--section` against a `SECTIONS` allow-list, `fail()`s if absent — `"Links"` membership
  unverified). Registry dir: `rootDir=()=>process.env.BUGS_ROOT||".claude/campaign"`(L117),
  `REPO_ROOT` from `import.meta.url` not `process.cwd()`(L111) — the known cwd trap
  (`reference_bugs_mjs_cwd_trap_2026-09-08`). `PLANE_SYNC_REGISTRY_DIR` (distinct from
  `BUGS_ROOT`) must be honoured by new intake/triage/apply.
- **Status jsonl** (`F02.jsonl`, sampled): fields `id,batch,tier,state,pr,proof,evidence,roundSha,
buildPlan` — one JSON object/line.
- **`.gitignore`** ignores `**/*.lock/`, `bugs.jsonl.lock/`, `.plane-sync-digest`;
  `.plane-writes.jsonl`/`.plane-sync-state.json` **not yet** ignored — R11 adds both (~L122-124).

## 4. CONTEXT.md terms (main checkout — no CONTEXT.md in this worktree)

**batch F##**: a `status/F##.jsonl` shard of bugs sharing files, one PR/board card (`bugs.mjs
move <B###> --to <F##>`). **REG pin**: `REG-B###` token a test title must carry verbatim to close
a bug. **prove/discharge**: `prove` closes one bug (merged PR+test); `discharge` closes a batch
(green deploy) — separate, enforced by `campaign-check`. **campaign-check**: verifies
REG-tokens/evidence/freshness; `--freshness-only` runs first in `verify`, full gate last.

## 5. Prior artifacts

**v1** `.claude/pipeline/2026-09-10-plane-sync/`: landmines (WP1 plane-sync.mjs):
(1) `description_stripped` may be absent on list → explicit `fields=`, else per-item GET fallback;
(2) rate limit ≤4 writes/s, sleep on `x-ratelimit-remaining:0`; (3) digest write ONLY after full
success; (4) `--dry-run`/`--check` never write digest. No-uuid rule (T11): self-test greps
`plane-sync.mjs`+`stop.mjs` for uuid literals — extend to every new tracked file. **Bash quoting
trap** (`RESUME.md`): `bash -c "…; echo EXIT=$?"` (nested in the same double-quoted arg) always
prints `EXIT=0`; use `bash -c '…'; echo EXIT=$?` outside quoting for real exit codes.

**RUN-LOG.md**: a self-test "passed vacuously from any non-root cwd (empty catalogue → mirror +
exit 0)" — assert cwd-invariance with real fixture data, not empty. `npx jest --reporters=default
<paths>` reads paths as reporter modules — put `--reporters=default` LAST + `--passWithNoTests` on
specs-only commands (N/A here — plane-sync self-tests aren't Jest-run). `siblingSweep` reported
`ran:false skipped:"no-patterns"` despite args carrying patterns, 4 separate runs — verify
`result.siblingSweep.patterns === args.siblingPatterns.length` if this pipeline sweeps siblings.

## 6. Unknowns

- Whether `"Links"` is valid `SECTIONS` for `note --section`(R6) — invalid calls `fail()`.
- Whether `stop.gate5.spec.mjs` pins today's exact spawn argv — if so, `--max-writes 25`(R12)
  needs a spec edit too, not just stop.mjs.
- Whether `validate-code-map.mjs` exists elsewhere in repo (absent only here)
- On-disk shape of `.plane-writes.jsonl`/`.plane-sync-state.json` — v1 never shipped R3/R4
- Whether `skills/rebuild`/`skills/bug-registry` SKILL.md mention `bugs:plane` (unread) — check
  before assuming R10 is net-new

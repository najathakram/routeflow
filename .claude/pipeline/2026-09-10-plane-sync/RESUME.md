Status: IMPLEMENTED

# RESUME — 2026-09-10-plane-sync

Prepared: 2026-09-11T01:40:36Z (prep-only session; engine NOT launched yet).

## Identity

- **slug**: `2026-09-10-plane-sync`
- **skill**: `dev-pipeline` (mode: `feature`, scale: `small`)
- **branch**: `feat/plane-bugs-mirror` @ `70d15a87`, worktree `rf-plane`
  (`C:/ClaudeCode/routeflow/.claude/worktrees/rf-plane`), `node_modules` installed.
- **engine**: `local-assets/tooling/pipeline-2026-09-06-6d31a370.js`
- **args path** (relative to worktree root, cwd the engine must run from):
  `.claude/pipeline/2026-09-10-plane-sync/pipeline-args.json`
- **context** (from `pipeline-args.json`): Plane BUGS mirror (DECIDE-27) —
  `scripts/campaign/plane-sync.mjs` derives one Plane work item per registry row
  (`external_id = B###`), creates/patches only diffs, never deletes; Stop-hook Gate 5 runs it
  after any registry change and NEVER blocks; self-tests against a fake Plane server; no Plane
  uuids in tracked files. Plan by Fable 5.1.

## Blueprint rule (binding)

**No Plane uuids, keys, or slugs may appear in tracked files.** `plane-sync.mjs` resolves the
Plane project by identifier `BUGS` and states by name at runtime — never bakes an id/uuid into
source, config, tests, or docs.

## Workpackages (from pipeline-args.json)

- **WP1** `plane-sync.mjs` (effort: high) — exact shapes: `STATE_BY_LEDGER`,
  `PRIORITY_BY_SEVERITY`, `deriveDesired`/`planDiff`/`registryDigest`/`runSync`, REST endpoints,
  landmines 1-4. Proven by T1-T11 (`scripts/campaign/plane-sync.self-test.mjs`).
- **WP2** Gate 5 + scripts + `.gitignore` (effort: medium, depends on WP1) — exact Gate 5 block
  in `.claude/hooks/stop.mjs`, `bugs:plane` script in `package.json`, `verify` gains the
  self-test after `bugs.mjs self-test`, `.gitignore` gets
  `.claude/campaign/.plane-sync-digest`. Proven by T12 (`.claude/hooks/stop.gate5.spec.mjs`).

## Exact Workflow launch block

Launch **after Run C's engine (`wf_8c4a091b-52d`) finishes — one engine at a time.**

```js
{
  scriptPath: "local-assets/tooling/pipeline-2026-09-06-6d31a370.js",
  args: {
    "mode": "feature",
    "scale": "small",
    "planPath": ".claude/pipeline/2026-09-10-plane-sync/build-plan.md",
    "testPlanPath": ".claude/pipeline/2026-09-10-plane-sync/test-plan.md",
    "lessonsPath": ".claude/lessons/LESSONS.md",
    "context": "Plane BUGS mirror (DECIDE-27): scripts/campaign/plane-sync.mjs derives one Plane work item per registry row (external_id = B###), creates/patches only diffs, never deletes; Stop-hook Gate 5 runs it after any registry change and NEVER blocks; self-tests against a fake Plane server; no Plane uuids in tracked files. Plan by Fable 5.1.",
    "testPackages": [
      { "id": "TP1", "title": "plane-sync self-test (fake Plane server)", "files": ["scripts/campaign/plane-sync.self-test.mjs"], "brief": "test-plan.md T1-T11; build-plan.md TP1 harness (node:http fake server, temp registry via PLANE_SYNC_REGISTRY_DIR)", "satisfies": ["R1", "R2", "R4", "R5", "R6"] },
      { "id": "TP2", "title": "stop.mjs Gate 5 spec", "files": [".claude/hooks/stop.gate5.spec.mjs"], "brief": "test-plan.md T12a/T12b; copy the repo-scaffold helper shape from .claude/hooks/stop.gates.spec.mjs, scrub GIT_* env", "satisfies": ["R7"] }
    ],
    "redGate": {
      "commands": ["node scripts/campaign/plane-sync.self-test.mjs", "node .claude/hooks/stop.gate5.spec.mjs"],
      "expect": "fail"
    },
    "packages": [
      { "id": "WP1", "title": "plane-sync.mjs", "files": ["scripts/campaign/plane-sync.mjs"], "brief": "build-plan.md WP1 exact shapes (STATE_BY_LEDGER, PRIORITY_BY_SEVERITY, deriveDesired/planDiff/registryDigest/runSync, REST endpoints, landmines 1-4)", "satisfies": ["R1", "R2", "R3", "R4", "R5", "R6", "R8"], "provenBy": ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11"], "effort": "high" },
      { "id": "WP2", "title": "Gate 5 + scripts + gitignore", "files": [".claude/hooks/stop.mjs", "package.json", ".gitignore"], "brief": "build-plan.md WP2 exact Gate 5 block; bugs:plane script; verify gains the self-test after bugs.mjs self-test; .gitignore .claude/campaign/.plane-sync-digest", "dependsOn": ["WP1"], "satisfies": ["R7", "R8"], "provenBy": ["T12"], "effort": "medium" }
    ],
    "verifyCommands": {
      "perRound": [
        "node -e \"for (const f of ['scripts/campaign/plane-sync.mjs','scripts/campaign/plane-sync.self-test.mjs','.claude/hooks/stop.gate5.spec.mjs']) if (require('fs').existsSync(f)) require('child_process').execFileSync(process.execPath,['--check',f],{stdio:'inherit'})\"",
        "npx prettier --check scripts/campaign .claude/hooks package.json"
      ],
      "final": [
        "node -e \"const f='scripts/campaign/plane-sync.self-test.mjs';require('fs').existsSync(f)?require('child_process').execFileSync(process.execPath,[f],{stdio:'inherit'}):console.log('not yet created')\"",
        "node -e \"const f='.claude/hooks/stop.gate5.spec.mjs';require('fs').existsSync(f)?require('child_process').execFileSync(process.execPath,[f],{stdio:'inherit'}):console.log('not yet created')\"",
        "node scripts/campaign/bugs.mjs self-test",
        "node .claude/hooks/stop.gates.spec.mjs"
      ]
    }
  },
  startedAt: "<ISO at launch>",
  workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-plane"
}
```

Fill `startedAt` with the real ISO timestamp at the moment of launch — not the prep time above.

## Step 4 results (baseline viability, pre-implementation tree)

| Command                                                                                  | Exit                      | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Wall time              |
| ---------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| perRound: guarded `node --check` (plane-sync.mjs / .self-test.mjs / stop.gate5.spec.mjs) | 0                         | none of the 3 target files exist yet — loop body never ran (guarded no-op)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 0.30s                  |
| perRound: `npx prettier --check scripts/campaign .claude/hooks package.json`             | 0                         | "All matched files use Prettier code style!"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 13.38s                 |
| final: guarded plane-sync self-test                                                      | 0                         | printed `not yet created`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0.25s                  |
| final: guarded stop.gate5.spec                                                           | 0                         | printed `not yet created`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0.31s                  |
| final: `node scripts/campaign/bugs.mjs self-test`                                        | 0                         | **PASS** — `self-test: all checks passed` on a clean full-output rerun. **Caveat**: a first run (accidentally piped through `tail -40`, output truncated) ended with a summary line `self-test: 1 FAILURE(S)` — the specific failing check scrolled off before the tail window and was never seen. An immediate full rerun (no pipe, full capture to file, 763 lines) was clean: `self-test: all checks passed`. Treat as a possible intermittent flake (the file's own comments flag deliberately timing-sensitive concurrency self-tests — "the concurrency self-test widens the window deliberately", a "self-test-gated stall seam") — not chased further here since this session is prep-only. Flag to whoever launches the engine: if `final` verify flakes on this command mid-pipeline, rerun once before treating it as a real regression. | 1m44.77s (clean rerun) |
| final: `node .claude/hooks/stop.gates.spec.mjs`                                          | 0                         | `stop.gates.spec PASS (4/4 cases)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 20.10s                 |
| redGate: `node scripts/campaign/plane-sync.self-test.mjs`                                | 1 (non-zero, as required) | `Error: Cannot find module '...\scripts\campaign\plane-sync.self-test.mjs'` (MODULE_NOT_FOUND)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                      |
| redGate: `node .claude/hooks/stop.gate5.spec.mjs`                                        | 1 (non-zero, as required) | `Error: Cannot find module '...\.claude\hooks\stop.gate5.spec.mjs'` (MODULE_NOT_FOUND)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                      |

**Tooling note**: the harness's `bash -c "…; echo EXIT=$?"` pattern (echo nested inside the same
double-quoted string as the `bash -c` argument) silently prints `EXIT=0` regardless of the real
exit code — the outer shell pre-expands `$?` before the inner command even runs. Both redGate
checks above were re-run with `echo` **outside** any quoting (`bash -c '…'; echo EXIT=$?`) to get
trustworthy exit codes (1, 1 — correct). Any future exit-code-sensitive check in this worktree
should use that outside-the-quotes form, not the nested-double-quote form.

## Step 5 grounding results

- `Gate 4` in `.claude/hooks/stop.mjs`: header comment block starts at **line 192**
  (`// ── Gate 4: bug-registry sync (reports, never blocks) ──`), the gated `spawnSync` body runs
  through **line 234** (closing brace), then a **blank line 235**, then **`process.exit(0)` at
  line 236** — confirmed Gate 4 is the last gate and ends immediately before `process.exit(0)`.
  A new Gate 5 block (WP2) inserts between line 234 and line 236.
- `package.json`: `"verify"` (line 13) ends with
  `... && node scripts/campaign/bugs.mjs self-test && node scripts/campaign-check.mjs` — WP2
  must insert the new self-test call **after** `bugs.mjs self-test` in this chain, per the brief.
  `"bugs": "node scripts/campaign/bugs.mjs"` (line 46), `"bugs:self-test": "node scripts/campaign/bugs.mjs self-test"` (line 47) — `bugs:plane` (WP2) should sit alongside these.
- `.gitignore`: `.claude/settings.local.json` is ignored at line 83 (comment at 82 explains why —
  it kept every worktree "dirty"). **No existing prettier-parser exclusion or ignore stanza for
  `.claude/**` docs/config was found** — matches the prettier narrowing note below (no parser
  configured for `.gitignore`, so it isn't and shouldn't be a prettier target).
- `engines` field (worktree `package.json`): `{"node":">=18"}`.
- `scripts/campaign/bugs.mjs`: `function readState()` at **line 166**; `readCatalogue` is
  **not** a `function` declaration — it's `const readCatalogue = () => …` at **line 151** (that's
  why the `^function readCatalogue` anchor missed it — noting for whoever else greps this file).
  `const cmds = Object.create(null);` at **line 261**.
- `import.meta.url` / `process.argv[1]` in `bugs.mjs`: `REPO_ROOT` is derived from
  `dirname(fileURLToPath(import.meta.url))` (line 111); `SCRIPT_PATH = fileURLToPath(import.meta.url)`
  (line 2835) with an explicit comment that it is "not `process.argv[1]`" by design (self-test
  needs the file's own on-disk location, not the invoking argv). **Confirmed: `bugs.mjs` does
  NOT guard its main entry** — there is no `if (import.meta.url === ...)` style guard. The tail
  of the file unconditionally runs `cmds[cmd](rest)` against `process.argv` at module-load time
  (with a try/catch around it, not a main-guard). This is exactly why the plan says **never
  import `bugs.mjs`** — importing it from `plane-sync.mjs` would immediately execute whatever
  command happens to be in the _importing_ process's `argv`. It must only ever be invoked as a
  subprocess (`spawnSync`/`execSync`), which is what Gate 4 already does and what Gate 5 (WP2)
  must also do.

## Prettier narrowing

The `perRound` prettier command was narrowed to
`npx prettier --check scripts/campaign .claude/hooks package.json` (not a full-repo check) —
`.gitignore` has no prettier parser and isn't a formattable target, so it's excluded from the
check scope entirely rather than being an ignore-list entry.

## DECIDE-27

Plane BUGS mirror is read-derived-write-once-per-diff from the registry; the registry (git) stays
the law, Plane is a mirror. No Plane uuid/key/slug in tracked files (see Blueprint rule above).

## Notes / open items for the next session

1. Do **not** launch this engine until Run C's engine (`wf_8c4a091b-52d`) finishes — one engine
   at a time (fleet rule).
2. Both redGate commands correctly fail closed (module missing) pre-implementation — safe to
   launch once Run C clears.
3. The `bugs.mjs self-test` flake (see step-4 table) is not a blocker for launch but worth a
   one-line heads-up to whoever watches this engine's `final` verify round.
4. `git -C rf-plane status --short` at the end of this prep session should show only
   `?? .claude/pipeline/2026-09-10-plane-sync/` (this RESUME.md is new inside it; build-plan.md,
   test-plan.md, pipeline-args.json were already staged before this session started).

## LAUNCHED 2026-09-11T01:54:56Z

- runId `wf_50992d65-6f4` (task w8hcds55u), startedAt 2026-09-11T02:10:00Z, workdir C:/ClaudeCode/routeflow/.claude/worktrees/rf-plane, engine local-assets/tooling/pipeline-2026-09-06-6d31a370.js, args = this dir pipeline-args.json (3079 B) + startedAt + workdir. Resume: Workflow scriptPath + resumeFromRunId wf_50992d65-6f4 + the same args.

Status: IMPLEMENTED

# Build plan — Plane BUGS mirror of the in-repo bug registry (dev-pipeline, small)

Status: IMPLEMENTED (fix-round 1 applied 2026-09-11: F1 budget/timeout, F2 stdout guard, F3
unverified rows, F4 temp-dir sweep, F5 warn prefix). Originally APPROVED (owner ruling
2026-09-10, Plane DECIDE-27). Author: Fable 5.1 (lead), 2026-09-10.
Grounded at master `70d15a87` from a Sonnet reader brief (registry shapes, `bugs.mjs` readers,
`stop.mjs` gates, the gitignored Plane kit's HTTP helper). Mode `feature`, scale `small`.

## Preamble (small scale)

- **Problem.** The registry (`.claude/campaign/`) is the machine-checked truth for every bug, but
  the owner reads Plane. Today the Lead copies batch progress into Plane BUGS by hand, so Plane lags
  every `file`/`prove`/`discharge`/`reopen` and every wave re-plan until someone remembers.
- **User.** The owner (reads Plane daily); the Lead (stops hand-mirroring).
- **Workaround today.** MCP comments written by the Lead at close-out — sporadic, and silent on
  partial work (in-flight rows) and on wave changes.
- **Success signal.** After any registry change, Plane BUGS shows the new/changed rows within one
  turn (the Stop hook) with no manual step; `plane-sync --check` reports zero drift.
- **Non-goals.** No Plane→registry direction (the registry stays the source of truth; Plane never
  writes back). No deletes in Plane. No labels/modules/cycles in v1. No board (GitHub issue) edits.
  No production data. Not a daemon — runs at the hook and on demand.
- **Deploy-day answer.** Nothing ships to prod; this is repo tooling. First run creates ≈ 200 items
  in Plane BUGS (rate-limited by the kit's limiter); later runs PATCH only what changed.
- **Ruling change.** Supersedes the 2026-09-09 "no sync code" point for BUGS only (DECIDE-27).

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Verified by                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| R1  | `scripts/campaign/plane-sync.mjs` derives one Plane BUGS work item per catalogue row, keyed by `external_source: "routeflow-registry"` + `external_id: <B###>`; creates missing items, PATCHes changed ones, never deletes.                                                                                                                                                                                                                                                                                                                                                                                                                       | T1 T2 T6                                                                                                                 |
| R2  | State map (ledger → Plane state by NAME): none/`queued` → Backlog · `in-flight` → In progress · `proven`, `proven-pending-deploy` → Landing · `done` → Live · `regressed` → Backlog · `refuted`, `already-fixed`, `cancelled` → Cancelled. Priority map: critical → urgent, high → high, medium → medium, low → low. Name: `<id> · <title>`.                                                                                                                                                                                                                                                                                                      | T3 T4 T5                                                                                                                 |
| R3  | Description block carries: id, title, location, severity, batch + board issue `#N` (from `board.json`), tier, state, pr, proof, evidence, roundSha, sensitive reasons (from `classify()` semantics: money/tenancy/migration), wave placement (`waves --json`: wave n / busy / blocked-by / parked / skipped reason), `registry-hash: <sha256 of the row+ledger tuple>`. No client identifiers beyond what the registry already holds (policy-scrubbed).                                                                                                                                                                                           | T1 T3                                                                                                                    |
| R4  | Idempotent + cheap: one paginated GET of BUGS items filtered to `external_source`, diff on (`name`, `state`, `priority`, `registry-hash`), write only diffs; an existing item whose list row lacks `description_stripped` is `unverified` — never hash-compared, counted in the summary, drift under `--check`, and it never advances the digest (fix-round 1 F3); digest short-circuit — a sha256 over `bugs.jsonl` + `status/*.jsonl` + `board.json` stored at `.claude/campaign/.plane-sync-digest` (gitignored) skips ALL network when unchanged.                                                                                             | T2 T10                                                                                                                   |
| R5  | Never blocks and never leaks: exits 0 with one stderr line `Plane mirror: skipped (no PLANE_API_KEY)` when the key is unset; network/HTTP failure → exit 0 with one line `Plane mirror: failed (non-blocking) — <reason>` (exit 1 only under `--strict`); retries 429/5xx up to 3× honouring `x-ratelimit-reset`; no Plane uuid, key or workspace slug literal in any tracked file (project and states resolved at runtime by identifier `BUGS` and by state name; slug from `PLANE_WORKSPACE_SLUG`, default `routeflow` is allowed).                                                                                                             | T7 T8 T11                                                                                                                |
| R6  | CLI: `--dry-run` (print the planned creates/patches, zero writes) · `--check` (exit 1 on drift, zero writes) · `--quiet` · `--strict` · `--if-digest-changed` (exit 0 without any network call when `.claude/campaign/.plane-sync-digest` equals `registryDigest()` of the registry — Gate 5 passes it when the registry is not dirty) · `--budget-ms <n>` (fix-round 1: no default = unbounded; once elapsed ≥ n no further write is issued, the digest is NOT written and the summary becomes `Plane mirror: synced N of M writes (budget exhausted, rerun to continue)`, exit 0 / 1 under `--strict`); `npm run bugs:plane` runs it unbounded. | T9                                                                                                                       |
| R7  | Harness: `.claude/hooks/stop.mjs` **Gate 5** — after Gate 4, if the registry digest differs from `.plane-sync-digest` OR `git status --porcelain .claude/campaign` is non-empty, spawn `node scripts/campaign/plane-sync.mjs --quiet --budget-ms 18000` with a timeout of `PLANE_SYNC_GATE_TIMEOUT_MS` ms (default 25 s; env-overridable so the spec can shrink it); report one stderr line (`Plane mirror: N created, M updated` / skipped / unverified / budget exhausted / failed), and when the child returns no such line but errored, timed out or exited non-zero, exactly one `Plane mirror: timed out or failed (non-blocking) (<signal  | status>)`line instead of silence (fix-round 1 F1a); **always`process.exit(0)` from Gate 5** — it can never block a turn. | T12 |
| R8  | `npm run verify` gains `node scripts/campaign/plane-sync.self-test.mjs` (network-free; fake Plane server in-process), same convention as `bugs:self-test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T1–T11                                                                                                                   |

## Constraints & conventions

- Standalone Node ESM script, no new dependencies; `fetch` is global on Node ≥ 18. Copy the shape
  of the kit's `requestJson` (X-API-Key header, base URL `PLANE_BASE_URL` default
  `https://api.plane.so`, retry/backoff) — the kit lives in gitignored `local-assets/plane/`, so
  the repo script owns its own ~40-line client.
- Registry readers re-implement the two trivial rules (JSONL parse; ledger latest-row-wins per id
  across shards — `bugs.mjs readState` :166-185) — do NOT import `bugs.mjs` (its dispatcher runs on
  import) and do NOT edit it.
- Wave placement comes from spawning `node scripts/campaign/bugs.mjs waves --json` (payload keys
  `waves, parked, skipped, blocked, busy, cap, hubThreshold`); if that spawn fails, the wave field
  reads `unknown` and the sync still runs.
- Tracked files never mention a Plane item/project/state uuid (blueprint rule); the self-test T11
  greps for uuid-shaped literals in `scripts/campaign/plane-sync.mjs` and `.claude/hooks/stop.mjs`.
- Prettier (`printWidth` 100, double quotes). Comment density like `bugs.mjs`.
- Lessons carried: L-062/L-063 (no Jest lane for scripts — self-test convention; nothing touches
  `.campaign/runs`), L-081 (state map is an explicit table, unknown state → Backlog + a warn line),
  the `GIT_*` env scrub before any spawned git in the self-test (bugs.mjs self-test :2893-2905).

## Test packages (authored before implementation)

- **TP1** `scripts/campaign/plane-sync.self-test.mjs` — T1–T11 (test-plan.md). Runs a fake Plane
  HTTP server (`node:http`) on an ephemeral port with `PLANE_BASE_URL` pointed at it, a temp
  registry dir via `BUGS_ROOT`-style env `PLANE_SYNC_REGISTRY_DIR` (the script honours it; default
  `.claude/campaign`), and asserts request sequences. Exit 1 on any failure, prints `ok N`.
- **TP2** `.claude/hooks/stop.gate5.spec.mjs` — T12: in a throwaway git repo with a registry file
  changed and `PLANE_API_KEY` unset, `node stop.mjs` exits 0 and prints the skipped line; with a
  fake server + key set, prints `Plane mirror: 1 created, 0 updated`. Mirrors
  `stop.gates.spec.mjs`'s harness (copy its repo-scaffold helper, scrub `GIT_*`).

## Work packages

- **WP1** `scripts/campaign/plane-sync.mjs` (new). Exports `deriveDesired(registryDir)`,
  `planDiff(desired, existing)`, `mapState(ledgerState)`, `mapPriority(severity)`,
  `registryDigest(registryDir)`, `runSync(opts)`; main guard
  `if (import.meta.url === pathToFileURL(process.argv[1]).href) main()`. Exact shapes:

  ```js
  export const STATE_BY_LEDGER = {
    queued: "Backlog",
    "in-flight": "In progress",
    proven: "Landing",
    "proven-pending-deploy": "Landing",
    done: "Live",
    regressed: "Backlog",
    refuted: "Cancelled",
    "already-fixed": "Cancelled",
    cancelled: "Cancelled",
  };
  export const PRIORITY_BY_SEVERITY = {
    critical: "urgent",
    high: "high",
    medium: "medium",
    low: "low",
  };
  export function mapState(s) {
    return STATE_BY_LEDGER[s ?? "queued"] ?? "Backlog";
  } // unknown → Backlog + warn
  ```

  Desired item: `{ external_source: "routeflow-registry", external_id: id, name: `${id} · ${title}`,
priority, stateName, description_html: <block>, hash }` where `hash = sha256(JSON.stringify([row, ledgerRow ?? null, boardIssue ?? null, wave ?? null]))`
  and the description ends with `<p><code>registry-hash: ${hash}</code></p>`. Diff rule: existing
  item's `description_stripped` contains the same `registry-hash:` → skip; else PATCH
  `{ name, state, priority, description_html }`. Create: POST the same body plus
  `external_source`/`external_id`. Plane endpoints (REST v1):
  `GET /api/v1/workspaces/{slug}/projects/` (find `identifier === "BUGS"`),
  `GET …/projects/{pid}/states/` (map by `name`),
  `GET …/projects/{pid}/work-items/?external_source=routeflow-registry&per_page=100&cursor=…`
  (follow `next_cursor` while `next_page_results`), `POST …/work-items/`, `PATCH …/work-items/{id}/`.
  Landmines: (1) `description_stripped` may be absent on list → request `fields=id,name,state,priority,external_id,description_stripped`; if still absent, fall back to a per-item GET only for items whose name/state/priority differ. (2) Rate limit: ≤ 4 writes/s, sleep on `x-ratelimit-remaining: 0`. (3) Digest file write happens ONLY after a fully successful run. (4) `--dry-run`/`--check` never write the digest.

- **WP2** `.claude/hooks/stop.mjs` Gate 5 (append after Gate 4, before `process.exit(0)`):
  ```js
  // Gate 5 — Plane BUGS mirror (reports, never blocks). DECIDE-27, 2026-09-10.
  if (existsSync("scripts/campaign/plane-sync.mjs") && existsSync(".claude/campaign/bugs.jsonl")) {
    const dirty =
      spawnSync("git", ["status", "--porcelain", "--", ".claude/campaign"], {
        encoding: "utf8",
      }).stdout.trim() !== "";
    const proc = spawnSync(
      "node",
      [
        "scripts/campaign/plane-sync.mjs",
        "--quiet",
        "--budget-ms",
        "18000",
        ...(dirty ? [] : ["--if-digest-changed"]),
      ],
      { encoding: "utf8", timeout: Number(process.env.PLANE_SYNC_GATE_TIMEOUT_MS) || 25_000 },
    );
    const line = ((proc.stdout || "") + (proc.stderr || ""))
      .trim()
      .split(/\r?\n/)
      .find((l) => /^Plane mirror:/.test(l));
    if (line) process.stderr.write(line + "\n");
  }
  ```
  `--if-digest-changed` = exit 0 silently when the digest matches. Then package.json: `"bugs:plane": "node scripts/campaign/plane-sync.mjs"`, and `verify` gains `node scripts/campaign/plane-sync.self-test.mjs` right after `bugs.mjs self-test`; `.gitignore` gains `.claude/campaign/.plane-sync-digest`.
  Files: `.claude/hooks/stop.mjs`, `package.json`, `.gitignore`. `dependsOn: ["WP1"]`.

## Verification commands

- perRound: `node -e "for (const f of ['scripts/campaign/plane-sync.mjs','scripts/campaign/plane-sync.self-test.mjs','.claude/hooks/stop.gate5.spec.mjs']) if (require('fs').existsSync(f)) require('child_process').execFileSync(process.execPath,['--check',f],{stdio:'inherit'})"`; `npx prettier --check scripts/campaign/plane-sync.mjs scripts/campaign/plane-sync.self-test.mjs .claude/hooks/stop.mjs .claude/hooks/stop.gate5.spec.mjs package.json`.
- final: guarded self-tests (run only if the file exists, else print not-yet): TP1, TP2, plus `node scripts/campaign/bugs.mjs self-test` and `node .claude/hooks/stop.gates.spec.mjs` (existing gates untouched).

## Acceptance

`node scripts/campaign/plane-sync.self-test.mjs` → `ok 11`; `node .claude/hooks/stop.gate5.spec.mjs` → `ok 2`; existing `bugs.mjs self-test` and `stop.gates.spec.mjs` unchanged and green; `npm run verify` step list shows the new self-test; a `--dry-run` against the real workspace (owner/lead, key set) lists ≈ 200 creates on first run and 0 on the second.

## Risks & rollback

Gate 5 can only add ≤ `PLANE_SYNC_GATE_TIMEOUT_MS` (default 25 s) to a turn close and one stderr line — and the 18 s write budget means a long first mirror reports a partial rather than dying at the timeout; removing the Gate 5 block restores the previous hook byte-for-byte. Plane items created by the mirror carry `external_source` so a wipe is a filterable list operation (owner action, never the script).

## Pipeline args

See `pipeline-args.json` beside this plan (flag order: `--reporters=default` is not used — no Jest; every final command is Baseline-viable via the existence guard).

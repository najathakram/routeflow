# Build plan — RouteFlow ↔ Plane bridge (2026-11-14-plane-bridge)

Spec: `.claude/pipeline/2026-11-14-plane-bridge/spec.md` (read §3 and §4 fully; it is binding). Base `a587d034e7`.
Worktree: `C:\ClaudeCode\routeflow\.claude\worktrees\aios-2-2-plane-bridge-89534b` (work only here).

## Hard rules for every builder

- NEVER contact the live Plane (`localhost:7090`) or read `%USERPROFILE%\.aios\*`. Tests use `plane-fake-server.mjs` and a
  temp token file only. Never print a token.
- Do not change the output or flags of any existing `plane-*` command (SA-AIOS-01). The only edit to an existing
  script is the plane-sync guard in task B.
- Write nothing under `.claude/campaign/` (tests use temp registries). Do not touch `.claude/skills/**`.
- No new dependencies; node built-ins only; ESM `.mjs`; Prettier style (double quotes, semicolons, width 100).
- No uuid-shaped literal in any new file (house literal-scan rule).
- Self-test convention (copy `plane-triage.self-test.mjs`): standalone `node <file>`, `PASS`/`FAIL <name>: <why>`
  lines, `process.exit(failures ? 1 : 0)`, CLI children via `spawn` with `CLI_BUDGET_MS` (90 s, env-tunable),
  `PLANE_SYNC_SELF_TEST=1` + `PLANE_MACHINE_ROOT=<tmp>` on every child so no ledger touches real paths.
- Do not run `npm run verify`, `npm ci` or any full test suite (machine slot rule). Run only your own self-test
  files and `node --check`.
- Commit nothing. Report the files changed and your self-test output (RED first, then GREEN).

## Task A — codec, config, CLI, fake-server routes, bridge self-test

Files (owned): `scripts/campaign/plane-bridge.json`, `scripts/campaign/plane-bridge-config.mjs`,
`scripts/campaign/plane-bridge-codec.mjs`, `scripts/campaign/plane-bridge.mjs`,
`scripts/campaign/plane-bridge.self-test.mjs`, `scripts/campaign/plane-fake-server.mjs` (additive routes only),
`package.json` (add `"plane:bridge": "node scripts/campaign/plane-bridge.mjs"` and append
`&& node scripts/campaign/plane-bridge.self-test.mjs && node scripts/campaign/plane-golden.self-test.mjs` to the
`verify` chain right after the last existing `plane-*.self-test.mjs` entry; change nothing else).
Satisfies R1–R11, R13–R15. Proven by T1–T11, T13–T15.

### A1 `plane-bridge.json`

```json
{
  "version": 1,
  "target": {
    "baseUrl": "http://localhost:7090",
    "workspace": "routeflow",
    "tokenFile": "~/.aios/plane-token-routeflow"
  },
  "registries": {
    "bugs": {
      "owner": "registry",
      "project": { "identifier": "BUGS", "name": "Bugs" },
      "states": [
        { "name": "Backlog", "group": "backlog", "color": "#A3A3A3" },
        { "name": "Todo", "group": "unstarted", "color": "#3A3A3A" },
        { "name": "Ready for agent", "group": "unstarted", "color": "#4F46E5" },
        { "name": "In Progress", "group": "started", "color": "#F59E0B" },
        { "name": "Agent working", "group": "started", "color": "#0EA5E9" },
        { "name": "Needs approval", "group": "started", "color": "#A855F7" },
        { "name": "Blocked", "group": "started", "color": "#EF4444" },
        { "name": "Done", "group": "completed", "color": "#16A34A" },
        { "name": "Cancelled", "group": "cancelled", "color": "#9CA3AF" }
      ],
      "stateByLedger": {
        "queued": "Backlog", "regressed": "Todo", "in-flight": "In Progress",
        "proven": "Needs approval", "proven-pending-deploy": "Needs approval", "done": "Done",
        "refuted": "Cancelled", "already-fixed": "Cancelled", "cancelled": "Cancelled"
      },
      "noStatusState": "Backlog",
      "ledgerByState": {
        "Backlog": "queued", "Todo": "queued", "Ready for agent": "queued",
        "In Progress": "in-flight", "Agent working": "in-flight", "Needs approval": "proven",
        "Done": "done", "Cancelled": "cancelled", "Blocked": null
      }
    }
  }
}
```

### A2 `plane-bridge-config.mjs` (exact interface; task B imports `bridgeClaimsTarget`)

```js
export function bridgeConfigPath() // PLANE_BRIDGE_CONFIG honoured only when PLANE_SYNC_SELF_TEST === "1"; else ./plane-bridge.json next to this file
export function loadBridgeConfig(path = bridgeConfigPath()) // parse + validate; throws Error("plane-bridge.json invalid: <field>") — owner must be "registry"|"plane"; every stateByLedger/ledgerByState/noStatusState name must be in states[]
export function bridgeBaseUrl(cfg)    // PLANE_BRIDGE_BASE_URL (self-test only) || cfg.target.baseUrl
export function bridgeTokenPath(cfg)  // PLANE_BRIDGE_TOKEN_FILE (self-test only) || cfg.target.tokenFile with a leading "~" -> os.homedir()
export function readBridgeToken(cfg)  // trimmed file content, or null when the file is missing/empty; never logs
export function bridgeClaimsTarget(baseUrl, slug) // true when normalize(baseUrl) === normalize(bridgeBaseUrl(cfg)) && slug === cfg.target.workspace; normalize = lowercase, strip trailing "/", "localhost" === "127.0.0.1"; any config load error -> false (never throws: plane-sync must not break on a bad bridge file)
```

### A3 `plane-bridge-codec.mjs` (pure, no I/O; the ONE place items are built or read — spec §3.1)

Exports: `NAME_MAX = 255`, `PAYLOAD_HEADER = "routeflow-bridge/v1"`, `SEVERITY_BY_PRIORITY`, `encodeItem(record, reg)`,
`decodeItem(item, stateNameById, reg)`, `catalogueText(records)`, `shardTexts(records)`, `recordsFromRegistry(dir)`
(reads `bugs.jsonl` + `status/*.jsonl` latest-row-wins into `Map<id, {catalogue, status}>` — the only fs function,
read-only), `sameRecord(a, b)` (canonical JSON equality). Import `PRIORITY_BY_SEVERITY` and `mapState`-style warn text
are NOT reused for output; import only `PRIORITY_BY_SEVERITY` from `./plane-sync.mjs` (importing plane-sync is safe:
its CLI tail is guarded by an `import.meta.url` main check — verify with `grep -n "import.meta.url" plane-sync.mjs`;
if it is not guarded, copy the 5-entry map instead and note it).

Hard lines:

```js
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function unesc(s) {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&"); // always last
}
const PAYLOAD_RE = /<pre[^>]*>\s*<code[^>]*>\s*routeflow-bridge\/v1 sha256=([0-9a-f]{64})\s*(?:<br\s*\/?>)?\s*([\s\S]*?)\s*<\/code>\s*<\/pre>/i;
// encode: json = JSON.stringify({ catalogue, status }); hash = sha256(json) hex;
// block = `<pre><code>${PAYLOAD_HEADER} sha256=${hash}\n${esc(json)}</code></pre>`
// decode: m = PAYLOAD_RE.exec(html); none -> problem "no-payload"; json = unesc(m[2]).trim();
// sha256(json) !== m[1] -> problem "corrupt"; JSON.parse failure -> "corrupt".
```

Human summary before the block (escaped, one `<p>` each): `${id} · severity ${sev} · ${ledgerState ?? "uncampaigned"}`,
`batch ${batch ?? "—"} · PR ${status?.pr ? "#" + status.pr : "—"}`, `location: ${location}`. The summary is NOT
read back on decode.

`encodeItem` returns `{ name, description_html, priority, stateName, external_source: EXTERNAL_SOURCE,
external_id: id }` (`EXTERNAL_SOURCE` from `./plane-client.mjs`). Unknown ledger state → `reg.noStatusState` plus a
`warnings` entry `unknown ledger state "<s>"` returned alongside (no console output from the codec).

`decodeItem` (spec §3.1): payload record P; `exp = encodeItem(P)`; `stateName = stateNameById.get(item.state)`;
edits, in this order, on a deep copy of P:
- `item.name !== exp.name` → `catalogue.title = item.name.startsWith(id + " · ") ? item.name.slice(id.length + 3) : item.name`; edit `"name"`.
- `item.priority !== exp.priority` and `SEVERITY_BY_PRIORITY[item.priority]` defined → `catalogue.severity`; edit `"priority"`.
- `stateName !== exp.stateName`: if `P.status === null` → warning `state edit not representable (no status row)`, no
  change; else `to = reg.ledgerByState[stateName]`; `to` null/undefined → no change (edit `"state-kept"`); else
  `status.state = to`; edit `"state"`.
Returns `{ id: item.external_id, record, payload: P, edits, warnings, problem: null }`.

`catalogueText`: records sorted by `Number(id.slice(1))`, `JSON.stringify(catalogue)` per line, `"\n"` after each
line (empty → `""`). `shardTexts`: group records with `status !== null` by `status.batch`, same sort and format.

### A4 `plane-bridge.mjs` CLI

`node scripts/campaign/plane-bridge.mjs <status|push|regen> [--registry bugs] [--apply] [--max-writes <n>]
[--limit <n>] [--check] [--present-only] [--out <dir>] [--accept-removals] [--json] [--help]`
- `--help`/`-h` (exit 0) and an unknown flag/verb (exit 2) handled first, before reading config, token or network;
  both print a `Usage:` banner.
- Registry dir: `process.env.PLANE_SYNC_REGISTRY_DIR || registryRoot()` (same as `plane-sync.mjs:1180`).
- Client: `createClient({ baseUrl: bridgeBaseUrl(cfg), slug: cfg.target.workspace, apiKey: token, tool:
  "plane-bridge", maxWrites })`. Wrap every caught error message with `scrub(msg)` replacing every occurrence of the
  token with `<redacted>` before printing.
- No token → `Plane bridge: skipped (no token file)` on stderr; exit 0, except `push --apply` and in-place `regen`
  → exit 2.
- Fetch: `resolveProject(identifier)` (null when absent), `listAll("projects/<id>/states/")`,
  `listAll("projects/<id>/work-items/")`. Items keyed by `external_id` where `external_source === EXTERNAL_SOURCE`;
  items without `external_id` are `unlinked`.
- Held: `scanForbidden(JSON.stringify(encodeItem(record).description_html + name))` per row (import `scanForbidden`,
  `loadDenylist` from the client); a hit → held, counted by pattern name only.
- `push`: plan per spec §3.3; order = project create, state creates, then item creates (numeric id order), then
  updates. Dry run (default) makes zero writes and prints:
  `Plane bridge push (dry run): project <create|exists> · states +N · create N · update N · noop N · pull-pending N · conflict N · held N · orphan N · needs --max-writes N`
  then up to 3 sample lines per non-zero create/update/conflict: `  create B12 · state Backlog · priority low · payload 812 B`
  (ids, state, priority, byte size only; never titles of held rows). `--json` prints the same as one JSON object
  (`{ project, statesToCreate:[names], counts:{...}, samples:{...}, heldByPattern:{...}, neededMaxWrites }`).
  `--apply`: POST `projects/` `{ name, identifier, network: 2 }` when absent; POST `projects/<id>/states/`
  `{ name, group, color }` per missing state; POST/PATCH items with `{ name, description_html, priority, state:
  <id>, external_source, external_id }`. A write returning `{ forbidden }` counts as held; `{ deferred }` counts as
  deferred and the summary says `deferred N (raise --max-writes)`. `--limit n` caps item writes. Exit 1 when any
  conflict or forbidden, else 0. Summary line prefix on apply: `Plane bridge push:`.
- `regen`: spec §3.4. Builds records from Plane (decode + edits); compares with `recordsFromRegistry` for
  `--check`; prints `Plane bridge regen --check: clean` or `Plane bridge regen --check: drift · catalogue <same|differs> · shards differ N · missing-in-plane N · held N · problems N · edited-in-plane N · unlinked N`
  plus up to 5 differing ids. `--present-only` restricts to ids present in Plane. `--out <dir>` writes
  `bugs.jsonl` and `status/<batch>.jsonl` (mkdir -p). In place: only when `owner === "plane"`, else exit 2 with
  `Plane bridge regen: refused — bugs is registry-owned (use --check or --out)`; when allowed, refuse (exit 1, zero
  writes) on problems, held, or missing-in-plane without `--accept-removals`; write `bugs.jsonl` and every shard
  whose text changed; never delete a shard file.
- `status`: one line per registry `bugs: owner registry · registry 1226 · plane 0 · held 19 · conflicts 0 · problems 0 · orphans 0 · unlinked 0`
  and `flip preconditions: <met|not met: held 19, regen drift>`.
- Ledger: call `appendRun({ tool: "plane-bridge", ... counters, exit })` like `plane-triage.mjs` does (read how it
  calls `appendRun`, mirror the field names).

### A5 `plane-fake-server.mjs` additive routes

- `POST projects/` → `{ id: uuidIds ? nextUuid() : "project-<identifier lowercased>", identifier, name, ...body }`,
  push to `projects`, register in `byId`, init `states[identifier]` to Plane's 5 defaults (Backlog/backlog,
  Todo/unstarted, In Progress/started, Done/completed, Cancelled/cancelled, ids `state-<identifier>-<n>`), and empty
  `labels/types/workItems/intake[identifier]`. 201.
- `POST projects/<id>/states/` → append `{ id, ...body }` to `states[identifier]`, 201.
- Document both in the header route list. Nothing else changes (existing behaviour of every route byte-identical).

### A6 `plane-bridge.self-test.mjs` — the T matrix (oracles are concrete)

Fixture registry (temp dir): 6 synthetic rows `B1..B6` with dummy text (`acme` placeholders): B1 queued (status row,
batch F01), B2 done (pr 12, proof text, batch F01), B3 no status row, B4 already-fixed (batch F02, extra keys
`roundSha`, `buildPlan`), B5 title of 300 chars, B6 symptom containing `<b>&"quote'</b>` and a `\u00a0`. Plus
`status/F00.jsonl` empty. Also a held row `B7` whose symptom carries `someone@example.com`.

| T# | R# | Given / When | Oracle |
| --- | --- | --- | --- |
| T1 | R1 | codec only: every record of `recordsFromRegistry(<real registryRoot()>)` → `encodeItem` → fake item → `decodeItem` | `sameRecord` true for all 1,226 (count printed); also for the fixture; skip-with-PASS line only if the real register is absent |
| T2 | R2 | fresh fake (no BUGS project), `push --apply --max-writes 100` (B7 held) then `regen --out <tmp2>` | `<tmp2>/bugs.jsonl` sha256 equals fixture `bugs.jsonl` minus the B7 line; each shard text equal; exit of push 1? — no: held is not an error on apply → exit 0; `regen --check` reports `held 1`, exit 0 |
| T3 | R3 | after T2, mutate fake state: B1 → state "In Progress", B2 priority → "urgent", B3 name → "B3 · renamed" | `regen --out`: B1 status.state `in-flight`, B2 severity `critical`, B3 title `renamed`; `push --apply` makes 0 POST/PATCH (pull-pending 3) |
| T4 | R4 | after T2, edit fixture B4 `title` locally | `push --apply`: exactly 1 PATCH, to B4's item; second `push --apply`: 0 writes |
| T5 | R5 | B1 edited in Plane (state) AND locally (title) | `push --apply` exit 1, `conflict 1`, 0 writes for B1 |
| T6 | R6 | B7 | never in any request body (scan `requests` for the email: 0 hits); stdout/stderr never contain it; `status` says `held 1` and `flip preconditions: not met` |
| T7 | R7 | fresh fake, `push` (no `--apply`) | 0 POST/PATCH in `requests`; line contains `project create`, `states +4`, `create 6`, `held 1`, `needs --max-writes 11` (1 project + 4 states + 6 items) |
| T8 | R8 | token file contains sentinel `tok-SENTINEL-123`; fake server 500s on one route (seed a failing route via a project id that 404s is fine) | sentinel absent from stdout, stderr, `PLANE_MACHINE_ROOT` files and `.plane-writes.jsonl`; missing token file → `skipped (no token file)` exit 0 for `push`, exit 2 for `push --apply` |
| T9 | R9 | after T2: (a) `regen --check` → exit 0 `clean` (B7 held, not drift); (b) corrupt one item's payload hash → exit 1 `problems 1`; (c) delete one item from fake → exit 1 `missing-in-plane 1` | exits and counts as stated |
| T10 | R10 | T2's requests | first write is `POST .../projects/`, then 4 `POST .../states/` (Ready for agent, Agent working, Needs approval, Blocked), then item POSTs whose `state` ids resolve to Backlog/Done/Backlog/Cancelled/… per the map |
| T11 | R11 | `regen` in place with owner registry (config override) | exit 2, message `refused — bugs is registry-owned`; registry files unchanged (sha256 before/after); with owner plane (temp config) and clean Plane: exit 0 and files byte-identical |
| T13 | R13 | `--help`, `--bogus`, `bogusverb` with NO config/token env | exit 0/2/2, `Usage:` printed, zero requests; literal scan: no `/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i` in the four new files |
| T14 | R14 | B3 (no status) state → "Done" in Plane; B1 state → "Blocked" | regen: B3 has no status row (warning printed), B1 keeps `queued` |
| T15 | R15 | fresh fake, `push --apply --max-writes 3` then `push --apply --max-writes 100` | first: 3 writes, `deferred` > 0; second: completes, total item POSTs across both = 6 (no duplicates) |

RED first: write the self-test before the CLI; run it once with `plane-bridge.mjs` absent and paste the FAIL lines;
then implement until GREEN. Also prove T2 can fail: temporarily make `encodeItem` drop `symptom`, see T1/T2 FAIL,
restore.

## Task B — plane-sync guard + golden-output test

Files (owned): `scripts/campaign/plane-sync.mjs` (guard only), `scripts/campaign/plane-golden.self-test.mjs`.
Satisfies R12, R16. Proven by T12, T16. Imports `bridgeClaimsTarget` from `./plane-bridge-config.mjs` (task A
creates it; interface in A2 — until it exists, test against a local stub you delete afterwards).

### B1 guard in `plane-sync.mjs`

At the one place plane-sync decides it may write (read `main()`; the branch guard R14 already turns writes into a dry
listing off master — reuse that exact mechanism): if `bridgeClaimsTarget(baseUrl, slug)` is true, behave exactly as
the off-branch dry path and add ONE extra stderr line `Plane mirror warn: target is owned by plane-bridge — no writes`
(the `Plane mirror warn:` prefix keeps Gate 5's `/^Plane mirror:/` relay untouched, `plane-sync.mjs:101-107`). For
every target the bridge does not claim, behaviour and output are byte-identical to base. Wrap the import so a broken
or missing bridge config can never throw (the helper already returns false).

### B2 `plane-golden.self-test.mjs` (SA-AIOS-01)

- `GOLDEN_BASE = "a587d034e7"` (named constant; comment: bump only with an SA ruling that allows an output change).
- Extract the base copy: `git archive <GOLDEN_BASE> scripts/campaign scripts/lib | tar -x -C <tmpBase>` (use
  `gitEnv()` from the client for the git call; if the sha is missing → one `PASS golden: SKIP (base <sha> not in this
  clone)` line, exit 0).
- For each case, run the BASE script (`<tmpBase>/scripts/campaign/<name>`) and the HEAD script with identical argv,
  env (`PLANE_SYNC_SELF_TEST=1`, own fresh `PLANE_MACHINE_ROOT`, `PLANE_SYNC_REGISTRY_DIR`/`BUGS_ROOT` pointing at an
  identical copy of one fixture registry, `PLANE_API_KEY=k`, `PLANE_BASE_URL=<fake url>`, same cwd = a temp git repo
  on a branch named `master` if a script needs git), each against its own fresh fake server started from the same
  seed. Compare stdout and stderr byte-for-byte and the exit code, after replacing ONLY `127.0.0.1:<port>` →
  `127.0.0.1:PORT` and the two temp-root paths → `<ROOT>`. If two BASE runs of a case differ from each other, add the
  smallest normalisation that makes them equal (name it in a `NORMALISE` list with a reason) — never more.
- Cases: `plane-sync.mjs --help`, `--dry-run`, `--check`, `--allow-branch` (real write path), `--allow-branch
  --check` after it; `plane-intake.mjs --help`, list, `--json`; `plane-triage.mjs --help`, `--brief`, `--json`;
  `plane-apply.mjs --help`, `<ops.json> --dry-run`, `<ops.json>` (one state move op on a seeded item);
  `plane-doctor.mjs --help`, `--offline`, `--offline --json`; `plane-retro.mjs --help`, `--json`. Seed the fake with
  a BUGS project and states named the way the base scripts expect (read `plane-sync.self-test.mjs` for its seed
  helper and reuse its shape), plus 3 fixture registry rows.
- Red-first proof (T16): run once with a deliberate one-byte change to a HEAD copy's output (e.g. env
  `PLANE_GOLDEN_SELF_PROBE=1` makes the harness append one space to HEAD stdout before comparing) and assert the case
  FAILs; that probe case must itself be a PASS line ("probe caught a 1-byte change").
- T12: start a fake; set `PLANE_BRIDGE_CONFIG` (self-test) to a temp config whose `target.baseUrl` is the fake's url
  and workspace the slug plane-sync uses; run HEAD `plane-sync.mjs --allow-branch` → 0 POST/PATCH in `requests` and
  the warn line present; run BASE the same way → N > 0 writes (shows the guard is red on master). Without the
  override (unclaimed target) HEAD output equals BASE (already covered by the cases above).

## Verification commands

- perRound: `node --check <each new/changed .mjs>`; `node scripts/campaign/plane-bridge.self-test.mjs`;
  `node scripts/campaign/plane-golden.self-test.mjs`.
- final (lead's slot, not builders): the existing `plane-*.self-test.mjs` files + `npm run verify` with
  `JEST_MAX_WORKERS=4`.

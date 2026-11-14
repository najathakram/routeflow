# Spec — RouteFlow ↔ Plane bridge (AI OS plan step 2.2)

Status: IMPLEMENTED at c7de5569f2 (SA-AIOS-04 approved; live seed 2026-11-14 under SA-AIOS-16 + lead go: 1,209 items, 17 held, regen --check clean) · 2026-11-14 · base `a587d034e7` · branch `claude/aios-2-2-plane-bridge-89534b`
Lane: light-loop (standard) via dev-pipeline:lean. Opus plans and reviews; Sonnet builds.

## 1. Why

AI OS ADR-022 (`C:\ClaudeCode\AI_OS\DECISIONS.md`, ADR-017 status line: "Plane owns RouteFlow tasks; RouteFlow's Plane
sync scripts are the bridge") makes the owner's local Plane CE (`http://localhost:7090`, workspace `routeflow`) the
system of record for RouteFlow tasks, so Hermes, the dashboard and the phone see the same task state the lanes use.
Today the direction is the reverse: `scripts/campaign/plane-sync.mjs:7-13` says "The registry is the source of truth;
Plane never writes back", and it mirrors to Plane **Cloud** (`plane-client.mjs:67` default `https://api.plane.so`).
Plan step 2.2 acceptance (`AI_OS/IMPLEMENTATION_PLAN.md:67`): "Registries regenerate from Plane; PR via RouteFlow's
pipeline".

If we ship nothing: the AI OS task board has no RouteFlow tasks, and every RouteFlow task keeps living only in git
files that Hermes and the dashboard cannot read or change.

Success signal: `npm run plane:bridge -- regen --check` exits 0 against a Plane seeded by the bridge, meaning every
registry file regenerated from Plane is byte-identical to the tracked file. Baseline today: there is no regen path
at all (no script reads Plane into the registry except `plane-intake.mjs`, which mints new rows only).

## 2. What exists (facts at `a587d034e7`, or live reads on 2026-11-14)

Registries the `plane-*` scripts read or write today:

| Registry | Path | Size | Read by | Written by |
| --- | --- | --- | --- | --- |
| Bug catalogue | `.claude/campaign/bugs.jsonl` | 1,226 rows, sorted by id, one canonical `JSON.stringify` line each (measured) | `plane-sync.mjs:128` `readCatalogue` | `bugs.mjs` (`file`, `import`, `tag`, `move`, `enrich`…), `plane-intake.mjs --apply` via `bugs.mjs file` |
| Bug status ledger | `.claude/campaign/status/F##.jsonl` | 65 shards, 699 rows, one row per id (compacted; latest-row-wins `plane-sync.mjs:141-153`), 2 empty shards (`F00`, `F01`, content `""`) | `plane-sync.mjs:141` | `bugs.mjs` (`prove`, `close`, `claim`, `release`, `tier`, `reopen`, `already-fixed`, `discharge`…) |
| Batch board | `.claude/campaign/board.json` | batch → GitHub issue number | `plane-sync.mjs:155` (description line only) | `bugs.mjs` |
| Bug records | `.claude/campaign/bugs/B###.md` | 1,226 files, 2.8 MB prose; front matter regenerated from the JSONL by `bugs.mjs` (`:1572`) | not read by `plane-*` | `bugs.mjs`, humans |
| Ops files | `local-assets/plane/ops/*.json` | inputs, gitignored | `plane-apply.mjs` | humans |
| Runs/writes ledgers | `local-assets/plane/runs.jsonl`, `.claude/campaign/.plane-writes.jsonl` | telemetry | `plane-doctor`, `plane-retro` | every `plane-*` |

Not touched by any `plane-*` script, but named a task registry by ADR-017: `.claude/roadmap/{features,releases,deferred}.jsonl`
(26 + 7 + 34 rows), rendered by `scripts/roadmap/render.mjs`.

Live local Plane CE (read-only GETs, 2026-11-14, token read from `%USERPROFILE%\.aios\plane-token-routeflow`):
- `GET users/me/` 200 → the workspace agent user `agent-routeflow`.
- `GET workspaces/routeflow/projects/` → 1 project, identifier `ROUTE` (Plane's demo project, 7 demo items). **No `BUGS` project.**
- `ROUTE` states: Backlog, Todo, In Progress, Done, Cancelled + the AI OS states Ready for agent, Agent working, Needs approval, Blocked.
- The CE list response carries `description_html` and **no `description_stripped`** (keys measured). `plane-sync.mjs`'s
  diff reads `registry-hash` out of `description_stripped`, so plane-sync pointed at CE would rewrite every item every
  run. The bridge reads `description_html` only.
- Denylist census (`plane-client.mjs` `scanForbidden` over each row's catalogue line + status line): **17 of 1,226 rows
  trip a pattern** (live dry run: tenant-uuid 9, email 5, invoice-number 2, connection-string 1; an earlier census that
  also scanned `bugs/*.md` prose counted 19). Those rows
  cannot be stored in Plane losslessly.
- Longest title 310 chars; Plane's `name` limit is 255.

## 3. Decision (the shape)

Plane becomes the owner of the **task state** of each registry; the git files become a **generated view**. Ownership
moves per registry through a tracked switch, the same dark → enforced pattern the repo uses for gates:

- `scripts/campaign/plane-bridge.json` (new, tracked): the target (base URL, workspace, token file) and, per registry,
  `owner: "registry" | "plane"`, the project, the state set and both state maps. Ships with `bugs.owner = "registry"`.
- `scripts/campaign/plane-bridge-codec.mjs` (new, pure): registry row ↔ Plane work item. Lossless: the full catalogue
  row + status row ride in a hashed payload block in `description_html`; Plane-native fields (`name`, `state`,
  `priority`) are derived from the payload, and a human edit to one of them in Plane **wins** on decode.
- `scripts/campaign/plane-bridge.mjs` (new CLI, `npm run plane:bridge`): `status`, `push`, `regen`. Built on
  `plane-client.mjs` (the one HTTP client, denylist, budget, ledger) and tested on `plane-fake-server.mjs`.
- `plane-sync.mjs` gets one guard: it makes zero writes to a target the bridge config claims. No other change to any
  existing `plane-*` CLI or behaviour (lead rule 3).

Flipping `bugs.owner` to `"plane"` is a **separate, owner-approved diff** after the live seed proves round-trip
(`status` prints the preconditions). This change ships the bridge with ownership still on the registry side, so the
fleet sees no behaviour change on merge.

### 3.1 Codec (`plane-bridge-codec.mjs`)

- `encodeItem(record, cfg)` → `{ name, description_html, priority, stateName, external_source, external_id }`.
  - `record = { catalogue, status }` (status may be `null`: a filed row never campaigned).
  - `name` = `` `${id} · ${title}` `` cut to `NAME_MAX = 255`.
  - `priority` = `PRIORITY_BY_SEVERITY` (imported from `plane-sync.mjs:93`).
  - `stateName` = `cfg.stateByLedger[status.state]`, or `cfg.noStatusState` when `status` is null.
  - `external_source` = `EXTERNAL_SOURCE` (`plane-client.mjs:100`), `external_id` = id.
  - `description_html` = the payload block only (amended, review round 1: no bridge-written summary, it would go
    stale): `<pre><code>routeflow-bridge/v1 sha256=<64 hex>` + newline + `JSON.stringify({catalogue, status})`
    `</code></pre>`, the JSON HTML-escaped (`& < > " '`).
- `decodeItem(item, stateNameById, cfg)` → `{ record, edits[], problem }`:
  - Payload found by a tolerant regex (`<pre[^>]*>\s*<code[^>]*>`, header, then whitespace or `<br>`), entities
    unescaped (named `&lt; &gt; &quot; &#39; &#x27; &apos; &nbsp;`, numeric `&#N;`/`&#xH;`, `&amp;` last), the sha256
    of the JSON text checked. No payload → `problem: "no-payload"`; hash mismatch → `problem: "corrupt"`.
  - Native edits: `expected = encodeItem(payloadRecord)`. For each of `name`, `stateName`, `priority`: equal to
    `expected` → no edit. Otherwise:
    - `name` → `catalogue.title` = name minus a leading `` `${id} · ` ``.
    - `priority` → `catalogue.severity` = `SEVERITY_BY_PRIORITY` (urgent→critical, high, medium, low, none).
    - `stateName` → if `status` is null: edit **not representable** (warn, keep payload). Else `cfg.ledgerByState[name]`;
      `null` or unknown (e.g. `Blocked`) keeps the payload state.
- Canonical text: `catalogueText(records)` = rows sorted by numeric id, one `JSON.stringify` line each, trailing `\n`;
  `shardTexts(records)` = `{ F##: text }` grouped by `status.batch`, sorted by numeric id. A shard with no rows is `""`
  and a missing shard compares equal to `""` (keeps `F00`/`F01`).
- **Amendment (build round 1, measured):** 10 of the 65 live shards are in append order, not id order. Every reader
  folds a shard latest-row-wins (`plane-sync.mjs:141-153`) and each shard holds one row per id, so line order carries
  no meaning. `regen --check` therefore compares each shard as an order-insensitive multiset of lines and reports
  order-only differences as information, never as drift; `bugs.jsonl` stays byte-exact. In-place `regen` (only after
  the flip) writes shards sorted, a one-time normalisation of those 10 shards.

### 3.2 State map (bugs, local CE)

| Ledger state | Plane state (group) | Reverse (Plane → ledger) |
| --- | --- | --- |
| `queued` | Backlog (backlog) | Backlog → `queued` |
| `regressed` | Todo (unstarted) | Todo → `queued` |
| `in-flight` | In Progress (started) | In Progress → `in-flight` |
| `proven`, `proven-pending-deploy` | Needs approval (started) | Needs approval → `proven` |
| `done` | Done (completed) | Done → `done` |
| `refuted`, `already-fixed`, `cancelled` | Cancelled (cancelled) | Cancelled → `cancelled` |
| no status row | Backlog | — |
| — | Ready for agent (unstarted) | → `queued` |
| — | Agent working (started) | → `in-flight` |
| — | Blocked (started) | `null` = keep payload state |

The state set is the AI OS workflow (`ROUTE` project's live states), so Hermes's "Needs approval" contract holds.
Unknown ledger state → Backlog with a warn (same rule as `plane-sync.mjs:110-115`, L-081).

### 3.3 `push` (registry → Plane)

Default is a dry run; `--apply` writes. Per registry row `L` (decoded Plane item `R`, its payload `P`):

| Case | Action |
| --- | --- |
| row trips the denylist | **held** (never sent; counted by pattern name, never printed) |
| no Plane item with `external_id = id` | **create** |
| `L == R` | noop |
| `R`'s natives equal `encode(P)` (no Plane edit) and `L != P` | **update** (PATCH the encoded item) |
| Plane edit pending and `L == P` | noop, `pull-pending` (regen takes the edit) |
| Plane edit pending and `L != P` | **conflict** → row refused, exit 1, zero writes for it |
| item has no payload or a corrupt one | **conflict** (`no-payload` / `corrupt`) |
| Plane item whose `external_id` is not in the registry | **orphan**, reported, never deleted |

**Amendment (review round 1, Opus FAIL findings 2, 3, 7 — supersedes the "Plane edit pending" rows above):**
field-level merge. A conflict is only the same native field (`name`, `state`, `priority`) changed on both sides to
different values (names compared after NFC + whitespace normalisation). `L == R != P` → **rebaseline** (PATCH the
payload only). `L == P != R` → pull-pending. Otherwise **update**: PATCH the payload plus only the natives the local
side changed, so a Plane-only value (`Blocked`, a state on a no-status row) is never overwritten. The bridge owns only
the payload block in `description_html`: create writes the block alone, update splices it and keeps every byte
outside it (human notes survive). Two items with one `external_id` → problem `duplicate`, never written. A status
row without a batch → problem `no-batch`. `regen --out` refuses the registry dir or a non-empty dir.

Before item writes: create the `BUGS` project when missing (`POST projects/`), then each configured state the project
lacks (`POST projects/<id>/states/`). Budget: `--max-writes <n>` (default `BRIDGE_DEFAULT_MAX_WRITES = 25`); the dry
run prints the `--max-writes` the full plan needs. `--limit <n>` applies only the first `n` item writes (canary).
Idempotency key: `external_source` + `external_id`; a re-run after a partial apply creates nothing twice.

### 3.4 `regen` (Plane → registry files)

Reads every item in the project (`listAll`), decodes, applies native edits, renders canonical text.
- `--check`: compares with the tracked files. Exit 1 on any difference, `problem` item, or registry row missing from
  Plane (held rows are reported, not counted as drift). `--present-only` compares only ids present in Plane (canary).
- `--out <dir>`: writes `bugs.jsonl` + `status/*.jsonl` there.
- in place (no flag): allowed only when `owner = "plane"`; refused with zero writes if any item has a `problem`, any
  registry row is missing from Plane (unless `--accept-removals`), or any row is held. Never deletes a shard file.
- Unlinked Plane items (no `external_id`) are reported as `unlinked (plane:intake files them)`.

### 3.5 `status`

Prints owner per registry, counts (registry rows, Plane items, held, conflicts, problems, orphans, unlinked) and the
flip preconditions: `held = 0`, `conflicts = 0`, `problems = 0`, `regen --check` clean.

### 3.6 Token and target

The bridge reads the target from `plane-bridge.json` and the token from `target.tokenFile` (`~` expands to
`os.homedir()`), and passes it to `createClient({ apiKey })` only. It never reads `PLANE_API_KEY` (that key is the
Cloud mirror's). Test-only overrides `PLANE_BRIDGE_TOKEN_FILE`, `PLANE_BRIDGE_BASE_URL` and `PLANE_BRIDGE_CONFIG` are
honoured only under `PLANE_SYNC_SELF_TEST=1` (house rule, `plane-client.mjs:51-66`). Error text from the client is
scrubbed of the token before printing. Missing token file → one `Plane bridge: skipped (no token file)` line, exit 0
for `status`/dry runs/`--check`; exit 2 for `push --apply` and in-place `regen`.

## 4. Requirements

| R# | Priority | Requirement | Verified by |
| --- | --- | --- | --- |
| R1 | P0 | Codec round-trips every row of the live register losslessly (encode → decode = input) | T1 |
| R2 | P0 | `push --apply` to an empty Plane then `regen --out` reproduces `bugs.jsonl` and every shard byte-for-byte | T2 |
| R3 | P0 | A Plane edit to state, priority or name shows up in regen; `push` does not overwrite it | T3 |
| R4 | P0 | A local edit pushes as exactly one PATCH; a second `push` makes zero writes | T4 |
| R5 | P0 | Both sides edited → conflict, exit 1, zero writes for that row | T5 |
| R6 | P0 | Denylisted rows are held: never sent, never printed, counted; flip preconditions fail while any are held | T6 |
| R7 | P0 | Dry run (default) makes zero POST/PATCH, and reports creates/updates/held/conflicts/project/states and the needed `--max-writes` | T7 |
| R8 | P0 | The token never appears in stdout, stderr, the ledgers or a thrown message; missing token file skips | T8 |
| R9 | P1 | `regen --check` exits 0 when clean, 1 on drift, on a corrupt payload, or on a row missing from Plane | T9 |
| R10 | P1 | Missing project and states are created on `--apply` (after them, items land in the right state) | T10 |
| R11 | P1 | In-place `regen` refuses while `owner = "registry"` | T11 |
| R12 | P1 | `plane-sync.mjs` makes zero writes to a bridge-claimed target; unchanged otherwise | T12 |
| R13 | P1 | `--help` / unknown flag handled before any env/file/network read; no uuid literal in new files | T13 |
| R14 | P2 | A state edit on a row with no status row warns and keeps the payload; `Blocked` keeps the payload state | T14 |
| R15 | P2 | `--max-writes` defers the rest; `--limit` caps item writes; a re-run continues without duplicates | T15 |
| R16 | P0 | SA-AIOS-01: every existing `plane-*` command's output against `plane-fake-server.mjs` is byte-identical to its output at base `a587d034e7` (golden self-test that runs the base copy, extracted with `git archive`, and HEAD side by side; red-first by changing one byte) | T16 |

Non-goals: flipping `bugs.owner` to `plane` (separate owner-approved diff); redirecting `bugs.mjs` writers or Gate 5
(flip diff); records `bugs/*.md` prose (stays git-owned evidence, linked by id); `board.json` (batch → GitHub issue
map, not task state); roadmap registries (LATER, §G8); minting ids for items humans file in Plane (stays
`plane-intake.mjs`); labels, cycles, modules; Plane Cloud (untouched).

Deploy day: tooling only, nothing in `apps/`; no Railway effect; `owner = "registry"`, so no fleet behaviour changes.
Rollback: revert the commit; Plane items created by a seed are archived in the UI or left (they carry
`external_source = routeflow-registry`, so a filter finds them all).

## Design Gate (Full) — 2026-11-14-plane-bridge · 2026-11-14 · base a587d034e7

### G1 Fit
- Program / train: AI OS plan step 2.2 (`AI_OS/IMPLEMENTATION_PLAN.md:67`), ADR-022; RouteFlow side has no WORK-PLAN train for it (an AI OS step run in a RouteFlow worktree, owner yes 2026-11-14).
- Exists today: `plane-client.mjs:459` `createClient` (HTTP, retry, 50/min ceiling, denylist, budget, ledger); `plane-sync.mjs:78` `STATE_BY_LEDGER`, `:93` `PRIORITY_BY_SEVERITY`, `:128-153` registry readers; `plane-fake-server.mjs` (test Plane); `registry-root.mjs` `registryRoot()`.
- Decision: extend — the bridge imports the client, the maps and the fake server; one new pure codec and one CLI. One source of truth per registry, chosen by `plane-bridge.json` `owner`.
- Facts: every writer of the registry fields the codec carries is `bugs.mjs` (commands at `bugs.mjs:338-9266`) plus `plane-intake.mjs --apply` (spawns `bugs.mjs file`); CE list shape measured live (no `description_stripped`); 17/1,226 denylist rows measured (live dry run); title max 310 measured; shards compacted (max 1 row per id) measured.

### Area sweep
| Source | Query run | Open ids in this area | Fixed here (own commit + red test) | Deferred (row + reason) |
| --- | --- | --- | --- | --- |
| Bug registry | `grep -i '"register":"open"' .claude/campaign/bugs.jsonl \| grep -i plane` | B447, B933 | none | B447 (plane-doctor flake under load; another file, not the bridge's path); B933 (denylist misses Stripe-shaped keys; shared fleet behaviour, SA question Q1) |
| Tracker issues | n/a: no tracker query for Plane tooling; the AI OS plan row is the tracker | — | — | — |
| ACTION-ITEMS | `grep -n -i plane .claude/handoffs/ACTION-ITEMS.md` | none | — | — |
| Review nits | `ls .claude/pipeline \| grep -i plane` (prior plane runs' reviews) | none open | — | — |
- Chunk: one area (`scripts/campaign/plane-*`), 0 bug fixes, about 900 changed lines including tests; no split.

### G2 Variation map
| Axis | How it differs there (one line) | Mark | Seam in this change (SEAM NOW only) |
| --- | --- | --- | --- |
| Wholesaler / distributor | n/a: internal task tooling, no tenant-facing behaviour | LATER | — |
| Jobber | n/a: internal task tooling | LATER | — |
| Retail POS counter | n/a: internal task tooling | LATER | — |
| Delivery / route | n/a: internal task tooling | LATER | — |
| Mixed | n/a: internal task tooling | LATER | — |
| Super admin | n/a: no app surface | LATER | — |
| Single store / 1 user | one owner, one Plane workspace (today's case) | BUILD NOW | — |
| Small team | more Plane users editing items; native-field edits win on decode, conflicts refused | BUILD NOW | — |
| Multi-branch / multi-warehouse | other registries (roadmap) and other businesses' workspaces | SEAM NOW | `plane-bridge.json` `registries.<name>` + `target` per workspace |
| High volume | 1,226 rows today; thousands later | BUILD NOW | paginated `listAll`, one write per changed row, budgeted |
- Surfaces & roles: no app surface; operators are the owner (Plane UI), Hermes (Plane MCP), lanes (`npm run plane:bridge`).
- Capability read: `plane-bridge.json` `owner` per registry; never a hostname or a slug in code.
- Dark launch: `bugs.owner = "registry"` ships; the flip to `"plane"` is its own owner-approved diff after `status` shows every precondition green.

### G3 Replace-later
| Planned program touching this area | Would it replace or rework this? | Answer |
| --- | --- | --- |
| B1-c registry move to `routeflow-specs` clone (`registry-root.mjs` `REGISTRY_MODE`) | changes where the files live | no conflict: the bridge reads/writes through `registryRoot()` only |
| AI OS Hermes / dashboard on Plane (ARCHITECTURE.md §4) | consumes Plane | final shape now: AI OS workflow states, `external_id` keys |
| Ownership flip + `bugs.mjs`/Gate 5 redirect (follow-up) | builds on this | seam now: `push` is the path every local edit takes after the flip |
- Interim: none. `owner = "registry"` is the dark state of the final shape, not a temporary design.

### G4 Class, not instance
- Class: every conversion between a registry row and a Plane work item.
- Inventory: `git grep -n "description_html\|external_id" scripts/campaign/plane-bridge*.mjs` — all in `plane-bridge-codec.mjs`; the CLI calls `encodeItem`/`decodeItem` only.
- One helper: `plane-bridge-codec.mjs` (`encodeItem`, `decodeItem`, `catalogueText`, `shardTexts`).
- Pin: T1 runs the codec over every live register row (fails on any lossy field); the self-test greps `plane-bridge.mjs` for `description_html` construction outside the codec.
- Red-first: T1/T2 on master — no codec/CLI exists (module not found is not red), so the first red is T2's oracle: regenerated `bugs.jsonl` sha256 equals the fixture's; observed before implementation with a stub codec that drops `symptom` → mismatch. T12 is red on master: plane-sync against a fake server whose base URL the bridge config claims makes N > 0 POSTs today, 0 after.

### G5 Data & time
- Schema: none (no Prisma change).
- Snapshot vs live: the payload is a snapshot of the row as last pushed; Plane natives are live and win on decode.
- Authority & time: Plane is read once per run; `push` decides per row from that one read; a concurrent Plane edit between read and PATCH is the only race (single owner + agent; accepted, and the next `regen --check` shows it). Re-runs are idempotent by `external_id`.
- Old shape → new: existing rows as-is (canonical JSON, measured); 17 held rows block the flip until redacted or ruled on (Q2); Plane items without a payload are conflicts, never overwritten.
- Money: n/a: no money math.

### G6 Scale
- Queries: `listAll` paginates `work-items/` (`per_page` 100 → 13 GETs for 1,226); one PATCH per changed row; no per-row GET.
- Limits: `NAME_MAX = 255`, `BRIDGE_DEFAULT_MAX_WRITES = 25`; rate from the client's `clientRatePerMin` knob (50/min: a full seed of ~1,212 writes takes about 25 min).
- UI at 10 and 10,000: n/a: no UI; Plane's own UI lists and filters.

### G7 UX lens
- Flow: n/a for app UI. CLI: one verb per job (`status`, `push`, `regen`), dry by default, one summary line plus counts.
- Feature parity: every existing `plane:*` npm script and flag unchanged; `plane:bridge` added.
- Placement sign-off: n/a: no screen.

### G8 Change-friendliness
- Config over code: `plane-bridge.json` holds target, owner, project, states and maps; a new registry or workspace is a config row plus an adapter.
- Shared contract: n/a: no API DTOs; the payload header `routeflow-bridge/v1` versions the wire shape.
- Flags: `owner` per registry; removed when every registry is `plane`-owned and `plane-sync.mjs` is retired.
- Code map: `.claude/code-map/` scripts/campaign area entry for `plane-bridge*.mjs` (docs-only follow-up PR).
- Future requirement → expected diff size:
  - roadmap registries Plane-owned → S (an adapter for `features/releases/deferred` + a config row)
  - ownership flip for bugs → XS config + S hook (`push` then `regen` on master in Gate 5)
  - another business's workspace → XS (a `target` entry)
  - mint ids for human-filed Plane items in the bridge → S

### G9 Cost & stop
- Quick fix: pointing `plane-sync.mjs` at local CE would mirror one way only, rewrite every item every run (no `description_stripped` on CE) and could never regenerate the registry; the bridge is the shape ADR-022 asks for.
- YAGNI: cut labels/modules/cycles, records prose, roadmap adapter, id minting, a second denylist.
- Review-round signal: n/a: first round.

### G10 Owner questions
- Q1 (SA): fix B933 (stricter `api-key-ish` pattern + `whsec_`) in the shared denylist now, own commit and red test? Recommend yes, but only with the RouteFlow SA's clearance since it changes the fleet's mirror; otherwise defer.
- Q2 (SA): the 17 held rows (19 in the first census, which also scanned record prose) (registry text carries emails, uuids, an invoice number, a connection-string prefix). Recommend: they stay registry-owned and block the flip; redacting them is a separate registry chore before the flip.
- Q3 (SA): project for bugs on local CE: a new `BUGS` project (recommended: matches the house identifiers and keeps the demo `ROUTE` project apart) vs items in `ROUTE`.

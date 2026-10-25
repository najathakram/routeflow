# Spec: Routeflow Development Control System (slice 1)

> **Stage P4 — "what".** Authored 2026-09-30 by Fable 5.1. Status: `DRAFT` (revised for owner
> rounds 2-3: Railway hosting, `ctl/state` branch, inference-first, PR ledger + waste panel).
> Evidence `E#` / assumptions `A#`: [discovery.md](./discovery.md) §0. Every `R#` carries a
> priority and a `T#` in [test-plan.md](./test-plan.md). Slices 2-3 are deferral rows only (§10).

---

## 0. Shape in one paragraph

`apps/control` is a small TypeScript Node service (no framework, no React) deployed as its own
Railway service. It **reads** three sources with zero model tokens: (1) the curated registers on
`master` (roadmap JSONL, `bugs.jsonl`, `status/*.jsonl`) through a fetch-only deploy key; (2) the
orphan branch **`ctl/state`** where lanes and the dashboard append one-line events; (3) GitHub
(PRs, branches, checks) and Railway (deployments). It **folds** them into one deterministic state,
**renders** a self-contained HTML command center, pushes updates to open browsers over **SSE**,
and accepts owner **write-back** that becomes new events on `ctl/state`. Lanes touch it only
through `npm run ctl -- …` (one line appended + pushed, ≤ 150 tokens) and `npm run ctl -- next`
(≤ 30 lines). Nothing in the loop is an LLM. `npm run control` runs the same server locally
against the local checkout.

## 1. Data on `ctl/state` (orphan branch, append-only, server- and `ctl`-written)

```
events/<lane>.jsonl          # current segment per lane (append-only; seq monotonic per lane forever)
snapshot.json                # folded state at the last compaction: { at, sha, seqByLane, tasks, lanes, releases, acks }
derived/prs.jsonl            # PR ledger, server-only writer, one row per PR per state change (§5.5)
derived/waste-acks.jsonl     # (owner acks are ordinary events; this file is a derived index only)
README.md                    # 30 lines: what this branch is, never edit by hand
```
Archived segments go to **`ctl/archive`** (`archive/<lane>/<from-seq>-<to-seq>.jsonl`), fetched only
by history views (slice 2). The `ctl/state` tip tree therefore stays ≤ ~512 KB (R32) so every
`git fetch --depth=1` is small. Retention: forever (archive branch), never rewritten.

`master` keeps: `.claude/roadmap/*`, `.claude/campaign/*` (unchanged, R3) and a new
`.claude/control/README.md` (the rule text, §8, and the schema pointer). **No tasks.jsonl or
lanes.json on master**: tasks and lanes are created by events (§1.3) so that everything the control
system owns has exactly one home.

### 1.1 Lane (folded from `lane.registered` events on `events/lead.jsonl` or `events/owner.jsonl`)

`{ id, name, machine, kind, active }` — `id` `^[a-z0-9][a-z0-9-]{1,23}$` (doubles as the events
file name; path-safe on Windows and POSIX); `kind ∈ feature|bug|test|investigation|release-prep|
lead|sa|coordinator|owner`. Seed (A5, Q2): `lead, sa, coordinator, f2, lane-u, lane-b, r-ui,
s-scan, owner`. Only `lead`, `coordinator` and `owner` may emit `lane.registered`/`task.created`.

### 1.2 Task (folded; `RF-n` rows come from `task.created`; `F-`, `B`, `D-` rows from adapters §3)

```jsonc
{ "id": "RF-231", "title": "Invoice PDF: right-align dates", "kind": "feature",
  "status": "planned", "priority": "P2", "importance": 3, "customerImpact": "low", "effort": "S",
  "release": "R1.1c", "areas": ["apps/api/src/invoices/**", "apps/web/app/(dashboard)/invoices/**"],
  "dependsOn": [], "related": ["B905"], "lane": null, "phase": null,
  "ref": { "feature": "F-05", "bug": null, "issue": 2775, "deferred": null }, "notes": "SA-442" }
```

| Field | Rule |
|---|---|
| `id` | `^(RF-\d+|F-\d+|B\d+|D-\d+)$`; `RF-n` minted only by `lead`/`owner` `task.created` (§5.3) |
| `kind` | `feature \| bug \| chore \| investigation \| release-prep \| customization \| deferred` |
| `status` | §2 |
| `priority` | `P0..P3`; default from severity for bugs (critical→P0, high→P1, medium→P2, low→P3, WORKFLOW matrix E21), `P2` for features |
| `importance` 1-5 · `customerImpact` `none\|low\|high` · `effort` `S\|M\|L` | optional; defaults `3`, `none`, `M` |
| `release` | must exist in `releases.jsonl` (+ `release.created` events) or be `null` |
| `areas` | globs `^[A-Za-z0-9_./()\[\]*?-]+$`, forward slashes, no `..`, ≤ 200 chars; `[]` = unknown |
| `dependsOn`/`related` | ids resolving after adapters; dangling → validation error |
| `phase` | `idea\|requirements\|design\|phase1\|phase2\|testing\|qa\|rc\|released\|null` |

### 1.3 Event (one line of `events/<lane>.jsonl`)

```jsonc
{ "seq": 12, "ts": "2026-09-30T12:04:00Z", "lane": "lane-u", "type": "task.started",
  "task": "RF-231", "by": "agent", "sha": "abc1234", "note": "" }
```
`seq` = previous + 1 within the lane (continues across compaction; segment header line
`{"seq":0,"type":"segment","from":<n>}` is the only `seq 0` allowed); `ts` ISO UTC,
non-decreasing per lane; `lane` = file name; `by ∈ agent|owner|ctl|sync|server`; ≤ 1,024 bytes
per line; **no key other than the type's declared payload** (extra keys fail).

| type | payload | fold effect |
|---|---|---|
| `lane.registered` | `laneId, name, machine, kind, active` | upsert lane (lead/owner/coordinator only) |
| `task.created` | `id (RF-n), title, kind, priority?, release?, areas?, effort?, importance?, customerImpact?, dependsOn?, related?, ref?, notes?` | create task, status `planned` (lead/owner only) |
| `task.proposed` | `tmpId (^<lane>\.\d+$), title, kind, areas[], priority?` | provisional task, status `proposed` |
| `task.adopted` | `tmpId, task (RF-n)` | alias tmpId → task (lead/owner only) |
| `task.started` | `task` | task.lane = lane; status `in-progress`; lane.current = task |
| `task.progress` | `task, phase` | task.phase |
| `task.blocked` | `task, reason` | status `blocked` (remembers prior) |
| `task.unblocked` | `task` | back to prior status |
| `task.done` | `task, pr?` | status `code-complete` (reported); lane.current cleared |
| `task.released` | `task, release, sha` | status `released` (sync/server or lead) |
| `task.reopened` | `task, reason` | status `planned`; lane cleared |
| `task.priority` | `task, priority, prev` | override; `prev` enables compensating undo |
| `task.release` | `task, release, prev, why?` | override + plan-change history |
| `task.lane` | `task, lane (or null)` | assignment override (owner/lead) |
| `task.next` | `task (or null), targetLane?` | lane-level next pointer (own lane, or owner with `targetLane`) |
| `task.reconsider` | `task, why` | status `reconsider` |
| `task.areas` | `task, areas[]` | override areas |
| `task.dropped` | `task, why` | status `dropped` (lead/owner only) |
| `bug.filed` | `bug (B\d+), task?` | link bug ↔ task |
| `bug.fixed` | `bug, pr` | bug task → `code-complete` |
| `release.created` | `id, name, shipDate, goal?` | new release (lead/owner) |
| `release.moved` | `release, shipDate, prev, why` | date override + history |
| `release.shipped` | `release, sha` | status `shipped`; its `code-complete` tasks → `released` |
| `pr.superseded` | `pr, by (pr number or task id), why?` | waste rule W5 satisfied for `pr` |
| `waste.ack` | `key, until? (ISO date), why?` | suppress the waste item `key` (§5.8) until `until` or until its subject's head sha changes |
| `lane.note` | `note` | timeline only |

**Denylist**: every line is scanned before append against `scripts/campaign/plane-denylist.json`
(E52) plus `^https?://` in `note`; a hit is refused (exit 4 / HTTP 422), never written (R29).

## 2. Status enum and legal transitions

`proposed → planned → in-progress → code-complete → released`; side states `blocked`,
`reconsider`, `dropped`. Matrix (✓ legal, ✗ refused by `ctl` exit 3 / server 409, and a
`warning` in the fold when found in history):

| from \ event | started | done | released | blocked | unblocked | reconsider | reopened | dropped |
|---|---|---|---|---|---|---|---|---|
| proposed | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| planned | ✓ | ✗ | ✓ (inferred only) | ✓ | ✗ | ✓ | – | ✓ |
| in-progress | ✓ same lane (idempotent) | ✓ | ✓ (inferred only) | ✓ | ✗ | ✓ | ✓ | ✓ |
| blocked | ✗ | ✗ | ✗ | ✓ (reason update) | ✓ | ✓ | ✓ | ✓ |
| code-complete | ✗ | ✓ (pr update) | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| released | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| reconsider | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |

Adapter rows map: bug `open` → `planned`; `Fixed · #n` → `code-complete` (pr n) — `released`
once the merge sha is deployed (§5.7); Cleared/Refuted/Duplicate/Already → `dropped`; feature
`done` → `released`, `in-progress|at-risk` → `in-progress`, `planned` → `planned`; deferred
open → `reconsider`, closed → `dropped`.

## 3. Read-through adapters (no rewrite of existing registers) — as before

`featuresAsTasks`, `bugsAsTasks` (areas from `location` path tokens, regex
`/(apps|packages|scripts)\/[A-Za-z0-9_.\/()\[\]-]+/g`, `:line` and `(~n)` stripped, bare
directory → `/**`; `sensitive`/`sensitiveFor` carried; shard `state` → phase), `deferredAsTasks`,
releases straight from `releases.jsonl`. **Precedence**: an event override wins over the register
field it targets and is rendered `overridden · <lane>#<seq>` with the register value in `title=`
(R14). The adapters import `loadRegisters`/`computeLag` from `scripts/roadmap/render.mjs` (E5).

## 4. Fold — deterministic, three layers

`fold(registers, eventsByLane, github, railway, now) → state`:

1. **Registers** (adapters) → base tasks/releases.
2. **Reported** events in total order `(ts, lane, seq)`; `by:"sync"|"server"` sorts after an
   agent event with equal `ts`. Unapplicable events → `state.warnings[{lane, seq, reason}]`.
3. **Inferred** facts from GitHub/Railway (§5.4-5.7) applied last as *synthetic* events
   (`by:"infer"`, never written to the branch); the reconciliation table (§5.7) decides who wins
   per field. Every derived value carries `{source: "register"|"reported"|"inferred", ref}` so the
   UI can badge it.

`state = { tasks, lanes{current,next,blockers[],heartbeat,stale}, releases{readiness,history},
prs, branches, waste[], overlap[], piggyback{lane→[]}, timeline[], warnings[], version, sources{} }`.
`version` = sha256 of the canonical JSON (drives SSE). Same inputs → byte-identical output (R4).

## 5. Algorithms

### 5.1 Next eligible task for a lane — unchanged from round 1
Candidates: `status = planned`, `lane ∈ {lane, null}`, all `dependsOn` in `{code-complete,
released, dropped}`, release not shipped, not another lane's current, not `reconsider`. Explicit
`task.next` first if still eligible. Sort `priority asc → release shipDate asc (null last) →
customerImpact desc → effort asc → importance desc → id natural asc`. Top 5 + held lines.

### 5.2 Overlap (real diffs first, declared areas as fallback) and piggyback
- `filesOf(lane)`: if the lane has an attributed **open PR** (§5.4), its `files[]` from GitHub;
  else `expand(areas)` of its current task over the master file list (glob → regex: `**`→`.*`,
  `*`→`[^/]*`, `?`→`[^/]`, `()[]` escaped; bare directory prefix matches everything under it).
  Badge: `from diff` vs `declared`.
- Pair `(A,B)`: `shared = |FA ∩ FB|`, `coef = shared / min(|FA|,|FB|)` (0 if either empty).
  `HOT` if `shared ≥ 3 ∧ coef ≥ 0.5`; `WARN` if `shared ≥ 1 ∧ coef ≥ 0.25`; sorted
  `coef desc, shared desc, laneA asc, laneB asc`. Warn, never prohibit. Also computed PR-vs-PR
  for every pair of open PRs from different lanes (waste rule W10).
- **Piggyback** for lane L: candidates `status = planned ∧ lane = null ∧ effort ∈ {S, unknown}`
  (bugs: severity low|medium) with `shared = |filesOf(c) ∩ FL| ≥ 1`; `score = shared/|filesOf(c)|`;
  suggested if `score ≥ 0.5`; sort `score desc, priority asc, id asc`; cap 8. `sensitive: true`
  rows listed last with tag `tier-1 — not bundleable`, excluded from the header count.

### 5.3 Id minting
- Event identity `(lane, seq)`; per-lane files → no cross-machine collision for distinct lanes.
  Same lane on two machines: `ctl` refuses when the fetched file's last seq ≠ the seq it read
  before the append (compare-and-append; retries after `pull --rebase`).
- `RF-n` minted by `ctl task new` (lead) or the dashboard: next = `max(RF ids in snapshot +
  events) + 1`, allocated **inside the push loop** — on non-fast-forward the id is recomputed
  after rebase, so two minters cannot collide (the branch is the single serialization point;
  this replaces the L-201 "fetch --all and scan" ritual because there is only one branch).
- Lanes never mint task ids; `task.proposed` uses `tmpId = <lane>.<seq>`.
- Bug ids: `ctl bug "<title>" …` delegates to `node scripts/campaign/bugs.mjs file …` (E10) and
  appends `bug.filed` with the printed id; a lane on a dirty/non-master tree gets bugs.mjs's own
  refusal verbatim.

### 5.4 GitHub inference (server, zero tokens)
Per open PR: `number, title, isDraft, state, headRefName, headRefOid, baseRefName, createdAt,
updatedAt, mergedAt, mergeCommit.oid, mergeable, reviewDecision, files[{path, additions,
deletions}], checks (statusCheckRollup: state + contexts), body trailers, labels`. Per branch
(refs/heads): `name, target oid, committedDate`, `aheadOf(master)` = commits not on master (via
the server's git clone: `git rev-list --count origin/master..<oid>`).
**Links** (precedence): (1) trailers in PR body / HEAD commit: `Task: RF-n`, `Bug: B###`,
`Feature: F-nn`, `Defers: D-nn`, `Closes #n`; (2) branch name tokens `RF-\d+|B\d+|F-\d+` (`fix/B905-…`);
(3) none → `unlinked`. **Lane attribution** (precedence): (1) `Lane: <lane-id>` trailer in the PR
body or HEAD commit (new convention; `ctl start` prints the trailer block to paste into the PR
body); (2) linked task's `lane` (from `task.started`); (3) `unattributed`.
`ctl` also stamps `sha` on every event, so an event's sha ↔ branch mapping is a third signal.

### 5.5 PR ledger (kept forever)
`derived/prs.jsonl` rows `{pr, at, state (open|draft|ready|merged|closed), headSha, mergeSha?,
lane, links{task,bug,feature,defers,issue}, ci (pending|green|red|stale|none), review
(none|approved|changes|required), mergeable (clean|conflicting|unknown), files: n, areas[] (top-level
dirs of files), deployed: bool, deployedAt?}` — one row appended per **change** of any field
(server compares to the last row). Backfill once from GitHub (`states: [MERGED, CLOSED, OPEN]`,
paged 100). Metrics per release (from `mergedAt` ∈ release window or linked task release): PR
count, lead time `createdAt→mergedAt→deployedAt` (median, p90), closed-unmerged rate. Retention:
forever; the file is append-only and compacted with the branch (rows before the snapshot move to
`ctl/archive`).

### 5.6 Poll budget
- **Cadence** 30 s tick. Each tick: (a) `git fetch --depth=1 origin ctl/state` (+ `master` every
  5th tick or on webhook); (b) GraphQL **cheap query** `pullRequests(first: 40, orderBy:
  UPDATED_AT desc)` without files (≈ 1-3 points); (c) for each PR whose `updatedAt` or
  `headRefOid` changed since the last tick, a **per-PR query** with `files(first: 100)` and
  `statusCheckRollup` (≈ 2-3 points); (d) REST `GET /repos/:r/branches?per_page=100` with
  `If-None-Match` (a `304` costs nothing, A13); (e) Railway `deployments` query every 2nd tick.
- Budget: worst case 120 ticks/h × (3 + 10 changed PRs × 3) ≈ 4,000 points/h < 5,000; the poller
  reads `rateLimit { remaining, resetAt }` on every response and **backs off** to 60 s below 1,500
  and to 5 min below 500; `GET /api/health` shows remaining/cost.
- **Webhook (optional, recommended)**: `POST /api/github-webhook` with `X-Hub-Signature-256`
  (HMAC, `CONTROL_WEBHOOK_SECRET`) for `pull_request`, `push`, `check_suite`, `deployment_status`
  → immediate targeted refresh; when the webhook has fired within the last 10 min the poll
  cadence relaxes to 5 min (Q7 — the owner installs it in repo settings; costs no Actions minutes).

### 5.7 Reconciliation (inferred vs reported), per field
| Field | Winner | When they disagree |
|---|---|---|
| PR state, CI, mergeable, review, merged sha, deployed | inferred (GitHub/Railway are primary) | reported values are never stored for these |
| task status `code-complete` | inferred **if** a merged PR links the task; reported otherwise | reported `done` with no linked PR → status shown `code-complete (unverified)` + waste rule W8; merged PR while reported `in-progress` → inferred advances it, timeline says `inferred from #n` |
| task status `released` | inferred (merged sha is an ancestor of the deployed commit, both api and web services) | never reported except `release.shipped` by lead |
| lane.current / lane.next / blocked / reconsider / priority / release / lane assignment | reported | inference never overrides a decision; a lane whose current task's PR merged gets a **nudge** line in `ctl next` ("RF-231 merged as #2801 — run `ctl done`? or start next") |
| lane heartbeat | `max(last event ts, last push on an attributed branch)` | stale > 24 h → `stale`; > 72 h → `silent` (WORKFLOW thresholds, E21) |
| bug open/fixed | register (`bugs.jsonl`) | a `bug.fixed` event or a merged PR with `Bug: B###` while the register says open → `fixed · register lag` badge; nothing is written to the register |

### 5.8 Waste rules (defaults; each `{key, rule, subject, why, action, since}`)
| Rule | Fires when (defaults) | Suggested action |
|---|---|---|
| W1 idle PR | open non-draft PR, no commit/review/comment for **> 3 d** | rebase + ping lane / close |
| W2 stale draft | draft for **> 5 d** never marked ready | mark ready / close |
| W3 red or stale CI | rollup `FAILURE` for > 24 h, or head sha has no check run for > 2 h | fix / re-run |
| W4 conflicting | `mergeable = CONFLICTING` | rebase |
| W5 closed-unmerged, not re-landed | closed without merge, and no commit of the PR's range has a matching `patch-id` on master **and** the range diff's patch-id ≠ any master commit's (A17), and no `pr.superseded` event / "Superseded by #n" in body | salvage or `ctl pr superseded` |
| W6 orphan branch | pushed branch ahead of master ≥ 1 commit, no open/merged PR, last push > **2 d** | open PR / delete |
| W6L local worktree (local mode only) | `git worktree list` entry whose branch is ahead of master with no PR (E50: no audit script exists — the server runs `git worktree list --porcelain` + `rev-list --count`) | push / remove |
| W7 merged, not deployed | merged > **2 h** ago and merge sha not an ancestor of the deployed commit of api **and** web, or a deploy FAILED for it | watch deploy / redeploy |
| W7b bookkeeping pending | merged with `Bookkeeping-Follow-Up: pending` and no later PR (merged or open) whose body/commits cite the merge sha (7+ chars) within **24 h** | open the docs follow-up |
| W8 done without PR | task `code-complete` reported > **24 h** ago, no merged PR links it | link the PR (`Task:` trailer) or reopen |
| W9 orphan PR | merged PR with no task/bug/feature link and no `Lane:` trailer | add trailers in the follow-up (or `waste.ack`) |
| W10 overlapping PRs | two open PRs from different lanes with `shared ≥ 1` file | coordinate / rebase order |
`key = <rule>:<subject>:<headSha or mergeSha>`; a `waste.ack` with that key hides the item until
`until` (default: until the subject's sha changes). Panel sorted `rule severity (W4,W3,W5,W7 > W1,
W2,W6,W8 > W9,W10) → age desc`.

### 5.9 Release readiness — as round 1 §6.1 (READY / IN PROGRESS / AT RISK / MOVED / SHIPPED, E35 thresholds), plus PR metrics from §5.5.

## 6. Service, auth, hosting

- **Location `apps/control`** (not `tools/`): `apps/*` is already a workspace glob (E48) so no
  root edit; Railway's per-app `Dockerfile` + `railway.toml` convention (E46); `verify-scope`
  scopes verify to it (E49); Gate 2 treats it as code (E13). `railway.toml` `watchPatterns =
  ["apps/control/**"]` — and `apps/control` depends on **no `packages/*`** (so api/web's
  `packages/**` pattern never fires for it and vice-versa). Dockerfile = api's two-stage shape,
  `node:24-alpine`, `CMD node dist/main.js`, plus `git` and `openssh-client` installed (apk).
- **Stack**: TypeScript (`module: nodenext`, mirrors api tsconfig E47), Node `http`, `crypto`,
  `child_process` (git), global `fetch`. No framework, no ORM, no DB. Static assets inline.
- **Env** (names only): `CONTROL_PASSWORD` (owner password; hashed with `scrypt` at boot),
  `CONTROL_SESSION_SECRET` (≥ 32 B), `CONTROL_GITHUB_TOKEN` (fine-grained PAT, A12),
  `CONTROL_DEPLOY_KEY_B64` (read-only SSH deploy key), `CONTROL_REPO` (`owner/name`),
  `CONTROL_STATE_BRANCH` (`ctl/state`), `CONTROL_RAILWAY_TOKEN` + `CONTROL_RAILWAY_PROJECT_ID`
  (optional, A14), `CONTROL_WEBHOOK_SECRET` (optional), `CONTROL_PORT` (Railway `PORT`),
  `CONTROL_LOCAL=1` (dev mode: bind 127.0.0.1, no login, read the local checkout + push via a
  local clone). Missing required env → exit 1 at boot with the name (never a default password).
- **Auth**: signed-cookie login (chosen over basic auth: basic auth re-sends the password on every
  request, cannot log out, gets no `SameSite` CSRF protection and shows a browser dialog).
  `POST /login` (form) compares `scrypt(password)` in constant time → cookie `ctl_session` =
  `base64url(payload).hmac` with `{iat, exp = iat + 12 h, nonce}`, flags `HttpOnly; Secure;
  SameSite=Strict; Path=/`. Rate limit: 5 failed logins per IP per 15 min and 30 globally →
  `429` + 2 s delay; every attempt logged (no password). `POST /logout` clears it. Session
  secret rotation = env change + redeploy (all sessions invalid).
- **Headers on every response**: `X-Robots-Tag: noindex, nofollow, noarchive`,
  `Cache-Control: no-store`, `Content-Security-Policy: default-src 'self'; img-src 'self' data:;
  style-src 'self' 'unsafe-inline'; script-src 'self'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Strict-Transport-Security` (Railway terminates TLS),
  `X-Frame-Options: DENY`. `/robots.txt` → `User-agent: *\nDisallow: /`.
- **Routes**: `GET /` (page), `GET /login`, `POST /login`, `POST /logout`, `GET /api/state.json`,
  `GET /api/stream` (SSE `event: version`), `POST /api/event` (write-back), `POST /api/github-webhook`
  (unauthenticated but HMAC-verified), `GET /api/health` (auth'd: sources, rate limit, last fetch
  times, versions), `GET /robots.txt`, `GET /assets/client.js`, `GET /assets/styles.css`. Any
  other path → 404. No path parameter is ever a filesystem path (R17).
- **Write-back** (`POST /api/event`): session cookie **and** `Origin` = served origin **and**
  `X-Control-Token` = per-session CSRF token embedded in the page **and** JSON ≤ 16 KB **and**
  `type` ∈ owner-allowed `{task.created, task.adopted, task.priority, task.release, task.lane,
  task.next, task.reconsider, task.reopened, task.areas, task.dropped, release.created,
  release.moved, pr.superseded, waste.ack, lane.registered, lane.note}` **and** payload valid
  **and** ids resolve in the current state **and** `expectedVersion` = current state version
  (else `409 {conflict: true}` → the UI reloads). Accepted → append to `events/owner.jsonl`
  under the push loop (§7) → re-fold → SSE. Undo = compensating event (R18).
- **SSE**: `GET /api/stream` keeps ≤ 20 connections; sends `version` on every fold change and a
  `ping` every 25 s; the client refetches `/api/state.json` (ETag) on `version`.
- **Cost**: one 0.25-0.5 vCPU / 512 MB service, no volume (state is git) ≈ **$3-8 / month** (A16).

## 7. `ctl` CLI and the push loop (`apps/control/src/cli/ctl.ts`, root script `npm run ctl -- …`)

Commands: `next [--lane X] [--json]`, `start <task>`, `done <task> [--pr n]`, `block <task>
--reason "…"`, `unblock <task>`, `set-next <task|none>`, `progress <task> --phase p`, `note
"…"`, `propose "<title>" --kind k --areas a,b`, `bug "<title>" --location … --severity …` (→
bugs.mjs), `pr-body <task>` (prints the trailer block `Task: RF-n` / `Lane: <lane>` / `Bug:`),
`show <id>`, `overlap`, `piggyback`, `handoff --card <path>`, `task new …` (lead), `adopt
<tmpId>` (lead), `renumber --lane X` (lead, repair only), `compact` (server/lead), `sync
--since <sha>` (coordinator; reads trailers via `from-git.mjs`'s `parseTrailers`, E54).
Lane = `--lane` or `CTL_LANE` env or `.claude/control/.lane` (gitignored, written by `ctl lane
use X`); unknown lane → exit 2, nothing written.

**Push loop** (`appendAndPush(lane, event)`), the same code path for `ctl` and the server:
```
clone = local-assets/control/state/   (gitignored; `git clone --single-branch --branch ctl/state --depth 50 <origin>`
                                       on first use; the server uses /data/state with the deploy key)
lock  = <clone>/.ctl.lock/ (mkdir-atomic, stale after 30 s; same pattern as bugs.mjs E12)
for attempt in 1..6:
  git -C clone fetch --depth 50 origin ctl/state && git reset --hard origin/ctl/state   # never merge, never stash
  read last seq of events/<lane>.jsonl (0 if absent) → event.seq = last + 1; mint RF-n here if task.created
  denylist scan; schema + transition check against fold(snapshot + events) → refuse (exit 3/4) before any write
  append line; git add; git -c user.name=ctl -c user.email=ctl@routeflow.local commit -q -m "ctl(<lane>): #<seq> <type> <task?>"
  git push -q origin HEAD:ctl/state  → success: print "✓ <lane>#<seq> <type> <task> (pushed <sha7>)"; exit 0
  on non-fast-forward: sleep 0.5·2^attempt s (jitter ±20 %), retry (the loop re-reads seq, so no duplicate seq is possible)
after 6 attempts: exit 5, line kept in <clone>/pending/<lane>.jsonl and printed; next ctl call drains pending first
```
No husky hooks run (separate clone, never `npm install`ed, E51); no workflow triggers (E45); no
Railway build (A11). Commit trailers are absent on purpose (commitlint does not run there).

## 8. The amended bookkeeping rule (exact text)

**Insert in `CLAUDE.md` after "Lessons learned routine":**

> ## Control system (lanes, tasks, events)
>
> Fleet state lives on the orphan branch **`ctl/state`** (per-lane `events/<lane>.jsonl`, append-
> only) and is shown by the private control dashboard (Railway service `apps/control`; locally
> `npm run control`). Lanes never edit it by hand and never put it in a PR: `npm run ctl --
> start|done|block|bug|propose|set-next …` appends one line and pushes it (no CI, no hooks, no
> deploy). Start every session with `npm run ctl -- next --lane <lane>` (≤ 30 lines) instead of
> reading the registers, and paste the block `npm run ctl -- pr-body <task>` prints into every PR
> body (`Task:`/`Lane:` trailers are how PRs are attributed with zero tokens). Master's registers
> (`.claude/roadmap/*`, `.claude/campaign/*`, code map, lessons) keep Bookkeeping Option B
> unchanged; PR/CI/deploy state is inferred from GitHub and Railway, never typed.

**Insert in `.claude/roadmap/README.md` under "Who edits these files":**

> **Not here — lane status.** Per-lane current/next/blocked/done state is not a roadmap field: it
> lives on the `ctl/state` branch, written only by `npm run ctl` (see `CLAUDE.md` § Control
> system). The control dashboard reads these three registers through adapters and never edits
> them; a status the dashboard infers that disagrees with a row here is shown as `register lag`,
> and the bookkeeping PR still updates the row.

Validation/hook changes: **none to `stop.mjs` Gates 2/3** (they key on `.claude/code-map/`,
`.claude/lessons/` and code paths, E13; `ctl/state` never appears in a working tree that runs
them). `npm run verify` gains `apps/control`'s Jest/lint/check-types through turbo (E48/E49) plus
`node apps/control/dist/cli/ctl.js validate` is **not** needed on master (there are no state files
on master). Every workflow's triggers were verified (E45): none fires on a push to `ctl/state`.
Merge-conflict story: no PRs touch state files; the push loop serializes on the branch tip.
**Branch protection** (owner, Q8): ruleset on `ctl/state` — block force-push and deletion, no
required checks; ruleset on `master` unchanged. **Compaction**: `ctl compact` (server, daily
02:00 UTC or when `events/` > 384 KB): write `snapshot.json` (fold at that tip), move every
lane's segment to `ctl/archive` `archive/<lane>/<from>-<to>.jsonl` (one commit on that branch),
start new segments with the `segment` header line; readers fold `snapshot + segments`.

## 9. Requirements

| R# | Pri | Requirement (observable) | Verified by |
|---|---|---|---|
| R1 | must | `validateEvents(files)` (library) and `ctl validate <dir>` exit 0 on a valid state tree and report `file:line reason` for: invalid JSON, unknown type, extra/missing payload key, `seq` ≠ previous+1 (segment header aside), `ts` decreasing, lane mismatch, unregistered lane, dangling task/dependsOn/release id, illegal transition (§2), duplicate `RF-` mint, glob with `..`/backslash, line > 1,024 B, denylist hit, an unauthorised emitter (e.g. `task.created` from `lane-u`) | T1-T4 |
| R2 | must | `npm run verify` (turbo) runs `apps/control` `check-types`, `lint`, `test`; a red Jest spec there makes `verify` red | T5 |
| R3 | must | Registers on master are never modified by any control code path (`git status` clean on `.claude/roadmap`, `.claude/campaign` after every command and after 100 server ticks) | T6, T7 |
| R4 | must | `fold()` deterministic (byte-identical `state.json` for identical inputs); events applied in `(ts, lane, seq)`; warnings carry `(lane, seq, reason)`; every derived value carries `source` | T8, T9 |
| R5 | must | Transition matrix §2 enforced: `ctl` refuses (exit 3, nothing pushed), server answers 409, fold warns | T10, T11 |
| R6 | must | `nextEligible` per §5.1 | T12, T13 |
| R7 | must | Overlap per §5.2 from PR files when present, declared areas otherwise; symmetric; thresholds; badge `from diff`/`declared` | T14, T15 |
| R8 | must | Piggyback per §5.2 incl. sensitive-last and header count | T16, T17 |
| R9 | must | `ctl start|done|block|unblock|set-next|progress|note|propose|bug` append exactly one line (≤ 240 B with `note` ≤ 80 chars) with `seq = last+1`, `ts` now UTC, `sha` short HEAD, and push it; the retry loop survives a concurrent push (6 attempts, exponential backoff); unknown lane → exit 2; illegal → exit 3; denylist → exit 4; push exhausted → exit 5 with the line parked in `pending/` and drained next call | T18-T20, T23 |
| R10 | must | `ctl next --lane X` prints ≤ 30 lines / ≤ 1,536 B: current (id, title, phase, blocker), PR facts for current (number, CI, review, mergeable), nudge if merged, explicit next, top-5 eligible with one reason each, piggyback count, overlap warnings; exit 0 always (corrupt state → one line `control: INVALID …`) | T21, T22 |
| R11 | must | Append safety: lock dir per clone; two concurrent `ctl` on one machine/lane yield seq n+1, n+2 (never dup/interleave); two machines on one lane yield distinct seqs via the non-fast-forward retry | T23 |
| R12 | must | Renderer emits a single self-contained HTML document (inline CSS/JS served from `/assets/*` same-origin, no CDN/fonts), ≤ 400 KB with 817 bugs + 100 PRs; `version` in a `<meta>`; deterministic for identical state | T24, T25 |
| R13 | must | Home page panels per ux-spec §3: header status line, lane board (current→next, heartbeat), blockers strip, "At risk of waste" (§5.8), release readiness (§5.9 + PR metrics), bug counters (open/critical/active/recently resolved + severity mix), queue (top 10), PR ledger (open PRs with CI/review/mergeable/lane/links; merged today; closed-unmerged), overlap pairs, piggyback per active lane, feature phase bars, activity timeline (last 40 events + inferred changes) | T26 (golden), T30 (UI) |
| R14 | must | Override/lag/inferred badges: `overridden · lane#seq`, `register lag`, `inferred from #n`, `unverified` rendered with `title=` carrying the other value | T27 |
| R15 | must | Server binds `0.0.0.0:$PORT` on Railway and `127.0.0.1:4317` under `CONTROL_LOCAL=1`; refuses to boot without required env; `GET /api/health` reports each source's last success, the GitHub rate-limit remaining, and the state version; SIGTERM → drains SSE, exits 0 within 5 s | T28 |
| R16 | must | Write-back accepts only requests satisfying every condition in §6 "Write-back"; each missing condition → the stated 4xx and nothing appended; a version mismatch → 409; accepted → appended to `events/owner.jsonl` only, pushed, then `{seq, version}` returned | T29, T31-T34 |
| R17 | must | No request value ever becomes a filesystem path or a git argument; lane/task ids are validated against the folded state before use; `/../`, `/events/x` etc. → 404 | T33 |
| R18 | must | Undo = compensating event; write failure keeps the confirmed state visible with an inline error; 409 reloads | T34, T30 |
| R19 | must | Rule text §8 present verbatim in `CLAUDE.md` and `.claude/roadmap/README.md`; `.claude/control/README.md` states the schema; `stop.mjs` Gates 2/3 unaffected (E13/E14) | T35, T36 |
| R20 | must | Token-cost acceptance: `ctl next` ≤ 1,536 B; one status change = one `ctl` call whose stdout ≤ 200 B (≤ 150 tokens incl. the command); a lane never opens `bugs.jsonl`/`features.jsonl` to act (`ctl show <id>` ≤ 1 KB) | T21, T18, T37 |
| R21 | must | Auth: login required for every route except `/login`, `/robots.txt`, `/api/github-webhook`; wrong password → 401 with constant-time compare; 6th failure in 15 min from one IP → 429; cookie attributes as §6; `X-Robots-Tag` + CSP + `no-store` on every response; `/robots.txt` disallows all; `CONTROL_LOCAL=1` skips login and binds loopback only | T38-T41 |
| R22 | must | Inference: PR ledger fields per §5.5 derived from a recorded GitHub fixture; links per §5.4 precedence; lane attribution precedence; a merged PR advances its linked task to `code-complete`; a deployed merge sha → `released`; reconciliation table §5.7 (six rows) each provable | T42-T47 |
| R23 | must | Waste rules W1-W10 (+W6L local) fire exactly at the stated thresholds on fixtures and not below; `waste.ack` suppresses by key until the sha changes/`until`; each item carries `why` and `action` | T48-T50 |
| R24 | must | Poll budget: per-tick GraphQL cost ≤ 3 points with no PR changes and ≤ 3 per changed PR; REST branches use `If-None-Match`; back-off thresholds (1,500 → 60 s, 500 → 5 min); webhook HMAC verified and a bad signature → 401 without any refresh | T51-T53 |
| R25 | must | SSE: a fold change emits one `version` event to every open stream within 1 s; ping every 25 s; a client reconnects after drop (`retry:` header) | T54 |
| R26 | must | Compaction: `ctl compact` writes `snapshot.json`, moves segments to `ctl/archive`, starts new segments with the header; `fold(snapshot + new segments)` equals `fold(all events)`; tip tree ≤ 512 KB after compaction of a 2 MB fixture | T55 |
| R27 | must | Railway isolation: `apps/control/railway.toml` `watchPatterns = ["apps/control/**"]`; `apps/control/package.json` has no dependency on any `@routeflow/*` package (so `packages/**` in api/web patterns cannot be triggered by it, and it cannot be triggered by them); a Jest spec pins both | T56 |
| R28 | must | No GitHub Actions workflow triggers on a push to `ctl/state` or `ctl/archive` (a spec parses every `.github/workflows/*.yml` `on:` block: no `push` trigger, or one with `branches-ignore` covering `ctl/**`) | T57 |
| R29 | must | Denylist: every appended line (ctl and server) is scanned with `plane-denylist.json` patterns + URL pattern; a hit → refused (exit 4 / 422), nothing written; fixtures include a tenant-uuid-shaped string and an email | T58 |
| R30 | must | Synthetic data only: fixtures under `apps/control/test/fixtures/acme/`; a spec greps `apps/control/` for the denylist patterns → 0 hits | T59 |
| R31 | should | `/orient` gains step 9 (`npm run ctl -- next`), `.claude/settings.json` SessionStart runs it (exit 0, ≤ 1.5 KB), `/handoff` template gains the `Control:` line + `ctl handoff`, repo `closeout.mjs` accepts `--task <id>` → `ctl done` | T60 |
| R32 | should | `ctl/state` tip ≤ 512 KB; `git fetch --depth=1` of it transfers ≤ 1 MB (measured in a fixture repo) | T55 |
| R33 | should | Page states per ux-spec §5 (empty, loading, stale source, malformed rows, write failure, conflict, logged-out, rate-limited) | T30, T61 |
| R34 | should | Responsive 1440/768/390; dark via `prefers-color-scheme`; keyboard-operable; contrast ≥ 4.5:1 text, ≥ 3:1 pills in both schemes | T30, T62 |
| R35 | could | `ctl overlap`, `ctl piggyback`, `ctl waste` print the panels as text (≤ 40 lines) | T63 |

## 10. Non-goals (slice 1) and deferral rows

Non-goals: task/feature detail pages; per-phase checklists; history views (data is recorded);
customer-request intake; bug filter UI; Plane sync of tasks/lanes/PRs; GitHub issues read-through
(only PR/branch/check data); multi-user roles; mobile app; React; a second HTTP server; editing
master registers from the UI; Actions-based anything.

| id | Slice | Item | Revisit trigger |
|---|---|---|---|
| S2-1 | 2 | Task/feature detail page (what/why/how, phases + checklist, related bugs/requests, areas, event + PR history) | after one release wave on slice 1 |
| S2-2 | 2 | Feature phase progress from `task.progress` + checklist items | same |
| S2-3 | 2 | Release history / plan-change view + development memory per past release (fold of `task.release`, `release.moved/shipped`, PR ledger) | same |
| S2-4 | 2 | Bug filters (status/severity/module/release/lane) | owner asks for triage in the dashboard |
| S2-5 | 2 | GitHub issues / work-board read-through (`issue` links, assignee → lane hint) | owner ruling Q4 |
| S2-6 | 2 | `ctl/archive` history reader + PR lead-time charts | after S2-3 |
| S3-1 | 3 | Customer-request intake (`request.*` events: request → analysis → agreed → definition → priority → queue) | after S2 |
| S3-2 | 3 | Plane mirror of lanes/tasks/PR metrics via `plane-apply` ops | after S2 |
| S3-3 | 3 | Webhook-driven Railway deploy state via GitHub `deployment_status` if A14 fails | at WP5 |

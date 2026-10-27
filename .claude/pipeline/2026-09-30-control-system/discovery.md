# Discovery: Routeflow Development Control System (slice 1)

> **Stage P3 — "why".** Authored 2026-09-30 by Fable 5.1 (planner subagent). Status: `DRAFT`.
> Sole input: [owner-request.md](./owner-request.md). Authoritative repo state read from
> `origin/master` @ `47f648ce191c172380b8ebbfe0561e3d1697d394` (this checkout is 299 commits behind).
> Scale **MAJOR**, `ui: true` (a new dashboard surface). Decisions 1-5 in owner-request.md are
> settled and not re-litigated here.

---

## 0. Evidence table (stage P1 — Ground)

Every claim in every artifact of this run traces to a row here or is marked `unverified` (→ A#).
Sources are `path:line` at `origin/master` unless stated. `q:` = a query plus its result.

| # | Claim | Source | Kind |
|---|---|---|---|
| E1 | Roadmap registers are three JSONL files (`features`, `deferred`, `releases`); rule "no work without a row"; edited by **bookkeeping PRs only** (Option B) | `.claude/roadmap/README.md` §"The rule", §"Who edits these files" | code |
| E2 | `features.jsonl` = 26 rows / 26,056 B; keys `id,name,description,area,release,targetDate,status,percentDone,ownerLane,machine,prs,dependsOn,public,notes`; statuses seen `in-progress, at-risk, planned` | q: node parse of `git show origin/master:.claude/roadmap/features.jsonl` | query |
| E3 | `deferred.jsonl` 34 rows / 27,377 B, keys incl. `fromFeature, fromBug, revisitBy, owner, status`; `releases.jsonl` 7 rows (R1, R1.1, R1.1a/b/c, R2, R3) with `cutDate, goNoGoDate, shipDate, goal, status` | same query; `releases.jsonl` full read | query |
| E4 | `ownerLane` is free text, 19 distinct values incl. "Lane U-units", "Lane B", "R-ui", "Lead", "to assign", "to scope" | q: distinct `ownerLane|machine` over features.jsonl | query |
| E5 | `scripts/roadmap/render.mjs` (626 lines) exports `ROOT, REG_FILES, regDir, defaultOutDir, nowIso, dayOf, registersHash, loadRegisters, validate, computeLag, validateWarnings, writeAtomic, renderAll, statusReport`; CLI `--validate/--status/--prs/--out`; writes `local-assets/roadmap/{roadmap,tracker,deferred}.html + lag.json + .rendered.json`; embedded CSS with light+dark (`prefers-color-scheme`) tokens | `scripts/roadmap/render.mjs:16-47, 87-163, 233-290, 395-428, 544-626` | code |
| E6 | render.mjs reads `.claude/campaign/bugs.jsonl` for bug counts per feature (`bugCounts`) | `render.mjs:196, 408-412` | code |
| E7 | Standalone-script coverage convention = `*.self-test.mjs`, plain Node, PASS/FAIL lines, `process.exit(failures?1:0)`, spawned CLI with pinned clock (`ROADMAP_SELF_TEST=1`, `ROADMAP_NOW`), mkdtemp fixture dirs | `scripts/roadmap/render.self-test.mjs:1-56`; `.claude/hooks/stop.gates.spec.mjs:1-13` ("No root-level test runner … plain node script … same shape as validate-lessons.mjs") | code |
| E8 | `npm run verify` is one `&&` chain of validators + self-tests + `verify-turbo.mjs` (Jest per workspace) — adding a self-test = adding a chain element | root `package.json` `scripts.verify` | code |
| E9 | `.claude/campaign/bugs.jsonl` = 817 rows / 561,500 B; keys `id,title,location,severity,register,batch,source,filedAt,sensitive,sensitiveFor[,symptom,tags]`; `register` values: `open`/`Open` 455, `Fixed · #n` 353, `Cleared` 5, `Refuted` 2, `Already…` 1, `Duplicate` 1; severity low 215 / medium 278 / high 271 / critical 50; max id B906 | q: node parse | query |
| E10 | bugs.jsonl is **regenerated** from `.claude/campaign/bugs/B###.md` (817 records) by `bugs.mjs index` — "regenerate, never hand-edit"; record front matter carries `state, batch, tier, proof, sensitive, sensitiveFor`; ids lead-minted with reservation rules (B453) | `scripts/campaign/bugs.mjs:63-77, 357-411`; `.claude/campaign/bugs/B905.md` | code |
| E11 | Bug state machine lives in `.claude/campaign/status/F##.jsonl` (rows `id,batch,tier,state,pr,proof,evidence`; states `queued,in-flight,proven,proven-pending-deploy,done,already-fixed,refuted,regressed`), gated by `scripts/campaign-check.mjs` | `campaign-check.mjs:17-45`; `status/F64.jsonl` | code |
| E12 | bugs.mjs already implements catalogue+shard **lock dirs** (`withCatalogueLock` → `withShardLock`, one-way order) and `acquireLock` mkdir pattern | `bugs.mjs:19-46, 1994-2212` | code |
| E13 | `stop.mjs` Gate 2/3 key on **file-path prefixes** `.claude/code-map/` / `.claude/lessons/` and on `isCode = ^(apps|packages|scripts)/…\.(ts|tsx|js|jsx|cjs|mjs|prisma)$` (specs excluded); the `Bookkeeping-Follow-Up: pending` trailer bypasses both; Gates 4/5 never block | `.claude/hooks/stop.mjs:96-101, 136-160, 193-238, 240-299` | code |
| E14 | Consequence of E13: a `.claude/control/events/<lane>.jsonl` line is neither code nor a gated register → Gate 2/3 are **unaffected**; `scripts/control/*.mjs` IS code → needs a code-map entry or the trailer | derived from E13 | code |
| E15 | `.gitattributes` = `* text=auto eol=lf` + binary rules; no merge drivers today | `.gitattributes:1-9` | code |
| E16 | `.lintstagedrc.json` runs prettier on `*.{ts,tsx,js,jsx,mjs,cjs,json,md,yaml,yml,css}` — `.jsonl` is NOT formatted; root `format` glob likewise | `.lintstagedrc.json`; `package.json` `scripts.format` | code |
| E17 | Pre-push: `push-guard.mjs` (build-dir adds, 5 MiB new-blob cap) then `npm run verify` unless `SKIP_VERIFY=1` (audited) | `.husky/pre-push`; `scripts/push-guard.mjs:1-24` | code |
| E18 | `local-assets/` is gitignored (machine-local home for generated output); `.claude/campaign/**/*.lock/` gitignored | `.gitignore:107-126` | code |
| E19 | Plane harness: BUGS = one-way mirror of bugs.jsonl (`plane:sync` only writer); ROAD = programs/releases; branch guard (writes only on master); write budgets; Gate 5 mirrors bugs after every turn (non-blocking) | `.claude/skills/plane/SKILL.md` §1-5; `stop.mjs:294-299` | code |
| E20 | Roadmap README: "If Plane and this register disagree, this register wins and Plane gets re-synced" | `.claude/roadmap/README.md` §"Account independence" | code |
| E21 | A **GitHub Project work board** exists: issues are the unit of work; `lane:*` labels = file-area lock (orders, invoices, pricing, returns-regulated, purchasing, scanner, routes-delivery, inventory, billing, tooling, unsorted); status derived by `scripts/work/reconcile.mjs` every 5 min on the owner's PC; `work:claim` | `docs/work/WORKFLOW.md` rules 1-6, §Labels, §Claiming; `scripts/work/run.mjs:1-30`; `scripts/work/claim.mjs:1-12` | code |
| E22 | Handoff cards: `.claude/handoffs/<date>-<slug>.md`, ≤ 2 KB, fixed sections incl. `Areas touched` | `.claude/commands/handoff.md` | code |
| E23 | `/orient` reconstructs a brief by hand when `~/.claude/hooks/orient.mjs` is absent (it IS absent on this Mac: `ls ~/.claude/hooks` → no such dir); step 8 runs `plane-triage --brief` | `.claude/commands/orient.md`; q: `ls ~/.claude/hooks/` | query |
| E24 | `closeout.mjs` (dev-pipeline) appends a ledger row, RUN-LOG stub, LESSONS stub, writes a handoff card — idempotent by run slug | `~/.claude/skills/dev-pipeline/scripts/closeout.mjs:1-27`; repo copy `.claude/skills/dev-pipeline/scripts/closeout.mjs` | code |
| E25 | SessionStart hooks today: `plane-triage.mjs --brief`, `check-git-hooks.mjs --warn`; PostToolUse(Bash) → `scripts/work/claude-hook.mjs`; Stop → `stop.mjs` | `.claude/settings.json` `hooks` | code |
| E26 | Bytes a lane reads today to orient (origin/master): CLAUDE.md 24,179; INDEX.md 12,649; LESSONS-DIGEST 13,111; features.jsonl 26,056; deferred.jsonl 27,377; releases.jsonl 3,539; bugs.jsonl 561,500; `.claude/sa/RULINGS.md` 570,341; SA HANDOFF.md 11,768 | q: `wc -c` over `git show` | query |
| E27 | Fleet lanes seen in handoffs (local + master): lane-a…f, lane-u-units(-b/-c), lane-u-po, lane-s-order, lane-b, r-ui, s-scan, u-units, f2 (prover), ir, sa, mac-lead, landing-coordinator, connect-lane, mobile-unit-picker-lane, fleet-lead | q: `ls .claude/handoffs` + `git ls-tree origin/master .claude/handoffs` | query |
| E28 | Design tokens: `apps/web/app/globals.css` `:root` (paper/canvas/sunken/line, brand teal, status success/warning/danger/info + `-bg`, `--r-ctl 6px`, `--r-card 10px`, shadows, Spline Sans); `.dark` block is **commented out**; per-surface accents (operator teal, buyer emerald, admin indigo) | `globals.css:27-119`; `.claude/pipeline/design-system.md` (17,732 B, derived 2026-08-31) | code |
| E29 | Repo-level `.claude/pipeline/design-system.md` already exists and documents tokens, primitives (`Badge`, `StatCard`, `Table`, `Skeleton`, `EmptyState`, `Toast` w/ Undo), "No Tooltip primitive", disabled patterns, "dark mode effectively not implemented" | `.claude/pipeline/design-system.md` §Tokens, §Components | code |
| E30 | Playwright lives only in `apps/web` (`@playwright/test ^1.63`); `PLAYWRIGHT_BASE_URL` REQUIRED and vetted local-only by `lib/e2e-setup-guard.ts`; global setup seeds a tenant unless `SKIP_E2E_SEED=true`; precedent for a **separate config** driven by a root script: `scripts/native-parity/run.mjs` → `npx playwright test -c playwright.native-parity.config.ts` in apps/web, captures at 390×844 to `local-assets/proofs/<date>/…` | `apps/web/playwright.config.ts:1-66`; `apps/web/e2e/native-parity/buyer.capture.ts:1-8`; `scripts/native-parity/run.mjs:61-66` | code |
| E31 | Fleet gate for UI = "Playwright 1440/768/390 for any UI, from one host, OS/Chromium recorded" | `.claude/skills/fleet-lead/SKILL.md` §3 tier 2 | code |
| E32 | Size ratchet covers 15 named giant files (`apps/api/src/common/size-ratchet.spec.ts`), none under `scripts/`; `check-staged-file-size.mjs` blocks staged files > 1 MiB | `size-ratchet.spec.ts:1-56`; `check-staged-file-size.mjs:13` | code |
| E33 | Prior art **F-22 "Tracking engine"** (tooling, planned 0%): registers as SoT, validate gate in verify, trailers, post-merge render, SessionStart prints roadmap state — WP1 (#1366) and WP2 (#2217, `from-git.mjs`) landed | features.jsonl F-22; `git log origin/master -- scripts/roadmap` | code |
| E34 | `from-git.mjs` parses `Feature:/Bug:/Defers:` trailers from first-parent squash commits; `--apply` merges PR numbers into features.jsonl | `scripts/roadmap/from-git.mjs:1-30` | code |
| E35 | Release "at-risk" thresholds already defined: due within 3 days with > 25 % open | `scripts/work/plane-release-sync.mjs:79-80, 120` | code |
| E36 | Lessons that bind this design: L-201 (shared monotonic ids can't be allocated from one tree), L-231 (register claim carries provenance), L-240 (long-lived board hits the 2,500-comment cap → #2554), L-206 (a test pinning a literal from a doc reads it at test time), L-165 (assert a process's own exit signal, not wall clock) | `.claude/lessons/LESSONS-DIGEST.md` | code |
| E37 | Fleet-lead §1: "a fact restated in a second place is the copy that goes wrong" | `fleet-lead/SKILL.md` §1-2 | code |
| E38 | `campaign-check.mjs --freshness-only` is the first element of `verify`; `.campaign/runs/*.json` are Jest reporter outputs | `package.json` verify; `campaign-check.mjs:17-30` | code |
| E39 | Node engine `>=24`, npm `>=11`; ESM `.mjs` everywhere under `scripts/`; no `jq` on either machine | root `package.json` `engines`; memory note | code |
| E40 | Ledger summary (last 10 true-telemetry runs): mean true cost $44.04, clean rate 44 %; RUN-LOG newest entries name (a) probes against HEAD when repro tests were uncommitted → false blockers, (b) wrong "before" capture served fix code, (c) DB-shape defects mocks cannot see | `pipeline-ledger.mjs summary --last 10`; RUN-LOG 2026-09-25/28 | query |

**Absences (each a claim, each searched):**

| # | Absence | Query → result |
|---|---|---|
| E41 | No `.claude/control/` or `scripts/control/` on master | `git ls-tree origin/master .claude/ scripts/` → not present |
| E42 | No `merge=union` anywhere | `.gitattributes` full read → none |
| E43 | No `tasks.jsonl`, `lanes.json`, or per-lane event log anywhere | `git ls-tree -r origin/master \| grep -iE "tasks.jsonl\|lanes.json\|events/"` → 0 (unverified beyond `.claude/` and `scripts/` trees; see A9) |
| E44 | No tooltip primitive, no dark mode in web (E29) | design-system.md |

**Evidence added for owner rounds 2-3 (hosting, state branch, inference, PR ledger):**

| # | Claim | Source | Kind |
|---|---|---|---|
| E45 | GitHub Actions triggers on master: `ci.yml` = `pull_request` (types opened/synchronize/reopened/ready_for_review, `paths-ignore` incl. `.claude/**`) + `deployment_status`; `db-migrations.yml` = `pull_request` (paths); `deploy-production`, `nightly`, `post-deploy` = `workflow_dispatch`; `google-signin-monitor` = `schedule` + dispatch. **No workflow has an `on: push` trigger** → a push to a branch with no PR starts nothing | `awk '/^on:/…'` over all six `.github/workflows/*.yml` | query |
| E46 | Railway builds per service from a Dockerfile with `watchPatterns` (api: `["apps/api/**","packages/**"]`), root build context, `node:24-alpine`; auto-deploys from pushes to master via the Railway GitHub App (CLAUDE.md § Deployment) | `apps/api/railway.toml:1-6`; `apps/api/Dockerfile:1-30`; CLAUDE.md | code |
| E47 | Workspace test convention for a Node app: Jest 30 + ts-jest 29, config in `package.json` `"jest"` (`rootDir: src`, `testRegex .*\.spec\.ts$`, transform ts-jest, campaign reporter with `artifact`), `tsconfig` `module: nodenext`, `check-types` via `scripts/check-types-ratchet.mjs`, ESLint flat config (`typescript-eslint` recommendedTypeChecked + prettier) | `apps/api/package.json:137-180`; `apps/api/tsconfig.json`; `apps/api/eslint.config.mjs:1-20` | code |
| E48 | npm workspaces glob is `apps/*` + `packages/*` (root `package.json`), so a new `apps/control` is a workspace with no root edit; turbo `globalDependencies` include `apps/*/package.json` | root `package.json` `workspaces`; `turbo.json` | code |
| E49 | `verify-turbo.mjs` runs affected workspaces only on a branch (`verify-scope.mjs`), full on master/CI | `scripts/verify-turbo.mjs:1-12` | code |
| E50 | `scripts/worktree-audit.mjs` does **not** exist on master (referenced by global CLAUDE.md only) | `git ls-tree origin/master scripts/` → absent | query |
| E51 | Husky hooks are installed by the root `prepare` script (`husky`) into the checkout that ran `npm install`; a separate clone that never runs `npm install` has no hooks | root `package.json` `scripts.prepare`; `.husky/*` | code |
| E52 | `plane-denylist.json` holds the outbound-string denylist (tenant uuid, invoice number, email, connection string, jwt, `*.up.railway.app`, api-key) already used by every Plane script | `.claude/skills/plane/SKILL.md` § Denylist; `scripts/campaign/plane-denylist.json` | code |
| E53 | PR/commit trailer convention exists: `Feature: F-07`, `Bug: B661`, `Defers: D-09` (roadmap README) + `Closes #n` and the worker line (WORKFLOW.md) + `Bookkeeping-Follow-Up: pending` (stop.mjs) | README § trailer; WORKFLOW § Claiming; `stop.mjs:96-101` | code |
| E54 | `from-git.mjs` already parses those trailers from first-parent commits (`parseTrailers`, `readCommits`) — reusable as a library | `scripts/roadmap/from-git.mjs:28-30` | code |
| E55 | Repo goes public briefly for CI windows; anything on ANY branch is readable then (CLAUDE.md § deploy flow; heavy-files policy) | CLAUDE.md | code |

**Assumptions (unverified):**

| # | Assumption | What breaks if false | Cheapest check / owner |
|---|---|---|---|
| A1 | GitHub's server-side squash/merge does **not** honour `.gitattributes merge=union` (custom merge drivers) | Only matters for master-side files; the state branch is pushed directly (no PRs), so this now affects nothing in slice 1 | n/a — retained for the record |
| A2 | Windows git honours the built-in `union` driver (it is part of core git, not a hook) | `ctl` rebase of the same lane's file on the PC conflicts → the retry loop falls back to re-append on a fresh fetch (WP3) | `git merge-file --union` on the PC, 1 min |
| A3 | `fs.appendFileSync` of one line < 4,096 B with `a` flag is atomic per process on macOS/Linux; not guaranteed on Windows | Interleaved lines on the PC when two `ctl` processes append the same lane file — prevented by the lock dir in WP3 anyway | Lock dir makes this moot; keep as documented reason for the lock |
| A11 | Each Railway service is bound to the `master` branch, so pushes to `ctl/state` never build or deploy anything | A state push would trigger api/web builds — visible immediately in the Railway dashboard; fix = service branch setting | Owner reads the service "Source" settings (1 min) — batched Q8 |
| A12 | A fine-grained GitHub PAT scoped to this one repo with `Contents: read/write`, `Pull requests: read`, `Checks: read`, `Actions: read`, `Metadata: read` suffices for the poller + `ctl/state` push; a read-only deploy key (SSH) suffices for fetch | The server cannot push write-back events or cannot read checks; visible on first boot (`/api/health` reports each source) | Owner creates both at launch; the server's `/api/health` proves scopes |
| A13 | GitHub GraphQL cost of the PR query in spec §5.6 is ≤ 60 points per full run and ≤ 5 per incremental run; REST conditional `304`s do not count against the 5,000/h limit | Poll cadence must slow (the poller adapts to `X-RateLimit-Remaining` anyway) | Read `rateLimit { cost }` on the first live query (WP5) |
| A14 | Railway's public GraphQL API (`backboard.railway.com/graphql/v2`) with a project token returns `deployments` with `status` and the deployed `meta.commitHash`; `railway` CLI is installed on the owner's machines | "Deployed yes/no" falls back to the GitHub `deployment_status` events Railway already posts (E45's ci.yml comment) | Probe with one `curl` in WP5; fallback wired regardless |
| A15 | Node 24 on both machines (root `engines` `>=24`); Railway image `node:24-alpine` | `apps/control` Dockerfile mirrors api's; a lower Node breaks `fetch`/`crypto.scrypt` assumptions | `node -v` on both (10 s) |
| A16 | Railway usage for one idle 0.25-0.5 vCPU / 256-512 MB Node service ≈ $3-8 / month (Hobby plan includes $5 credit) | Cost estimate off by 2× — still small | Owner reads the Railway usage page after one week (Q9) |
| A17 | `git patch-id --stable` over a closed PR's commits vs `git log master` is an adequate "work re-landed" test; squash merges change hashes but not patch-ids of single-commit cherry-picks — multi-commit squashes need a diff-vs-master fallback (`git diff <base>..<head> \| git patch-id` compared to the squash commit's patch-id) | A salvaged PR is flagged as waste (false positive) → owner acks once | Fixture test with a squash; keep both checks (WP6) |
| A18 | The campaign-check freshness step (`--freshness-only`) does not require a `.campaign/runs/control.json` artifact for a new workspace | `npm run verify` red on the new workspace until the reporter is registered | Read `scripts/campaign-check.mjs` "artifacts" list at WP0 (2 min) |
| A4 | The owner reads the dashboard on the PC/Mac mini browsers only (Chromium/Safari current); no IE/old Edge | CSS grid / `prefers-color-scheme` unsupported | Owner confirms; default: modern browsers only |
| A5 | Lane set for slice 1 = the eight lanes in `lanes.json` seeded from E27 (`lead`, `sa`, `coordinator`, `f2`, `lane-u`, `lane-b`, `r-ui`, `s-scan`) + `owner`; a lane not listed cannot emit | A lane runs unregistered → its events fail validation until the lead adds it | Owner/lead confirms the list at launch (batched question Q2) |
| A6 | `tasks.jsonl` is written only by the lead/coordinator and the control server; lanes never mint task ids (mirrors bug-id policy) | A lane needs a task id mid-flight and has to wait for the lead | `task.proposed` events give lanes a lane-scoped provisional id; adoption by the lead mints `RF-n` (WP1) |
| A7 | The GitHub work board (E21) keeps running unchanged; `tasks.jsonl` rows may carry `issue: <n>` as a reference; no reconciliation with GitHub in slice 1 | Two sources of "what is the lane doing" (issue assignee vs event) | Slice-2 adapter reads `gh issue list --json` offline-first; batched question Q4 |
| A8 | `apps/web/playwright.native-parity.config.ts` exists on master and can be copied for a control-dashboard config | UI proof plan needs a different driver | `git ls-tree origin/master apps/web \| grep playwright` (10 s) — run in WP7 before writing the config |
| A9 | No other tracker file under `docs/` or `local-assets/` competes (E43 searched only `.claude/` + `scripts/`) | Another lane already built part of this | `git ls-tree -r --name-only origin/master \| grep -iE "lanes\|control"` at WP1 start |
| A10 | Reading + parsing 561 KB `bugs.jsonl` per render costs < 50 ms on both machines | Render feels slow; mitigation = cache by mtime | `node -e` timing at WP1 |

---

## 1. Problem, whose, cost today

**Whose:** the owner (manager + PO + CTO + dev, one person) and every lane (8-12 concurrent
Claude sessions across a PC, a Mac mini, a MacBook and cloud). Frequency: every session start
(≥ 10/day across the fleet), every landing window, every owner check-in.

**Problem (owner's words, condensed):** losing track of what each lane is doing and does next,
which features are partial, which bugs are open, what changed and why, whether two lanes collide,
and which cheap fixes sit in code a lane already has open.

**Cost today (measured, E26/E27):** to answer "what should lane X do next" a session reads a
handoff card (≤ 2 KB) **plus** the roadmap registers (57 KB) **plus** the coordination board
(#2554, unbounded comment stream, L-240) **plus** a lead relay. Order of magnitude: 60-130 KB of
input (15k-33k tokens) per orientation, and the answer still comes from the lead's memory. Status
changes cost a bookkeeping PR row edit (26 KB file read + write by the coordinator) plus a board
comment plus a handoff line — three restatements of one fact (E37's failure class).

## 2. Workaround today and why it is insufficient

Today's stack (all real, all kept): roadmap registers + `render.mjs` (E1-E6), the bug catalogue +
ledger (E9-E12), the GitHub work board with `lane:*` locks (E21), Plane mirrors (E19), handoff
cards (E22), the SA registers, `/orient` (E23). Insufficient because: (a) none of them holds
**per-lane current/next**; the lane lock on GitHub is an assignee, not a plan; (b) roadmap rows
are edited only in bookkeeping PRs, so status lags a landing by hours; (c) nothing computes
overlap or piggyback — `areas` do not exist as data (features have one `area` word, bugs have a
free-text `location`); (d) the only "what changed" view is git log + a 2,500-comment issue.

## 3. Why now

Three R1.1 waves are being cut three days apart (E3), with 8+ lanes in flight and a lead whose
release-day failures all had the shape "fact restated in a second place" (E37). The owner asked
for it in writing on 2026-09-30 (owner-request.md).

## 4. If we ship nothing

The fleet keeps working; the cost stays: ~20k tokens of orientation per session, coordinator time
per landing, and the collision/duplication risk stays invisible until a merge conflict or a
duplicated fix. Shipping nothing costs real money every day (ledger: mean $44/run, E40) but
nothing breaks — this is a tooling investment, not a defect fix. The plan is therefore sized as
one vertical slice, not a platform.

## 5. Success signal (observable, with baseline)

| Signal | Baseline (today) | Target after slice 1 | Read from |
|---|---|---|---|
| Bytes an agent reads to answer "what next for lane X" (excluding CLAUDE.md, handoff, digest — unchanged) | 57 KB registers + board (≥ 20 KB) ≈ 77 KB+ | ≤ 1.5 KB (`ctl next` output cap) | `node scripts/control/ctl.mjs next --lane <x> \| wc -c` |
| Agent tokens per status change | features.jsonl row rewrite (~1 KB) + board comment + handoff ≈ 2-3 KB across 3 places (≈ 700+ tokens, coordinator + lane) | one `npm run ctl -- done RF-231` call: ≈ 20 tokens command + ≤ 60 tokens result ≤ **150 tokens**, one place | transcript token count of the tool call (`session-usage.mjs`) |
| Status changes that need NO agent tokens (inferred) | 0 — every state change is typed by someone | PR open/ready/merged/CI/deploy/conflict, lane heartbeat, "released" — all derived from GitHub/Railway | dashboard `derived` badge count vs `reported` count on the timeline |
| Manual sync steps per landing (coordinator) | 5: roadmap row, bugs record, lessons, code-map, Plane ops (+ board comment) | 3 (lessons, code-map, Plane) — roadmap-row status + board status comment become inferred (merged PR → task advance) | count of files touched by the docs follow-up PR |
| Waste visible before it is lost | 0 (no mechanism; stranded worktrees "a recurring loss" per CLAUDE.md) | every open/closed PR and pushed branch scored by spec §5.8 rules on one panel | "At risk of waste" panel count + ack events |
| Owner time to read "now / next / broken / shipping" | unbounded (board scroll) | one screen, ≤ 3 s first read (ux-spec §2) | manual, owner |
| Collisions detected before merge | 0 (no mechanism) | every pair of active lanes with ≥ 1 shared file shown as WARN/HOT | dashboard overlap panel + `ctl overlap` |

## 6. Who else is affected

- **Lead/coordinator**: writes `tasks.jsonl` rows and adopts lane proposals (new duty replaces
  roadmap-row edits per landing). - **SA**: unchanged; rulings stay in `.claude/sa/`; tasks may
  reference `SA-###` in `notes`. - **Plane**: stays a mirror; `tasks.jsonl` does not sync to Plane
  in slice 1 (deferral row). - **CI**: `npm run verify` gains one validator + self-tests (seconds).
- **Every lane**: gains two commands (`ctl next`, `ctl done|start|block|bug`) and one obligation
  (append events in the code PR).

## 7. Is this a symptom?

Partly. The root cause of "losing track" is that status lives in prose (board comments, handoffs)
and in files only the coordinator edits. The fix IS structural data + a derived view — so the
request and the root cause coincide. What would NOT fix it: another dashboard over the same
prose. Hence the non-negotiable: events are the primary record; every panel is a fold of events +
registers, never hand-typed.

## 8. Solving the problem or building the chosen solution?

The owner chose: repo files + generated HTML + local write-back (decisions 1-4). Checked against
alternatives: (a) GitHub Projects already exists (E21) but is online-only, has no per-lane next,
no areas, and its status is derived by a 5-minute poller on one PC; (b) Plane is a mirror by
policy (E19/E20). The chosen shape is consistent with the repo's own rule that registers are the
source of truth (E20). Accepted.

## 9. Strongest objection (and answer)

**"This is a fourth tracker (roadmap, GitHub board, Plane, now control) — the exact 'fact in a
second place' failure."** Answer: the control layer **adds no second copy of any existing fact**.
Features, deferrals, releases and bugs are read through adapters from their existing files
(spec R3); the only new primary data are things that exist nowhere today — lane assignment,
current/next pointers, `areas[]`, task priority overrides — and those are recorded once, as
events. Where the layer *derives* a value that another system also holds (a bug's open/closed
state, a feature's percent), the dashboard shows the register's value and marks any event-based
override as such (spec R14). The GitHub board and Plane remain what they are; slice 2 decides
whether the board's assignee becomes a read-through too (Q4).

---

## 10. Existing mechanisms — keep / extend / fold / retire (owner addendum §2)

Baselines from E26; "after" values are the plan's targets and become acceptance criteria (spec R20).

| Mechanism | Today | Decision | Gain (quantified) |
|---|---|---|---|
| `.claude/roadmap/{features,deferred,releases}.jsonl` + README | SoT for features/deferrals/releases; bookkeeping-PR edits | **Keep** as-is; read-through into tasks; new `areas[]` and lane pointers live in control events, not here | Per-landing roadmap row edit for status removed (1 of 5 manual steps); rows still edited for description/percent in bookkeeping PRs |
| `scripts/roadmap/render.mjs` | Renders 3 HTML pages to local-assets; `--validate`, `--status` | **Extend by import**: control renderer imports `loadRegisters/computeLag/writeAtomic`; render.mjs untouched; its 3 pages stay | 0 lines duplicated; one CSS block reused (E5) |
| `.claude/campaign/bugs.jsonl` + `bugs/B###.md` + `bugs.mjs` | Catalogue, lead-minted ids, locks, `next/brief` | **Keep**; read-through (open rows → bug tasks); `ctl bug` shells out to `bugs.mjs file` for minting; `areas` derived from `location` | No rewrite of 817 rows; agents never read the 561 KB file (only `ctl` does) |
| `.claude/campaign/status/F##.jsonl` + `campaign-check.mjs` | Proof state machine per bug | **Keep, untouched**; dashboard reads `state` for bug counters ("proven-pending-deploy" bucket) | — |
| `board.json`, `sync-state.json`, `DECISIONS.md` | Plane epic/batch ids; bugs.mjs sync anchor; campaign decisions | **Keep, untouched** | — |
| Plane harness (`plane-*.mjs`, skill) | Mirrors + triage brief | **Keep** as mirror; **not** extended in slice 1; deferral row "Plane mirror of tasks/lanes" (slice 3) | Plane ops file per landing stays (1 manual step) |
| GitHub work board + `scripts/work/*` | Issues as unit of work, `lane:*` locks, reconciler | **Coexist**; `tasks.jsonl.issue` references; no writes; slice-2 read-through of assignee/status | — (Q4) |
| `.claude/handoffs/` + `/handoff` | ≤ 2 KB cards | **Extend**: `/handoff` template gains one line `- Control: <lane> · current <id> · next <id>` and runs `ctl handoff` (emits `lane.note` with the card path) | Next session reads `ctl next` (≤ 1.5 KB) instead of hunting the newest card + registers |
| `/orient` (`orient.md`) | Hand-reconstructed brief + Plane brief | **Extend**: step 9 = `node scripts/control/ctl.mjs next --lane $CTL_LANE` (≤ 30 lines); SessionStart hook prints the same | Orientation read 57 KB+ → ≤ 1.5 KB for the "what next" part (≈ 40×) |
| `closeout.mjs` (dev-pipeline) | Ledger row, RUN-LOG stub, handoff | **Extend (repo copy only)**: after the handoff card, append `task.done` if `--task <id>` given (skill-level script; owner Q6) | Status update becomes a side effect of an existing mandatory step |
| Landing coordinator (docs follow-up PR) | Edits roadmap rows, lessons, map, Plane | **Extend**: runs `ctl sync --since <sha>` which reads squash-commit trailers (`Feature:/Bug:/Task:`) and appends `task.released`/`bug.fixed` to `events/coordinator.jsonl` | 5 → 3 manual steps per landing |
| `.claude/sa/*` registers | Rulings, errors | **Keep, untouched**; tasks reference `SA-###` in notes | — |
| Code map + lessons | Per Option B | **Keep**; `scripts/control/` gets map entries in the follow-up PR | — |
| Ledger / RUN-LOG | Per pipeline law | **Keep**; this run closes out normally | — |
| `scripts/campaign/bugs.mjs render` | Derived HTML view of bugs | **Fold**: the control home page's bug counters + slice-2 bug filters supersede the need to open it; script stays | — |

**Round 2/3 deltas to the table above:** GitHub PRs/branches/checks and Railway deployments become
**sources** (read by the server, zero agent tokens; inventory row "GitHub work board" becomes
"read-through of PRs, branches, checks — the board's issues are referenced, not read, in slice 1");
handoff/orient/closeout/coordinator hooks call `ctl` which pushes to `ctl/state` (not a code-PR
line); `scripts/roadmap/render.mjs` is reused as a library by the server's adapters (same
exports); the server, not a script, renders.

Where 10× is **achieved**: read cost for "what next" (57 KB+ → ≤ 1.5 KB, ≈ 40×); agent tokens per
status change (≈ 700 → ≤ 150, and **zero** for every PR/CI/deploy/merge-driven change, which is
the majority of state changes in a day — the fleet lands 10-20 PRs on a landing day and reports
perhaps 5-10 lane events). Where it is **not**: manual steps per landing (5 → 3, because lessons,
code-map and Plane are outside this scope by owner ruling); Plane remains a mirror; a lane still
has to say when it is *blocked* and what it takes *next* — those are decisions, not facts GitHub
holds.

---

## Stage log (P0-P3 rows; full table in build-plan.md)

| Stage | Ran? | Stop condition | Fired? | Note |
|---|---|---|---|---|
| P0 Frame | yes | trivial | no | major, ui:true, 5 settled decisions |
| P1 Ground | yes | nothing verifiable | no | 44 evidence rows, 10 assumptions |
| P2 Interview | yes (batched to the final report; the planner cannot ask) | severe unanswered question | no — every open question has a default carried as A#/Q# | 7 owner questions |
| P3 Discovery | yes | no measurable signal | no | 5 signals with baselines |

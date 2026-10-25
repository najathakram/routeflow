# Test plan: Routeflow Development Control System (slice 1)

> **Stage P6 — "how we'll know".** Authored 2026-09-30 by Fable 5.1. Status: `DRAFT`.
> Written before [build-plan.md](./build-plan.md). `R#` from [spec.md](./spec.md) §9; UI
> expectations from [ux-spec.md](./ux-spec.md); evidence/assumptions from
> [discovery.md](./discovery.md) §0. Method: dev-pipeline `references/TESTING-PLAYBOOK.md`.

**Gate:** every `R#` ↔ ≥ 1 `T#`; every `T#` has an oracle and a reason it fails today.

---

## Evidence & assumptions carried into the tests

| # | Assumption | What it decides here | Check |
|---|---|---|---|
| A12 | fine-grained PAT scopes suffice | nothing here — GitHub is never called by a test (recorded fixtures only) | live probe at WP5 |
| A13 | GraphQL cost ≤ 3 points per cheap query | T51 asserts the *requested node count*, not the live cost | live `rateLimit{cost}` read at WP5 |
| A17 | patch-id compare is adequate for "re-landed" | T49 uses a real temp git repo with a squash merge | fixture is the check |
| A18 | campaign-check needs no artifact for a new workspace | T5 (verify goes green) | read `campaign-check.mjs` artifacts list at WP0 |
| E47 | Jest 30 + ts-jest 29 config shape copied from `apps/api/package.json:137-180` | every spec file below runs under `npm test -w apps/control` | `npm test -w apps/control` at WP0 with one trivial spec |

---

## 1. Strategy

New surface: a Node service + CLI with pure domain logic, three external sources (git,
GitHub, Railway), an HTML renderer, and a browser UI. The proof is layered: **unit** tests on
the pure fold/next/overlap/waste/reconcile functions with hand-derived oracles; **integration**
tests that run the real CLI and server against a **temporary git repo + bare remote** and
**recorded GitHub/Railway JSON fixtures** (no network ever); a **golden-file** test for the
renderer over the acme fixture; **property** tests (hand-rolled generators, no new library) for
fold determinism and seq monotonicity; **e2e** = one Playwright capture-and-assert run at three
viewports against the local server in fixture mode (E30 precedent, no new runner).

| Level | Used | Why |
|---|---|---|
| unit | yes | fold, transitions, next, overlap, piggyback, waste, reconcile, readiness, denylist, glob |
| property | yes | determinism (`fold(x) == fold(shuffle-files(x))`), seq/ts monotonicity, undo-inverse identity |
| contract | yes | `/api/state.json` and `/api/event` shapes; SSE event names; `ctl next` byte/line caps |
| integration | yes | CLI push loop against a bare remote; server auth/CSRF/headers; compaction; workflow-trigger parser; railway.toml isolation |
| e2e | yes (one run) | three viewports × light/dark captures + DOM assertions, `apps/web` Playwright with its own config |
| manual | yes (owner) | first live boot on Railway: `/api/health` shows every source green (T64, deliberately manual) |

**Deliberately NOT tested:** GitHub/Railway network behaviour (recorded fixtures only; the live
probe is a manual WP5 step); Node `http` internals; git itself; Prettier/ESLint output; the
exact pixel appearance (captures are evidence, assertions are DOM/state).

**Risk driving depth:** an internet-facing service with a write path (auth, CSRF, path
traversal → deep negative tests); a state branch that is public during CI windows (denylist
→ negative tests); inference that could silently mis-advance a task (reconciliation → every row
of §5.7 has its own case); a waste panel whose false positives would make the owner ignore it
(each rule tested at threshold − 1, threshold, threshold + 1).

**Characterization tests first?** No — nothing existing changes behaviour (R3).

---

## 2. Test table

Files are under `apps/control/test/` (new) unless stated. Fixture root:
`apps/control/test/fixtures/acme/` (new): `registers/{features,deferred,releases,bugs}.jsonl`
(6 features, 4 deferrals, 3 releases, 12 bugs — synthetic, `acme` names), `state/events/*.jsonl`
(lanes `lead, lane-u, r-ui, lane-b, f2, coordinator, owner`), `github/{prs.json, prs-files.json,
branches.json}` (recorded shape, synthetic content, 9 PRs), `railway/deployments.json`, and
`repo/` (a script builds a temp git repo with master + branches + a squash merge — `test/helpers/
temp-repo.ts`). Helpers: `test/helpers/{temp-repo.ts, spawn-cli.ts, start-server.ts, clock.ts}`.

| ID | proves | level | Given / When / Then | Oracle | File | Fails today because |
|---|---|---|---|---|---|---|
| T1 | R1 | unit | **G** a valid acme state dir · **W** `validateEvents` · **T** `[]` | hand-checked fixture | `test/validate.spec.ts` | module missing |
| T2 | R1 | unit | **G** each of 13 corruptions (bad JSON, unknown type, extra key, missing key, seq gap, seq dup, ts decrease, lane mismatch, unknown lane, dangling task, dangling release, `..` glob, line > 1,024 B) written one at a time · **W** validate · **T** exactly one error naming `file:line` and the reason keyword | the corruption list in spec R1 | `test/validate.spec.ts` | same |
| T3 | R1, R5 | unit | **G** events with `task.done` before any `task.started` on a `planned` task · **W** validate · **T** error `illegal transition planned→done` | §2 matrix | `test/validate.spec.ts` | same |
| T4 | R1 | unit | **G** `task.created` emitted by `lane-u` · **W** validate · **T** error `unauthorised emitter` | §1.3 (lead/owner only) | `test/validate.spec.ts` | same |
| T5 | R2 | integration | **G** a deliberately failing spec placed in `apps/control/test/` · **W** `node scripts/verify-turbo.mjs` (scoped) · **T** exit ≠ 0; remove it → exit 0 | turbo runs workspace `test` (E48/E49) | manual step recorded in WP0's brief + `test/workspace-wiring.spec.ts` asserts `package.json` has `test/lint/check-types/build` scripts | workspace missing |
| T6 | R3 | integration | **G** temp repo with registers · **W** run every `ctl` command once + 100 server ticks in fixture mode · **T** `git status --porcelain -- .claude/roadmap .claude/campaign` is empty | git | `test/registers-untouched.spec.ts` | CLI missing |
| T7 | R3 | unit | **G** adapters over fixture registers · **W** call twice · **T** input objects deep-equal before/after (adapters never mutate) | `structuredClone` compare | `test/adapters.spec.ts` | same |
| T8 | R4 | property | **G** fixture events; 50 random permutations of *file read order* and of lines *within equal ts* · **W** fold · **T** `sha256(canonical(state))` identical | total order `(ts, lane, seq)` | `test/fold.spec.ts` | same |
| T9 | R4 | unit | **G** an event targeting `RF-999` (unknown) · **W** fold · **T** `warnings[0] = {lane:"lane-u", seq:3, reason:/unknown task/}`; task map unchanged | spec §4 | `test/fold.spec.ts` | same |
| T10 | R5 | unit | **G** every cell of the §2 matrix (8 states × 8 events = 64 cases, table-driven) · **W** `transition(from, event)` · **T** ✓ → new status, ✗ → `null` | the matrix, typed as data in the test (not read from the implementation) | `test/transitions.spec.ts` | same |
| T11 | R5, R9 | integration | **G** temp remote; task RF-1 `planned` · **W** `ctl done RF-1` · **T** exit 3, stderr names the transition, remote branch tip unchanged | git rev-parse before/after | `test/cli.spec.ts` | same |
| T12 | R6 | unit | **G** 9 tasks with mixed priority/release/impact/effort/importance + one `task.next` · **W** `nextEligible("lane-u")` · **T** exact ordered ids `[RF-7 (explicit), RF-2, RF-5, RF-9, RF-1]` (derivation in §2.1); held: `RF-4 blocked by RF-2` | hand-sorted per §5.1 | `test/next.spec.ts` | same |
| T13 | R6 | unit | **G** release `R-old` shipped; RF-3 in it · **W** next · **T** RF-3 absent; RF-6 assigned to `r-ui` absent for `lane-u`; RF-8 `reconsider` absent | §5.1 | `test/next.spec.ts` | same |
| T14 | R7 | unit | **G** file list of 40 synthetic paths; lane A areas `apps/api/src/invoices/**`, B `apps/api/src/invoices/invoice-pdf.ts` + `apps/web/app/(dashboard)/invoices/**` · **W** overlap · **T** `{shared: 1, coef: 1/1 = 1.0, level: "HOT"? no: shared 1 < 3 → WARN}` — expected `WARN`, symmetric, `source: declared` | hand count | `test/overlap.spec.ts` | same |
| T15 | R7 | unit | **G** A has an open PR with 6 files, 3 inside B's 4-file set · **W** overlap · **T** `shared 3, coef 0.75, HOT, source: diff`; B with `areas: []` and no PR → no pair | §5.2 | `test/overlap.spec.ts` | same |
| T16 | R8 | unit | **G** lane L files = 10; candidates: c1 (2 files, both in L → score 1.0), c2 (4 files, 1 in → .25), c3 (S effort, 1/1 → 1.0, sensitive) , c4 assigned elsewhere · **W** piggyback · **T** `[c1, c3(last, tagged)]`, header count 1 | hand scores | `test/piggyback.spec.ts` | same |
| T17 | R8 | unit | **G** 12 candidates all score 1 · **W** piggyback · **T** length 8, sorted priority then id | cap + sort | `test/piggyback.spec.ts` | same |
| T18 | R9, R20 | integration | **G** temp bare remote + clone, lane `lane-u` at seq 4 · **W** `ctl start RF-1 --note "x"` · **T** exit 0; remote file gains exactly one line, `seq 5`, `ts` within ±5 s of the pinned clock, `sha` = short HEAD of the *working* repo, byte length ≤ 240; stdout ≤ 200 B | git show on the remote | `test/cli.spec.ts` | same |
| T19 | R9 | integration | **G** no `CTL_LANE`, no `--lane` · **W** `ctl start RF-1` · **T** exit 2, remote unchanged; `--lane nope` → exit 2 | spec | `test/cli.spec.ts` | same |
| T20 | R9 | integration | **G** remote rejects pushes 6 times (pre-receive hook `exit 1`) · **W** `ctl note "x"` · **T** exit 5; `pending/lane-u.jsonl` has the line; next `ctl note "y"` with hook removed pushes **both** lines (seq n+1, n+2) | spec §7 | `test/cli.spec.ts` | same |
| T21 | R10, R20 | contract | **G** acme state (current with merged PR nudge, blocker, 5 eligible, 2 overlaps) · **W** `ctl next --lane lane-u` · **T** ≤ 30 lines, ≤ 1,536 B, contains `current RF-1`, `nudge: #2801 merged`, `★ RF-7`, five eligible lines, `overlap ▲ r-ui`, exit 0 | line/byte count | `test/cli-next.spec.ts` | same |
| T22 | R10 | integration | **G** a corrupt events file · **W** `ctl next` · **T** exit 0, stdout exactly one line starting `control: INVALID` | spec | `test/cli-next.spec.ts` | same |
| T23 | R11 | integration | **G** two `ctl note` processes started within 10 ms on the same lane and clone · **W** both finish · **T** remote has seq n+1 and n+2, no duplicate, each line parses; then two *separate clones* (two "machines") race → same result via rebase retry | git | `test/cli-concurrency.spec.ts` | same |
| T24 | R12 | unit | **G** acme folded state · **W** `renderPage(state)` twice · **T** identical strings; no `http://`/`https://` in `src=`/`href=` except same-origin `/`; `<meta name="control-version">` present; byte length ≤ 400 KB with a generated 817-bug + 100-PR state | string checks | `test/render.spec.ts` | same |
| T25 | R12 | unit | **G** a task title containing `<script>alert(1)</script>` and `"` · **W** render · **T** escaped (`&lt;script&gt;`), no raw `<script>` outside the one inline client script block | escape table | `test/render.spec.ts` | same |
| T26 | R13 | golden | **G** acme state at pinned clock `2026-01-12T10:00:00Z` · **W** render · **T** equals `test/fixtures/acme/golden/index.html` byte-for-byte; `UPDATE_GOLDEN=1` rewrites and the diff is reviewed | golden reviewed by a human once against ux-spec §3 | `test/render.golden.spec.ts` | same |
| T27 | R14 | unit | **G** feature F-2 register `release R1`, event `task.release R1→R2` · **W** render · **T** the release cell shows `R2` with `overridden · owner#3` and `title="register: R1"`; a bug with `Bug: B905` merged but register open shows `register lag` | spec §3/§5.7 | `test/render.spec.ts` | same |
| T28 | R15 | integration | **G** `CONTROL_LOCAL=1`, fixture mode · **W** start server · **T** listens on `127.0.0.1` only (connect via `0.0.0.0`/LAN IP refused), `/api/health` JSON lists sources; SIGTERM → exit 0 < 5 s; without `CONTROL_PASSWORD` in non-local mode → exit 1 naming the var | spec §6 | `test/server.spec.ts` | same |
| T29 | R16 | integration | **G** logged-in session · **W** valid `POST /api/event` `{type:"task.priority", task:"RF-1", priority:"P1", prev:"P2", expectedVersion}` · **T** 200 `{seq, version}`; `events/owner.jsonl` on the remote gains one line; state version changed; SSE emitted | spec | `test/server-write.spec.ts` | same |
| T30 | R13, R18, R33, R34 | e2e | **G** local server in fixture mode (light, then dark via `colorScheme`) · **W** Playwright at 1440/768/390 · **T** for each: no console errors, no network failures, `document.documentElement.scrollWidth <= innerWidth`, every §3 panel heading present, header has exactly ≤ 1 colored word per line, drawer opens on `RF-1` and `Esc` closes it restoring focus, a write with the server's `FAIL_NEXT_WRITE=1` shows the old value + inline error, 409 mode reloads; captures saved to `local-assets/proofs/<date>/control/<vp>-<scheme>.png` | ux-spec §4-6 | `apps/web/e2e/control/control.capture.spec.ts` + `apps/web/playwright.control.config.ts` (new) | spec files missing |
| T31 | R16 | integration | **W** POST without cookie · **T** 401, nothing appended | | `test/server-write.spec.ts` | same |
| T32 | R16 | integration | **W** POST with cookie but `Origin: https://evil.example` / missing `X-Control-Token` / wrong token / `text/plain` / 17 KB body / `type: task.started` (not owner-allowed) / stale `expectedVersion` · **T** 403 / 403 / 403 / 415 / 413 / 422 / 409 respectively; remote tip unchanged in every case | spec §6 | `test/server-write.spec.ts` | same |
| T33 | R17 | integration | **W** `GET /../../etc/passwd`, `GET /events/lane-u.jsonl`, `POST /api/event` with `lane: "../x"`, `task: "RF-1; rm"` · **T** 404 / 404 / 422 / 422; no child process spawned with those strings (spy on the git wrapper) | spec R17 | `test/server-security.spec.ts` | same |
| T34 | R18 | integration | **G** T29 applied · **W** POST the compensating event `{priority:"P2", prev:"P1"}` · **T** task priority back to `P2`, timeline shows both, `history.length == 2` | spec | `test/server-write.spec.ts` | same |
| T35 | R19 | integration | **W** read `CLAUDE.md` and `.claude/roadmap/README.md` · **T** each contains the exact paragraph from spec §8 (test reads the paragraph from `spec.md`? no — L-206: read from `.claude/control/README.md`, the canonical copy, and assert both files contain it verbatim) | L-206 | `test/rule-text.spec.ts` | text missing |
| T36 | R19 | integration | **G** disposable git repo with `.claude/code-map/_meta.json` + `.claude/lessons/LESSONS.md` and a changed `apps/control/src/x.ts` **plus** the trailer; and separately only a changed `docs/x.md` · **W** `node .claude/hooks/stop.mjs` · **T** exit 0 both (Gates 2/3 unaffected by control paths; same harness shape as `stop.gates.spec.mjs`) | E13 | `test/stop-gates-unaffected.spec.ts` | n/a — passes today too → **vacuous**; kept only as a regression pin, marked in §3 |
| T37 | R20 | contract | **W** `ctl show RF-1` · **T** ≤ 1,024 B, includes title, status, priority, release, areas, PR facts | spec R20 | `test/cli-next.spec.ts` | same |
| T38 | R21 | integration | **W** GET `/` without cookie · **T** 302 → `/login`; `/robots.txt` 200 `Disallow: /` and no cookie needed; every response has `X-Robots-Tag`, `Cache-Control: no-store`, CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` | spec §6 headers | `test/server-auth.spec.ts` | same |
| T39 | R21 | integration | **W** `POST /login` wrong password ×5 then a 6th · **T** 401 ×5, 429 on the 6th (≥ 2 s later), a correct password on the 7th within 15 min still 429; log lines contain no password | spec | `test/server-auth.spec.ts` | same |
| T40 | R21 | integration | **W** correct login · **T** `Set-Cookie` has `HttpOnly; Secure; SameSite=Strict; Path=/`; payload `exp − iat == 12 h`; tampering one char → 401; `POST /logout` clears | spec | `test/server-auth.spec.ts` | same |
| T41 | R21 | integration | **G** `CONTROL_LOCAL=1` · **T** `/` is 200 without cookie; bind is loopback (T28) | spec | `test/server-auth.spec.ts` | same |
| T42 | R22 | unit | **G** recorded `prs.json` (9 PRs) · **W** `normalizePRs` · **T** ledger rows match a hand-written expected array (state, ci, review, mergeable, links, lane, files, areas) | fixture + spec §5.5 | `test/prs.spec.ts` | same |
| T43 | R22 | unit | **G** PR body trailers `Task: RF-2` + branch `fix/B905-x` · **T** links `{task: RF-2, bug: B905}`; body `Lane: r-ui` beats task lane; no trailer + task started by `lane-u` → lane `lane-u`; neither → `unattributed` | §5.4 precedence | `test/prs.spec.ts` | same |
| T44 | R22 | unit | **G** PR #7 merged (`mergeCommit` m1) linking RF-2 `in-progress` · **W** fold with inference · **T** RF-2 `code-complete`, `source: inferred`, timeline `inferred from #7`; no line written | §5.7 row 2 | `test/reconcile.spec.ts` | same |
| T45 | R22 | integration | **G** temp repo where m1 is an ancestor of the api deploy commit but not web's · **W** fold · **T** RF-2 stays `code-complete`, `deployed: {api: true, web: false}`; when both → `released` | `git merge-base --is-ancestor` | `test/reconcile.spec.ts` | same |
| T46 | R22 | unit | **G** reported `task.done RF-3` with no linked PR · **T** status `code-complete`, `verified: false` (badge `unverified`); reported `in-progress` while PR merged → inferred wins + nudge in `ctl next` | §5.7 rows 2, 4 | `test/reconcile.spec.ts` | same |
| T47 | R22 | unit | **G** lane last event 30 h ago, last push on its attributed branch 2 h ago · **T** heartbeat = push time, not stale; no push + 80 h → `silent` | §5.7 row 5 | `test/reconcile.spec.ts` | same |
| T48 | R23 | unit | **G** for each rule W1-W4, W6-W10: fixtures at threshold−1, threshold, threshold+1 (clock pinned) · **T** fires only at ≥ threshold; item has `key, why, action` | §5.8 table | `test/waste.spec.ts` | same |
| T49 | R23 | integration | **G** temp repo: PR-A closed, its commit cherry-picked to master (same patch-id) → not waste; PR-B closed, 2 commits squashed onto master → not waste (range patch-id); PR-C closed, nothing landed → W5; PR-C + `pr.superseded` → not waste | git patch-id | `test/waste-relanded.spec.ts` | same |
| T50 | R23 | unit | **G** W4 item `key` acked with `until: +1 d` · **T** hidden; clock past `until` → visible; head sha changes → visible even before `until` | §5.8 | `test/waste.spec.ts` | same |
| T51 | R24 | unit | **W** build the cheap query and the per-PR query · **T** cheap query requests ≤ 40 PRs and no `files`; per-PR requests `files(first:100)`; no other connection > 100 | node-count arithmetic | `test/github-budget.spec.ts` | same |
| T52 | R24 | unit | **G** poller state with `remaining` 1,400 / 400 · **T** next interval 60 s / 300 s; a REST branches call carries `If-None-Match` from the last ETag; a 304 keeps the cached list | spec §5.6 | `test/github-budget.spec.ts` | same |
| T53 | R24 | integration | **W** `POST /api/github-webhook` with a valid HMAC → 202 and a refresh scheduled; invalid → 401 and no refresh (spy) | HMAC computed in the test | `test/server-webhook.spec.ts` | same |
| T54 | R25 | integration | **G** two `EventSource` clients · **W** an owner write · **T** each receives one `event: version` within 1 s; a `ping` arrives within 30 s; response has `retry: 5000` | spec §6 | `test/server-sse.spec.ts` | same |
| T55 | R26, R32 | integration | **G** temp state repo with 2 MB of events · **W** `ctl compact` · **T** `snapshot.json` written; segments moved to `ctl/archive`; `fold(snapshot + segments)` deep-equals `fold(all)`; `ctl/state` tip tree ≤ 512 KB; `git clone --depth=1` transfers ≤ 1 MB (`git count-objects -vH` on the clone) | git | `test/compact.spec.ts` | same |
| T56 | R27 | unit | **W** parse `apps/control/railway.toml` and `package.json` · **T** `watchPatterns == ["apps/control/**"]`; no dependency key starts with `@routeflow/` | files | `test/railway-isolation.spec.ts` | files missing |
| T57 | R28 | unit | **W** parse every `.github/workflows/*.yml` `on:` block (simple YAML reader for `on`) · **T** no `push` key, or `push.branches-ignore` includes a glob matching `ctl/state` | E45 | `test/workflow-triggers.spec.ts` | n/a today (no `push` triggers) → **passes today**: kept as the guard that pins E45; noted in §3 |
| T58 | R29 | integration | **W** `ctl note "tenant 3f2a…-uuid"` / `"a@b.co"` / `"https://x"` · **T** exit 4 each, remote unchanged; server POST with the same in `why` → 422 | denylist patterns from `plane-denylist.json` read at test time (L-206) | `test/denylist.spec.ts` | same |
| T59 | R30 | unit | **W** grep `apps/control/**` (excluding node_modules/dist) with the denylist patterns + `/routeflow[a-z-]*-production\.up\.railway/` · **T** 0 hits | patterns file | `test/no-client-data.spec.ts` | passes today (no files) — becomes meaningful once fixtures exist; noted |
| T60 | R31 | integration | **W** read `.claude/commands/orient.md`, `.claude/commands/handoff.md`, `.claude/settings.json`, `.claude/skills/dev-pipeline/scripts/closeout.mjs` · **T** orient has a step invoking `ctl -- next`; handoff template has `- Control:`; settings SessionStart includes the `ctl` command; closeout parses `--task` | text | `test/hooks-wiring.spec.ts` | text missing |
| T61 | R33 | unit | **G** state with `sources.github.lastOk` 11 min old, warnings 3, empty lanes · **W** render · **T** red banner text, warnings banner lists `lane-b#14`, lane panel shows its empty copy | ux-spec §5 | `test/render-states.spec.ts` | same |
| T62 | R34 | unit | **G** every fg/bg pair in `styles.css` custom properties (parsed), light and dark · **W** WCAG contrast (formula implemented in the test, ≤ 20 lines) · **T** text pairs ≥ 4.5, pill pairs ≥ 3.0 | WCAG 2.1 relative luminance formula | `test/contrast.spec.ts` | CSS missing |
| T63 | R35 | contract | **W** `ctl overlap`, `ctl piggyback --lane lane-u`, `ctl waste` · **T** each ≤ 40 lines, exit 0 | spec | `test/cli-next.spec.ts` | same |
| T64 | manual | manual | **G** first Railway boot with real env · **W** open `/api/health` · **T** every source `ok`, rate-limit remaining shown, one lane event appears within 60 s of `ctl note` | owner | runbook step in build-plan §UI verification | — |

### 2.1 Expanded case — T12 oracle (hand-derived order)

Tasks (all `planned`, `lane` null unless stated): RF-1 P1 R1.1c impact none M imp 3 · RF-2 P0 R2 · RF-3 P1 R-old(shipped) · RF-4 P0 R1.1c dependsOn RF-2 · RF-5 P1 R1.1c impact high S · RF-6 P1 assigned r-ui · RF-7 P3 (explicit `task.next`) · RF-8 P2 `reconsider` · RF-9 P1 R1.1c impact none S imp 3.
Eligible: 1, 2, 5, 7, 9 (4 held by RF-2; 3 shipped; 6 other lane; 8 reconsider). Sort: P0 → RF-2;
P1 → R1.1c ships before R2's? (RF-2 is P0 so first regardless); among P1 in R1.1c: impact high
first → RF-5; then RF-1 vs RF-9 tie on impact/none → effort S < M → RF-9 before RF-1; RF-7 P3 last
by sort but **explicit next goes first**. Result `[RF-7, RF-2, RF-5, RF-9, RF-1]`; held `RF-4 ← RF-2`.
(The T12 row above lists the same set; this expansion is the authoritative order.)

---

## 3. Coverage matrix

| R# | Short | Pri | Covered by | Deepest |
|---|---|---|---|---|
| R1 | validator | must | T1-T4 | unit |
| R2 | verify wiring | must | T5 | integration |
| R3 | registers untouched | must | T6, T7 | integration |
| R4 | fold determinism | must | T8, T9 | property |
| R5 | transitions | must | T10, T11 | integration |
| R6 | next | must | T12, T13 | unit |
| R7 | overlap | must | T14, T15 | unit |
| R8 | piggyback | must | T16, T17 | unit |
| R9 | ctl append+push | must | T18-T20, T23 | integration |
| R10 | ctl next caps | must | T21, T22 | contract |
| R11 | concurrency | must | T23 | integration |
| R12 | renderer | must | T24, T25 | unit |
| R13 | panels | must | T26, T30 | e2e |
| R14 | badges | must | T27 | unit |
| R15 | server boot/health | must | T28 | integration |
| R16 | write-back guards | must | T29, T31, T32, T34 | integration |
| R17 | no path from input | must | T33 | integration |
| R18 | undo/failure | must | T34, T30 | e2e |
| R19 | rule text/gates | must | T35, T36 | integration |
| R20 | token cost | must | T18, T21, T37 | contract |
| R21 | auth/headers | must | T38-T41 | integration |
| R22 | inference/reconcile | must | T42-T47 | integration |
| R23 | waste rules | must | T48-T50 | integration |
| R24 | poll budget/webhook | must | T51-T53 | integration |
| R25 | SSE | must | T54 | integration |
| R26 | compaction | must | T55 | integration |
| R27 | railway isolation | must | T56 | unit |
| R28 | no workflow on state push | must | T57 | unit |
| R29 | denylist | must | T58 | integration |
| R30 | synthetic data | must | T59 | unit |
| R31 | hooks wiring | should | T60 | integration |
| R32 | tip size | should | T55 | integration |
| R33 | states | should | T30, T61 | e2e |
| R34 | responsive/a11y/contrast | should | T30, T62 | e2e |
| R35 | text panels | could | T63 | contract |

**Reverse check** — every T# names an R# (table above). Three tests would pass today and are kept
as pins, stated honestly: **T36** (Gates unaffected — pins E14), **T57** (no `push` triggers —
pins E45; it will fail the day someone adds one without `branches-ignore`), **T59** (no client
data — meaningful once fixtures exist). They are not counted toward the red gate.

**Deliberately untested:** T64 is manual (live sources) — compensating control: `/api/health`
plus the owner's first-boot runbook; accepted by the planner, owner to confirm (Q10).

---

## 4. Negative tests (what must NOT happen)

| ID | Must NOT happen | Level | Assertion | File |
|---|---|---|---|---|
| T31/T32 | unauthenticated or cross-origin write | integration | 401/403, remote tip unchanged | server-write |
| T33 | request value reaches fs/git | integration | 404/422, git wrapper spy never sees it | server-security |
| T11 | illegal transition written | integration | exit 3, tip unchanged | cli |
| T19 | event without a registered lane | integration | exit 2 | cli |
| T58 | client-identifying string written to the state branch | integration | exit 4 / 422 | denylist |
| T6 | any register on master modified | integration | clean `git status` | registers-untouched |
| T46 | inference overrides a lane decision (blocked/next/priority) | unit | reported wins for those fields | reconcile |
| T50 | an acked waste item re-nags before its sha changes | unit | hidden | waste |
| T23 | duplicate `seq` under concurrency | integration | n+1, n+2 | cli-concurrency |

## 5. Property-based invariants (hand-rolled generators; no new library)

Touched: dates (ts ordering), permissions (emitter rules). Money: none.

| ID | Invariant | Generator | File |
|---|---|---|---|
| T8 | fold is order-independent for equal-`ts` lines across lanes and for file read order | 50 shuffles of the acme events | fold.spec |
| T8b | `fold(events) == fold(compact(events))` for random cut points | 20 random compaction points | compact.spec (shares T55 harness) |
| T34b | applying an owner event then its compensating inverse leaves `task` fields equal to before (history length +2) | random `priority`/`release` pairs from the enums | server-write.spec |
| T23 | for any interleaving of k appenders, seqs are `n+1..n+k` exactly once | k ∈ {2,3} | cli-concurrency.spec |

## 6. Red gate

```bash
# from the repo root, after WP0 created the workspace (specs exist, implementation does not)
npm test -w apps/control -- --testPathPattern 'test/'
```
Every spec guards its import (`let mod; try { mod = await import("../src/...") } catch {}` then
`expect(mod).toBeDefined()` as the first assertion) so a missing module fails on an **assertion**,
not an import error. Expected failures: `expected defined, received undefined` (T1-T29, T31-T35,
T37-T56, T58, T60-T63), `expected 0 to be … ` (T5 wiring). T30 (Playwright) is excluded from the
red gate (it needs the server) and runs in the UI-verify task; T36/T57/T59 are pins that pass
today and are excluded from the gate by name.

## 7. Fixtures and helpers (all new, all synthetic)

- `apps/control/test/fixtures/acme/` as listed in §2; bug titles like "acme: invoice PDF date
  misaligned"; lanes named as in spec §1.1; PR titles synthetic; no URLs to any real host.
- `test/helpers/temp-repo.ts`: `makeRepo({branches, squash})` → `{dir, bare}` using
  `child_process.execFileSync("git", …)`; identity `ctl-test <ctl@routeflow.local>`; returns
  paths under `os.tmpdir()`; cleaned in `afterAll` (mirrors render.self-test's mkdtemp sweep, E7).
- `test/helpers/clock.ts`: `CONTROL_NOW` env pin honoured by every `now()` call (same idea as
  `ROADMAP_NOW`, E7).
- `test/helpers/start-server.ts`: spawns `node dist/main.js` (after `tsc`) with
  `CONTROL_LOCAL=1 CONTROL_FIXTURE=<acme> CONTROL_STATE_REMOTE=<bare>`; waits for `/api/health`.

## 8. UI verification (T30) — flows and assertions

- **URL** `http://127.0.0.1:4317/` · **start** `CONTROL_LOCAL=1 CONTROL_FIXTURE=apps/control/test/fixtures/acme node apps/control/dist/main.js`
- **Viewports** 1440×900, 768×1024, 390×844 × `colorScheme` light/dark.
- **Flows**: (1) load → all 12 panel headings present, no console errors, no horizontal
  overflow; (2) click `RF-1` → drawer open, `Esc` → closed, focus back on the link; (3) change
  priority in the drawer → value updates only after the response; toast with Undo; click Undo →
  value restored; (4) `FAIL_NEXT_WRITE=1` → inline error, old value; (5) `CONFLICT_NEXT_WRITE=1`
  → reload toast; (6) header lines: ≤ 1 element with a status color class per line; (7)
  capture PNG per viewport/scheme to `local-assets/proofs/<date>/control/`.
- **Checks**: `console-errors`, `network-failures`, `a11y` (landmarks, one h1, labelled
  controls, focus ring visible on Tab), `design-system` (tokens from ux-spec §1 only).

## 9. Target files summary (new)

`apps/control/test/*.spec.ts` (≈ 26 files listed above), `apps/control/test/fixtures/acme/**`,
`apps/control/test/helpers/*.ts`, `apps/web/e2e/control/control.capture.spec.ts`,
`apps/web/playwright.control.config.ts`.

# Discovery — why F-22 "Tracking engine: registers, gates and auto-published views"

**Status:** `DRAFT` (DRAFT | APPROVED | IMPLEMENTED | CLOSED)
**Stage:** S1 — Discovery (why) · **Author:** Fable 5.1 · **Date:** 2026-09-24
**Lives at:** `.claude/pipeline/2026-09-24-f22-tracking-engine/discovery.md`
**Next:** [spec.md](./spec.md) — do not start it until the STOP GATE at the bottom passes.

> **This file is the only context downstream agents receive about _why_ this work exists.**
> No chat history, no ticket, no link is read for them. If a fact matters, write it here in
> full. `TBD` is a blocker, not a placeholder — chase it or record the assumption you made
> in §12 instead.

_Citations below are in the `G#·Q#` form used by gates G1, G2 and G3 of
`references/ARCHITECT-QUESTIONS.md` in the dev-pipeline skill folder._

**Risk class:** LOW — internal tooling only. No app code, no schema, no money, no tenancy, no PII.
Every artifact this feature writes is either gitignored (`local-assets/roadmap/`) or lands
through a bookkeeping PR a human opens.

---

## 1. The problem, in the requester's own words (G1·Q1)

> "Keeps the roadmap registers self-updating: a validate gate, commit trailers, and scheduled
> renders that publish to Plane and brief every new session."
>
> "Registers in the repo are the single source of truth; a validate gate in verify refuses
> inconsistent registers; commit/PR trailers (Feature:/Bug:/Defers:) let the tracker be computed
> from git; a post-merge hook and an hourly scheduled job render the three pages, publish them to
> Plane Pages via plane-docs.mjs, run plane:sync/triage and write a lag report; the SessionStart
> hook prints roadmap state and whether the artifacts are stale so any session on any account
> republishes with one call."
>
> — the F-22 row in `.claude/roadmap/features.jsonl` (`description` and `notes`, verbatim).

**Restated in our words:** The three roadmap registers (`.claude/roadmap/features.jsonl`,
`deferred.jsonl`, `releases.jsonl`) are the plan of record, but today nothing keeps them honest or
keeps their published views current. Inconsistent rows are only caught if someone remembers to
run the validator; the `prs[]` and progress fields are typed by hand from memory of what merged;
the rendered HTML sits on whichever machine last ran the renderer (this Mac's copy is already two
days behind the registers on `origin/master`); nothing publishes it anywhere shared; and a fresh
session has no idea any of this is stale. The ask is: make the validator a gate nobody can skip,
let git tell us which PRs belong to which row, render + publish on a schedule so a shared copy is
never more than an hour behind, and tell every new session whether it is looking at stale state
and how to fix it in one command.

**Source:** the owner / Lead lane, written into the roadmap register on 2026-09-22 (commit
`c73b0897`, PR #1214) when the registers themselves were created. The requirements source is
`.claude/roadmap/README.md` plus the F-22 row. (Note: the pipeline brief referred to
`scripts/roadmap/README.md`; that path does not exist — `scripts/roadmap/` holds only
`render.mjs`. The README lives at `.claude/roadmap/README.md`.)

## 2. Who has this problem (G1·Q1)

| Role                                         | How often they hit it                                                   | What it costs them today (time / money / errors / risk)                                                                                                                                                                                           | How we know (evidence, not guess)                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing coordinator (Lead lane)              | Every landing — 96 commits on `origin/master` in the 2 days since 09-22 | Hand-edits `prs[]`, `status`, `percentDone` from memory in the docs follow-up PR; a missed PR number is invisible until someone reads the tracker. 3 `docs(roadmap)` bookkeeping commits so far (#1214, #1220, #1228). (A2)                       | `git log origin/master --format=%s \| grep -c '^docs(roadmap)'` = 3; `.claude/roadmap/README.md` "Who edits these files"                                                                    |
| Owner (reads the tracker / LAG)              | Daily, and at each go/no-go (R1.1 go/no-go is 2026-09-25)               | Reads a render that may be stale, on a machine that may be unreachable (the PC holds the roadmap work; it is unreachable from this Mac today). No shared copy exists anywhere.                                                                    | `local-assets/roadmap/tracker.html` on this Mac: mtime 2026-09-22T09:41Z; newest register commit on `origin/master`: `40e2477d` 2026-09-22T15:26Z. Context pack: "The PC … is unreachable." |
| Any Claude session, any account, any machine | Every session start (several per day across the fleet)                  | Starts with no roadmap context; only the Plane _bug_ triage brief prints. Must rediscover render/validate commands by reading the README. Risk: plans against a stale LAG list.                                                                   | `.claude/settings.json` `hooks.SessionStart` has exactly one element: `node scripts/campaign/plane-triage.mjs --brief` (bug tracker only)                                                   |
| Whoever writes commits/PRs                   | Every PR                                                                | The trailer convention exists in the README but nothing reads it, so nobody writes it: **1 of 96** commits on `origin/master` since the convention landed carries any `Feature:`/`Bug:`/`Defers:` trailer (78/96 carry `Bookkeeping-Follow-Up:`). | `git log <c73b0897>..origin/master --format=%B`, counted per commit                                                                                                                         |

_This is not one person once a month: the coordinator row fires on every landing and the
session row on every session start. But the "computed from git" row rests on a signal that is
currently ~1% present — see §8._

## 3. What they do instead today (G1·Q2)

- **Current workaround:** the coordinator runs `node scripts/roadmap/render.mjs --validate` by
  hand if they remember, hand-types `prs[]`/`percentDone`/`status` into the JSONL in the docs
  follow-up PR, re-renders to `local-assets/roadmap/` on their own machine, and reads the HTML
  locally. Publishing: none. Session briefing: none (only the bug triage brief prints).
- **Why it fails:** validation is optional so an inconsistent row can merge (nothing in
  `npm run verify` runs it — confirmed by reading the `verify` script in `package.json`); the
  hand-typed `prs[]` has no cross-check against git; the render is machine-local and already stale
  on this machine; a new session cannot tell.
- **Cost of the workaround:** a bookkeeping edit per landing, the whole tracker unavailable when
  the PC is off/unreachable (true today), and an unknown number of `prs[]` omissions (unmeasured —
  A2).

## 4. Why now (G1·Q3)

Three concrete triggers, all this week:

1. **The registers were created 2026-09-22** (#1214) with the trailer convention written into the
   README — and two days later the trailer is on 1 of 96 commits. The convention is dying before
   it starts because nothing consumes it.
2. **The PC is unreachable and holds the only up-to-date roadmap work** (context pack). A published
   copy would have made that a non-event.
3. **R1.1 go/no-go is tomorrow, 2026-09-25, and R2's cut date is today, 2026-09-24** — the LAG
   list is exactly what the owner needs to read at those two moments, and it lives in a stale
   local HTML file. Computed from the registers with the renderer's own rule today: **9 of 22
   features are already past their target** (F-01–F-08, F-10; 0 deferrals past `revisitBy`), and
   the render on this Mac still shows the 09-22 picture.

**Deadline / external date, if any:** none hard. The F-22 row's own `targetDate` is today
(2026-09-24) with `status: planned`, `percentDone: 0` — it will be a LAG entry tomorrow. See
**Finding F-1** in §11.

## 5. If we ship nothing (G1·Q4)

Honest answer: **moderately bad, and compounding.** Nobody loses money and no customer notices.
But the register-as-source-of-truth idea (README: "If Plane and this register disagree, this
register wins") quietly fails: the register drifts from git (`prs[]` typed by hand), the trailer
convention stays at ~1% and becomes dead text, the tracker is only readable on one machine, and
each session re-derives the state. The cost is paid every landing and every session start, in
small unmeasured slices, and grows with the fleet. The go/no-go decisions on 09-25 and 09-30 get
made from whatever HTML somebody last rendered.

Not "not much" — proceed. But the ask is bigger than its value in one place: see §8 and §10 for
what to shrink.

## 6. Success signal — one, observable (G1·Q5)

| Signal                                                                                                                                                                                                                                        | Today's baseline                                                                                                                                                                                                   | Target                                                                              | Where it is measured                                                                                                           | When we check                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Age of the published roadmap copy** relative to the registers on `origin/master`: the publish stamp's `registersHash` equals the hash of the three JSONL files at `origin/master` and its `day` is today, when spot-checked at random hours | **No published copy exists** (age = ∞). Nearest proxy — this Mac's local render — is 2 days behind: rendered 2026-09-22T09:41Z, registers changed 2026-09-22T15:26Z (`40e2477d`), and its LAG list is dated 09-22. | Published copy ≤ 1 hour + 1 render behind `origin/master`, on ≥ 9 of 10 spot checks | `npm run roadmap:status` output on the publishing machine (`Roadmap publish: fresh …` / `STALE …`), plus the Plane page itself | 10 spot checks spread over the 2 weeks after the job is installed |

_One signal. The SessionStart line and the git-trailer report are means to this end, not
signals of their own; their own tests prove they work._

## 7. Everyone else affected that nobody asked (G1·Q6)

| Party                                                                                        | How this touches them                                                                                                                                                                             | What they need from us                                                                                                                                   | Consulted?                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Every Claude session on every machine/account                                                | 3–5 more lines print at session start; `npm run verify` gains one validator + one self-test (both sub-second, no network)                                                                         | The lines must never block, never need network, never exceed a small byte cap; the gate must be fast and deterministic                                   | no — designed for in §9/spec     |
| F-09 owner (Lead, PC) — the Plane bug-sync harness                                           | F-22 imports `scripts/campaign/plane-client.mjs` and runs `plane-sync.mjs`/`plane-triage.mjs` from its hourly job; shares the write ledger, rate window, denylist and `runs.jsonl` telemetry      | F-22 never edits F-09's scripts; it consumes them. The hourly job must stay inside the existing write budget knobs (`syncMaxWrites`, `clientRatePerMin`) | no — flagged in spec §6 overlap  |
| D-15 "Plane cycle setup and nightly sync" (open, revisitBy **today** 2026-09-24, owner Lead) | F-22's hourly job _subsumes_ the nightly `plane:sync` half of D-15 (an hourly `plane-sync.mjs --if-digest-changed` no-ops when nothing changed). The "add the Release 1 cycle" half is untouched. | A decision: fold D-15's sync half into F-22 and leave the cycle-setup half as the D-15 remainder — or keep them separate. Recommend fold.                | no — **open question Q3**        |
| The Plane workspace (BUGS/ROAD/OPS/DECIDE/CLIENT)                                            | Gains either Pages (unconfirmed API) or one pinned ROAD work item holding the tracker. Ledgered writes, ≤ 3 per run.                                                                              | Denylist scan over every rendered byte before it leaves the machine (the roadmap registers are `"public":false`-gated per row already)                   | n/a — machine, not a person      |
| Whoever installs the hourly job (owner, on the PC)                                           | A machine-local scheduled task (same mechanism as `routeflow-plane-daily`) that is **not** in git and must be installed by hand once and deleted by hand on rollback                              | A one-line install instruction and a status line that says "never published on this machine" until it runs                                               | no — spec §7 deploy day names it |
| CI (`ci.yml`, single consolidated `npm run verify` job)                                      | Runs the new validator and self-test on Linux                                                                                                                                                     | No network, no `gh`, no machine-local paths assumed present                                                                                              | n/a                              |

## 8. Root-cause check — is this a symptom? (G1·Q7, G1·Q8)

- **Symptom or cause:** mixed. Three of the four pieces are causes; one is a symptom.
- **The symptom:** "let the tracker be computed from git" assumes the trailers exist. They do
  not (1/96). Computing `prs[]` from trailers today would produce an empty answer and hide the
  real gap. **The root cause is that nothing reads the trailer, so nobody writes it** — the fix
  for that is a consumer that _reports coverage_ ("N of M commits since <sha> carry no roadmap
  trailer") and a nudge where the text is written (`.github/PULL_REQUEST_TEMPLATE.md`, 704 bytes,
  has no trailer lines today). Adoption becomes measurable and the report becomes useful as
  adoption climbs.
- **Would fixing the root cause delete this request entirely?** No. Even at 100% trailer adoption
  the gate, the render/publish schedule and the session brief are still needed; the trailers only
  feed one of the four pieces.
- **Are we solving the problem, or building the solution the requester already picked?** The
  requester picked five mechanisms (validate gate, trailers, post-merge hook, hourly job, Plane
  Pages, SessionStart line). Alternatives considered per mechanism:
  - _Validate gate_ → the picked solution (wire `render.mjs --validate` into `verify`) is the
    cheapest possible; no alternative is better.
  - _Trailers → tracker_ → alternative: derive `prs[]` from a saved `gh pr list` JSON matched by
    branch name (`headRefName` = `feat/<slug>`). Rejected: branch names don't carry `F-##` today
    either, and the README already chose trailers. Keep trailers, **compute-and-report** (decision
    in §11 Q1).
  - _Plane Pages_ → alternative: one pinned ROAD work item whose description is the rendered
    tracker, driven by the work-item endpoints the client already proves live. **Kept as the
    committed fallback** if the Pages probe fails (§9 A1).
  - _Post-merge hook_ → alternative: rely on the hourly job alone. Landings here are server-side
    squash merges (`gh pr merge`), so a local `post-merge` fires only on the machine that later
    `git pull`s — and husky hooks silently skip in worktrees (memory: "Worktree push skips husky
    hooks"). Kept as a `could`: render-only, never publish, never network.
  - _Hourly job_ → alternative: publish from CI on merge. Rejected: CI is a single billed
    `verify` job by design (`.husky/pre-push` header) and has no Plane key; and network in CI
    makes merges flaky on Plane outages.
- **Prior art (G3·Q3):**
  - `scripts/campaign-check.mjs` `checkFreshness`/`staleBlock` — the repo's hard-won "is this
    generated artifact stale vs. git" pattern (L-179: a gate keyed on "newest commit, any file"
    false-fails when its own report step can be cache-skipped). F-22's staleness is much simpler
    (no turbo, no test run) — **diverge deliberately: key on a content hash of the three JSONL
    files + the calendar day, never on mtime or "newest commit"**, and reuse the message _shape_
    (`<artifact> is STALE — generated <when> but <cause> … Regenerate it: <command>`).
  - `scripts/campaign/plane-triage.mjs --brief` — the existing SessionStart hook: byte-capped
    (1536 B), exit 0 always, `skipped (no PLANE_API_KEY)` quietly. F-22's status line copies this
    contract with a smaller cap and zero network.
  - `scripts/campaign/plane-docs.self-test.mjs` `existingHooksIntact` — the exact guard for
    "add a SessionStart element, never replace the `hooks` object".
  - `scripts/campaign/plane-client.mjs` `createClient()` → `get`/`listAll`/`write(method, path,
body, {ref, reason})` — generic enough to drive any `api/v1/workspaces/{slug}/…` path; the
    ledger, rate window, denylist (`scanForbidden`) and `appendRun` telemetry come free.
  - `.claude/hooks/stop.mjs` line 100 — already parses a trailer (`Bookkeeping-Follow-Up:`) from
    `git log -1 --format=%B`; the same regex-over-`%B` approach scales to `Feature:`/`Bug:`/
    `Defers:` over a range.
  - `scripts/roadmap/render.mjs` — `ROOT` from `import.meta.url` (L-194-safe), `renderTracker`
    computes LAG inline (`targetDate < today && status !== "done"`; `revisitBy < today && open`).

## 9. Riskiest assumption and the cheapest way to kill it (G3·Q1, G3·Q6)

| #   | Assumption                                                                                                                                                                                                                                                                                                                                                           | If it is wrong, what breaks                                                                                                                                                  | Cheapest thing that would kill it                                                                                                                                                                                                                                                                     | Cost                           | Result                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| A1  | Plane Cloud's public API v1 exposes a Pages resource under `api/v1/workspaces/{slug}/…` that an API key can create/update. **Nothing in this repo mentions a Pages endpoint** (repo-wide grep: zero hits), and `plane-docs.mjs` — the file the row says publishes "via" — does not exist (only `plane-docs.self-test.mjs`, which tests the skill _docs_, not Pages). | The "publish to Plane Pages" leg has no request shape to build against. If unhandled, the whole publish path stalls.                                                         | A read-only probe through the existing client: `createClient({apiKey, tool:"roadmap-publish"}).get("pages/")` and `.get("projects/<ROAD id>/pages/")`; record HTTP status + top-level keys. 200 → confirmed; 404/405 on both → not exposed. Zero writes. Needs `PLANE_API_KEY` (the PC or the owner). | ~15 min once a key is at hand  | **pending** — no key on this Mac. Spec makes the probe its own R# and commits the ROAD work-item fallback |
| A2  | The coordinator's hand-typed `prs[]` has real omissions worth catching.                                                                                                                                                                                                                                                                                              | The trailer report finds nothing to propose; the from-git piece is worth less (still gives coverage). Scope of that piece shrinks to "coverage + PR-number check", not less. | Run the report once over `c73b0897..origin/master`: count `(#N)` subjects whose N is in no row's `prs[]`. Cheap once the script exists (it is the script).                                                                                                                                            | free at build time             | pending                                                                                                   |
| A3  | The machine-local scheduled-task mechanism (`mcp__scheduled-tasks__*`, precedent `~/.claude/scheduled-tasks/routeflow-plane-daily/`) exists on the PC and can run an npm script hourly.                                                                                                                                                                              | The hourly backstop has no runner; only the post-merge hook and manual republish remain.                                                                                     | On the PC: `ls ~/.claude/scheduled-tasks/` shows the precedent (the plane skill says it is installed there; this Mac has none).                                                                                                                                                                       | 1 min when the PC is reachable | pending                                                                                                   |
| A4  | Squash-merge commits on `master` keep the PR body, so trailers written in a PR body are reachable from `git log` without `gh`.                                                                                                                                                                                                                                       | Trailers would have to be fetched from PR bodies via a saved `gh pr list --json body` file instead.                                                                          | Read three recent squash commit bodies on `origin/master`.                                                                                                                                                                                                                                            | done                           | **held** (2026-09-24): bodies present, `(#N)` on 96/96 subjects                                           |

_A1 is the one worth killing before S4, not before S2: the spec is written so that either
probe outcome has a committed path._

## 10. Non-goals — the scope fence (G2·Q5)

- **Auto-writing `status`, `percentDone`, `targetDate`, `notes` or any deferral field from git** —
  the README's "bookkeeping PRs only" rule stays; the tool proposes, a human applies (§11 Q1).
- **Auto-committing or pushing any register change** — never; the narrowest write is a working-tree
  edit of `prs[]` a human then commits in their bookkeeping PR.
- **Blocking commits or pushes that lack a `Feature:`/`Bug:` trailer** — adoption is 1%; a blocking
  gate would stop every landing tomorrow. Nudge via the PR template and report coverage instead.
- **Rebuilding or editing F-09's harness** (`plane-sync`/`triage`/`intake`/`apply`/`doctor`,
  `bugs.mjs`) — F-22 imports `plane-client.mjs` and _runs_ the sync/triage scripts; it changes none.
- **Any Plane or network call inside `npm run verify`, the SessionStart hook, or a git hook.**
- **Plane cycle/module automation for ROAD** — the plane skill lists it out of scope; D-15's
  "add the Release 1 cycle" half stays with D-15.
- **Hosting the rendered HTML anywhere public** (GitHub Pages, S3, the marketing site) — the
  `roadmap.html` "shareholder view" is published only into Plane like the other two; a public host
  is a separate decision.
- **A committed, fleet-wide scheduler** — the hourly job is one machine's (§11 Q4).
- **Changing `bugs.jsonl`, the code map or the lessons register** — untouched.
- **Fixing the F-22 row's own `targetDate`/`release`** in this pipeline — flagged as a finding
  for the bookkeeping PR (§11 F-1), not edited here.

## 11. Open questions for the requester — and the decisions made

| #   | Question                                                                                                             | What decision it unblocks                                                | Blocking S2? | Answer / assumption made                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Should trailer-driven tracking **auto-write** `features.jsonl`, or **compute-and-report**?                           | The shape of the from-git script; whether it can run unattended          | yes          | **DECIDED: compute-and-report.** Reasons: (1) the README's rule is "bookkeeping PRs only" — a second, automated writer of the registers is exactly what that rule forbids, and Gate 2/3 of `stop.mjs` are built around a human-opened follow-up PR; (2) the signal is 1/96 today — an auto-writer would mostly write nothing and would _hide_ the adoption gap that a coverage report exposes; (3) `percentDone`/`status` are judgement fields no trailer can carry. **The one slice that is safe to write, and only into the working tree, only on request (`--apply`): `prs[]` appends** — a PR number derived from a `(#N)` subject on a commit whose body carries `Feature: F-##`, appended to that row's `prs[]` if absent. Never removes, never reorders, never touches any other field, never commits. Revisit auto-write only when the report's own coverage line shows ≥ 80% adoption over a rolling 50 commits.                                                                                                                                                                                                             |
| Q2  | What does "the SessionStart hook prints roadmap state and whether the artifacts are stale" mean, exactly?            | The status command's contract and how it composes with the existing hook | yes          | **DECIDED** (full contract in spec §4 "Surface: SessionStart status"): a **second element appended to `hooks.SessionStart`** (`node scripts/roadmap/render.mjs --status`, direct `node`, never `npm run` — `npm run` alone costs 7–9 s here per `.husky/pre-push`), the existing triage element byte-for-byte untouched. Zero network, zero `gh`, exit 0 always, ≤ 5 lines, ≤ 768 bytes, prefixed `Roadmap` so it never reads as Plane triage output. **Stale is defined by a stamp, not mtime:** the renderer writes `local-assets/roadmap/.rendered.json` `{renderedAt, day, registersHash, headSha}` where `registersHash` = sha256 over the bytes of the three JSONL files in that order. Render is STALE iff any HTML file or the stamp is missing, `registersHash` ≠ the current hash, or `day` ≠ today (UTC) — the LAG list is date-relative, so yesterday's render is stale even if no row changed. Publish freshness uses the same rule over `.published.json`. It does **not** touch `campaign-check.mjs`'s freshness work (different artifacts, different question — test reports vs. turbo cache) and does not re-run it. |
| Q3  | Is "publish to Plane Pages" achievable with confidence?                                                              | Whether the build plan can commit to a request shape                     | no (for S2)  | **DECIDED: it is a genuine unknown.** The Pages API shape is unconfirmed anywhere in this repo (zero hits), `plane-docs.mjs` named in the row does not exist, and `createClient` only proves work-item/comment/link/member/state/label/type endpoints live. The spec gives the probe its own **must** R# with a concrete read-only call (A1) and commits a fallback the client already proves: **one pinned ROAD work item per page, updated in place** (`PATCH projects/{ROAD}/work-items/{id}`), which the build plan may take without waiting. If the probe passes, Pages become the target; if not, the fallback ships and Pages become a deferred row. Either way the publish step is the same shape: render → denylist scan → ≤ 3 ledgered writes → stamp. Also flag: the row's "via plane-docs.mjs" is a misnomer; the new script is `scripts/roadmap/publish.mjs`.                                                                                                                                                                                                                                                            |
| Q4  | Does the hourly scheduled job belong to one machine (like `routeflow-plane-daily`) or to every machine in the fleet? | Where the schedule is defined and documented                             | no           | **DECIDED: one machine, machine-local, gitignored state — the PC (the row's `machine` field).** Tradeoff: fleet-wide would need `PLANE_API_KEY` on every machine and would have N machines publishing the same page concurrently — duplicate ledger writes, racing stamps, and Plane rate-window pressure — for no gain, since the registers are identical everywhere after a pull. One scheduled publisher plus **any** machine able to republish with one call (`npm run roadmap:publish`) is exactly the row's own wording ("any session on any account republishes with one call"). What IS portable and committed: the npm script the job runs, a one-line install instruction in `.claude/roadmap/README.md`, and the status line's "publish: never on this machine" so a second machine knows it is not the publisher.                                                                                                                                                                                                                                                                                                         |
| Q5  | The F-22 row's `targetDate` is today (2026-09-24), `status: planned`, `percentDone: 0`. What should it be?           | Whether the row lags from tomorrow                                       | no           | **Finding F-1 — flagged, not fixed here** (bookkeeping PR only). Proposed: **`release: "R2"`, `targetDate: "2026-10-01"`.** Justification: (1) F-22 `dependsOn` F-09, whose own target is 2026-09-28 at 33% — F-22 cannot sensibly complete before its dependency; (2) R1.1's go/no-go is tomorrow (09-25) and this row is 0% — leaving it in R1.1 guarantees a LAG entry with no information in it; (3) R2's cut date is today (09-24), so a re-scope decision today is on time, and 2026-10-01 is one day inside R2's ship date (10-02), leaving a day of observed hourly runs before the release; (4) the scope in the spec is ~7 LOW-risk tasks plus one probe that needs the PC's key, which fits a single lane-week once F-09 lands. If the owner prefers to keep it in R1.1, `targetDate: 2026-09-28` (matching F-09) is the defensible minimum; anything earlier lags on arrival.                                                                                                                                                                                                                                             |
| Q6  | Fold D-15's nightly-sync half into F-22's hourly job?                                                                | Whether D-15 stays open after F-22 ships                                 | no           | **Assumed yes — confirm.** The hourly job runs `plane-sync.mjs --if-digest-changed` (a no-op when nothing changed), which is a strict superset of a nightly sync. D-15's remainder (add the Release cycle; clear the 5 stale `started` items) stays D-15. D-15's `revisitBy` is today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Q7  | Does a PC-side F-22 spec already exist that disagrees with this one?                                                 | Whether this file is authoritative                                       | no           | **Assumed no** (context pack: none found on this Mac; PC unreachable). If one surfaces, reconcile the five decisions above first; the R# ids here are the ones the pipeline uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 12. Assumptions (unverified) — MANDATORY

| #   | Claim, as this file states it (and its §)                                                                                                                                                                             | Basis                                                                                                                                                                                 | What would confirm it                                                                                                                                                           | What breaks if it is wrong                                                                                                                  | Status                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| A1  | §8/§9/§11-Q3: Plane Cloud API v1 exposes Pages create/update under `api/v1/workspaces/{slug}/…` for an API key                                                                                                        | my guess — no repo evidence, no doc read                                                                                                                                              | Read-only GETs via `scripts/campaign/plane-client.mjs` `createClient().get("pages/")` and `.get("projects/<ROAD id>/pages/")` with a real `PLANE_API_KEY`; record status + keys | The Pages leg has no shape; the ROAD work-item fallback ships instead (spec R11). Nothing else falls.                                       | unverified — probe is spec R10            |
| A2  | §2/§3: the coordinator's hand-typed `prs[]` has omissions; the cost of the workaround is "an unknown number of `prs[]` omissions"                                                                                     | inferred from the process (no cross-check exists), not measured                                                                                                                       | Run the from-git report (spec R6) once over `c73b0897..origin/master` and count `(#N)` numbers absent from every row's `prs[]`                                                  | The from-git piece yields only coverage numbers; its `--apply` slice (R7) is rarely used. Scope shrinks, nothing else.                      | unverified                                |
| A3  | §7/§9/§11-Q4: the machine-local scheduled-task mechanism exists on the PC (`~/.claude/scheduled-tasks/routeflow-plane-daily/`) and can run an npm script hourly                                                       | plane skill line 35 says the daily task is installed "machine-local"; this Mac has no `~/.claude/scheduled-tasks/`                                                                    | `ls ~/.claude/scheduled-tasks/` on the PC; `mcp__scheduled-tasks__list_scheduled_tasks` there                                                                                   | The hourly backstop has no runner; the manual one-call republish and the `could` post-merge hook remain (spec R15 is `should`)              | unverified                                |
| A4  | §8/§9: squash-merge commits on `master` keep the PR body (trailers reachable via `git log --format=%B`); `(#N)` is on every subject                                                                                   | read off `git log origin/master` — bodies present, 96/96 subjects end in `(#N)`                                                                                                       | done                                                                                                                                                                            | —                                                                                                                                           | confirmed 2026-09-24                      |
| A5  | §11-Q2: elements of `hooks.SessionStart` run independently — one element failing or being slow does not suppress the other's output                                                                                   | my understanding of Claude Code hook semantics                                                                                                                                        | Add the second element locally and start a session with `PLANE_API_KEY` unset; both a `Plane triage: skipped …` line and a `Roadmap …` block print                              | The roadmap line could be hidden behind the triage brief's failure; mitigation is the status script's own exit-0/no-network contract        | unverified                                |
| A6  | §11-Q2: a SessionStart hook's `process.cwd()` is the session's checkout — but `render.mjs` derives `ROOT` from `import.meta.url` so cwd does not matter (L-194)                                                       | read off `scripts/roadmap/render.mjs` line 17 (`ROOT`); cwd behaviour is my understanding                                                                                             | Start a session from a worktree; the status line names the worktree's own `local-assets/roadmap/` path                                                                          | A worktree session reports the main checkout's freshness instead of its own — a wrong-but-harmless line                                     | ROOT confirmed 2026-09-24; cwd unverified |
| A7  | §7: an hourly run (≤ 3 publish writes, `plane-sync --if-digest-changed`, a 16-GET triage) stays inside `scripts/campaign/plane-knobs.json` budgets (`clientRatePerMin` 50, `syncMaxWrites` 250, `triageGetBudget` 16) | inferred from the knobs file and each script's documented budget                                                                                                                      | `runs.jsonl` lines after the first day of hourly runs show no `rateLimitSleeps`/deferred writes                                                                                 | The hourly cadence gets throttled or defers writes; drop to every 2–4 h (a knob, not a rewrite)                                             | unverified                                |
| A8  | §8/§11-Q3: a ROAD project exists in the workspace and the client's work-item write path is live against it                                                                                                            | plane skill line 18 ("ROAD — programs as Epics"); `plane-doctor.mjs` online section checks "the five identifiers"; work-item writes proven by `plane-sync.mjs` against BUGS, not ROAD | `node scripts/campaign/plane-doctor.mjs` online on a machine with a key: `PASS` for ROAD; one dry-run publish                                                                   | The fallback target needs a different project (OPS) — a config value, not a redesign                                                        | unverified                                |
| A9  | §4/§11-Q5: F-09 lands by its 2026-09-28 target, so F-22 can start its build after it                                                                                                                                  | the F-09 row (33%, target 09-28)                                                                                                                                                      | F-09's row reaches `done`                                                                                                                                                       | F-22's proposed 10-01 target slips with it; the plan itself is unaffected (F-22 only _imports_ F-09's shipped scripts, which already exist) | unverified                                |
| A10 | §2: "several sessions per day across the fleet" hit the session-start row                                                                                                                                             | my estimate from the fleet memory notes; not counted                                                                                                                                  | Count `runs.jsonl` `plane-triage` lines per day (each session start appends one)                                                                                                | Only the value of the session line changes, not its design                                                                                  | unverified                                |
| A11 | §11-Q1: `percentDone`/`status` cannot be derived from trailers — they are judgement fields                                                                                                                            | reading the README's field semantics and the rows                                                                                                                                     | Owner confirms                                                                                                                                                                  | If the owner wants e.g. `status: done` auto-set when all `prs[]` are merged, that is a new, separate rule for a later row — not this plan   | unverified                                |

Rules honoured: A1–A4 keep their §9 numbers; every number in §2/§6 that was read off a system
cites the command; every "assumed" line in §11 is here.

---

## STOP GATE — S1 → S2

- [x] Problem stated in the requester's own words **and** restated in ours
- [x] User named: role + frequency + cost today
- [x] Current workaround named, and why it fails
- [x] One observable success signal **with today's baseline**
- [x] "If we ship nothing" answered honestly
- [x] Root-cause check done — we are not building a solution to a symptom by reflex (the one symptom, "computed from git", is re-shaped into compute-and-report + coverage)
- [x] Riskiest assumption named, with a check that costs less than the build
- [x] Non-goals written down
- [x] Every blocking open question answered, or the assumption recorded
- [x] Assumptions block filled — every unchecked claim, what would confirm it, what it breaks (§12)

## Stage log — did the gate fire?

| Stop condition                                 | Evaluated? | What it answered                                                                                                                          | Evidence   | Verdict |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------- |
| Shipping nothing is materially bad             | yes        | Moderately bad, compounding: register drifts from git, trailer convention dies at 1%, tracker readable on one (unreachable) machine       | §5         | pass    |
| The ask is a cause, not a symptom              | yes        | Three of four pieces are causes; the trailer piece was a symptom and is re-shaped (report coverage + PR-template nudge, never auto-write) | §8         | pass    |
| User, workaround and success signal all stated | yes        | Coordinator/owner/every session; hand-edit + local render + nothing published; published-copy age, baseline ∞                             | §2, §3, §6 | pass    |
| Every blocking open question answered          | yes        | Q1 and Q2 decided in this file; Q3–Q7 non-blocking with assumptions recorded                                                              | §11        | pass    |

- **Gate outcome:** PASS — S2 may start
- **Overridden by:** n/a
- **Assumptions carried into S2:** A1, A2, A3, A5, A6, A7, A8, A9, A11

**Approved by:** <human lead> · **on:** <YYYY-MM-DD>

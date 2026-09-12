# Test plan — Plane harness: sync/intake/triage/apply + shared client (S4)

> Stage S4. Authored by Sonnet 5 (transcription) from Fable 5.1's ruling, 2026-09-11.
> Status: DRAFT. Requirement IDs `R#` come from [spec.md](./spec.md) (R1–R13, the last added
> by the 2026-09-11 23:30Z addendum). Work packages in [build-plan.md](./build-plan.md)
> reference the `T#` ids defined here. `ui: false` — no UX spec, no UI flows in this change.

**Gate to pass before S5:** every `R#` maps to ≥1 `T#`; every `T#` names an `R#`; every `T#`
has an oracle; every `T#` has a stated reason it fails today. Verified in §3.

---

## 1. Strategy for this change

This is repo tooling: four CLI scripts (`plane-sync.mjs` extended, `plane-intake.mjs`,
`plane-triage.mjs`, `plane-apply.mjs` new) plus a shared REST client (`plane-client.mjs`), a
Stop-hook budget bump, and docs — no application UI. The proof is almost entirely
integration-level: each CLI runs as a **real spawned child process** against a disposable
`node:http` fake Plane server (extracted to `scripts/campaign/plane-fake-server.mjs`) that
records every request, so a passing case proves the actual script's HTTP behavior, never a
hand-copy of its request-building logic. A handful of unit-level checks cover static
properties that don't need a network round trip at all (source-literal scans, package.json/
settings.json/gitignore shape, SKILL.md byte size). No property-based generator is
introduced — the one thing worth an invariant (the write budget) has a state space small
enough for a table of concrete cases (§5).

| Level       | Used here? | Why / why not                                                                                                                                                  |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | yes        | source/config literal scans (T11), argv-shape (T12), file existence/content (T13, T14), `--help` exit-code/stdout shape (T15) — none need a network round trip |
| property    | no         | no money, quantities-as-a-domain, or permissions math; the one countable invariant (write budget) is covered by concrete table cases (T4, T9), not a generator |
| contract    | no         | one internal caller (the four scripts) of one internal client (`plane-client.mjs`) — not a wire format serving multiple external consumers                     |
| integration | yes        | every CLI behavior (adoption, denylist, budget, comment-on-close, intake, triage, apply) needs the real request sequence a unit test would have to mock away   |
| e2e         | no         | no browser, no UI surface (`ui: false`)                                                                                                                        |
| manual      | yes        | the deploy-day bulk run (`npm run plane:sync -- --max-writes 400`) against the REAL workspace is owner-watched, never automated (spec.md "Deploy-day")         |

**Rule applied:** prefer the lowest level that can fail for the right reason — the static
scans and shape checks stay unit; everything that depends on request sequencing against a
live-shaped API is integration.

**Deliberately NOT tested, and why:**

- A real network call to `https://api.plane.so` — would require a live workspace and a real
  key in CI; the fake server proves the request/response contract, and the manual level
  (`--dry-run`/`--check`, owner-watched first run) is the compensating control before any
  real write.
- Plane's own rate-limiter internals beyond one 429-then-succeed round trip and one
  `x-ratelimit-remaining: 0` sleep — already proven by the carried-over v1 case (T11); this
  change doesn't touch that code path.
- The real Plane REST shape for `intake` sub-resources and the `archive` operation beyond
  what R6/R8 state — the ruling does not name the literal endpoint paths for either, so the
  fake server fixture in §7 models only the documented behavior (a listable "status -2"
  record set; an archive op that requires the target's current state group to already be
  completed/cancelled) and WP3/WP5 must confirm the real paths against Plane's own API
  reference before the first live run — **raised, not decided here** (see the closing brief).

**Risk driving depth:** every write here lands in a real, shared, owner-visible Plane
workspace that this suite must never touch — a wrong request shape corrupts a live tracker
that other humans read daily, a denylist miss leaks tenant uuids/invoice numbers/emails into
a third-party SaaS visible to the whole team, and a write-budget bug could exhaust Plane's
API quota or spam duplicate comments across ~280 rows. Every write path therefore gets a
request-sequence-level integration case against the fake server before any real key is used,
and the denylist/budget guards get both a positive and a must-not-happen case (§4).

**Characterization tests needed first?** No — this is new-script work for three of the five
files (`plane-intake.mjs`, `plane-triage.mjs`, `plane-apply.mjs`, `plane-denylist.json` are
net-new); `plane-sync.mjs` and `plane-client.mjs`'s extraction from it are additive
(adoption, comment-on-close, `--max-writes`, `--help`) rather than a behavior-preserving
refactor of existing logic, so there is no "capture today's behavior first" step — T1/T2/T4/
T5/T6/T15 already state the exact today-vs-tomorrow contrast directly.

---

## 2. Test table

| ID  | proves | level       | Given / When / Then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Oracle — why the expected value is KNOWN                                                                                                                             | File                                                                                                                                                     | Fails today because                                                                                                                                                                                                                  |
| --- | ------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | R1     | integration | **G** fake BUGS has "B12 · x" (`external_id` null, Backlog) and "B13 · y" (`external_id` already `B13`); registry has B12 + B13 both `queued` · **W** run `plane-sync.mjs` twice · **T** run 1: exactly one PATCH, path ends `/work-items/<B12 id>/`, body `{external_source:"routeflow-registry", external_id:"B12"}`, zero POST creates; run 2: zero writes                                                                                                                                                        | R1's adoption rule, quoted verbatim in spec.md and pasted as executable pseudocode in the ruling's hard-lines block                                                  | `scripts/campaign/plane-sync.self-test.mjs`                                                                                                              | v1's `planDiff` matches ONLY by existing `external_id`; a null-external_id item with a matching name is invisible to it, so v1 POST-creates a duplicate for B12 instead of adopting it                                               |
| T2  | R1     | integration | **G** fake has "B12 · a" seq 5 and "B12 · b" seq 9, both `external_id` null; registry has B12 · **W** run sync once · **T** PATCH exactly the seq-5 item; output contains `duplicate candidate B12`; zero DELETE requests                                                                                                                                                                                                                                                                                            | R1: "Two candidates for one id ⇒ adopt the lowest `sequence_id`, warn ..., never delete"                                                                             | `scripts/campaign/plane-sync.self-test.mjs`                                                                                                              | no duplicate-candidate/adoption code exists in v1 at all                                                                                                                                                                             |
| T3  | R2     | integration | **G** registry row B77 title `"Invoice INV-2026-12345 double-charged"` (`queued`), no matching Plane item · **W** run sync · **T** zero POST for B77; summary line contains `skipped(forbidden)=1`; combined stdout+stderr does NOT contain `INV-2026-12345`; output contains `B77 forbidden (invoice-number)`                                                                                                                                                                                                       | R2's denylist contract, verbatim: the op is skipped, counted, the id + pattern name printed, the matched text never printed                                          | `scripts/campaign/plane-sync.self-test.mjs`                                                                                                              | `plane-client.mjs`/`scanForbidden`/`plane-denylist.json` don't exist; v1 has no forbidden-string scan and would POST the raw title                                                                                                   |
| T4  | R3     | integration | **G** 5 queued rows, no existing Plane items, `--max-writes 3` · **W** run sync · **T** POST count = 3; summary contains `deferred=2`; exit 0; `.plane-writes.jsonl` has exactly 3 lines, each parses with keys `ts,tool,method,path,ref` and no `body` key                                                                                                                                                                                                                                                          | R3's write-budget contract, verbatim (`--max-writes` default/behavior, one ledger line per write, ledger never carries a body)                                       | `scripts/campaign/plane-sync.self-test.mjs`                                                                                                              | `--max-writes`, the ledger file, and `appendWrite`/the budget guard don't exist in v1 (v1 only has the time-based `--budget-ms`)                                                                                                     |
| T5  | R4, R5 | integration | see §2.1 (multi-run, three phases)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | R4/R5's comment-on-close + idempotency-cache contract, verbatim                                                                                                      | `scripts/campaign/plane-sync.self-test.mjs`                                                                                                              | v1 has no `Done`-vs-`Live` distinction check, no comment-on-close logic, no `.plane-sync-state.json` cache at all                                                                                                                    |
| T6  | R4     | integration | **G** registry B50 `done` (pr 600), no existing Plane item · **W** run sync · **T** one POST creating the item (Live state id); comments POST = 0; links POST = 0                                                                                                                                                                                                                                                                                                                                                    | R4: "creation of an item already `done` post[s] no comment (the description block already carries the proof)"                                                        | `scripts/campaign/plane-sync.self-test.mjs`                                                                                                              | no comment-on-close logic exists at all, so the create-with-no-comment exemption is untestable today                                                                                                                                 |
| T7  | R6     | integration | see §2.1 (four phases: list, apply-dirty, apply-clean)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | R6's intake contract, verbatim (ready-command shape, precondition order, per-item write sequence)                                                                    | `scripts/campaign/plane-intake.self-test.mjs`                                                                                                            | `plane-intake.mjs` does not exist                                                                                                                                                                                                    |
| T8  | R7     | integration | **G** fake: OPS item `target_date` = yesterday (Backlog); DECIDE item Backlog; ROAD item In progress, `updated_at` 10 days ago; BUGS "B12 · x" Backlog while the ledger says `done` (drift) · **W** `plane-triage.mjs --brief` · **T** brief contains `overdue 1`, `open rulings 1`, `stale started 1`, `BUGS drift 1`; total GET count ≤ 12; brief ≤ 1536 bytes; first line matches `/\d{4}-\d{2}-\d{2}T/`; separately, key unset → stdout exactly `Plane triage: skipped (no PLANE_API_KEY)`, exit 0               | R7's section list + call-budget contract, verbatim; the ≤12-GET arithmetic is the ruling's own hard-line comment (1 projects + 5 states + 4 page-1s + ≤2 BUGS pages) | `scripts/campaign/plane-triage.self-test.mjs`                                                                                                            | `plane-triage.mjs` does not exist                                                                                                                                                                                                    |
| T9  | R8, R3 | integration | see §2.1 (five phases: dry-run, real, invalid ref, over-budget, `--over-budget`)                                                                                                                                                                                                                                                                                                                                                                                                                                     | R8's validate-first / ordered-write contract and R3's manual budget rule, verbatim                                                                                   | `scripts/campaign/plane-apply.self-test.mjs`                                                                                                             | `plane-apply.mjs` does not exist                                                                                                                                                                                                     |
| T10 | R2     | integration | **G** ops file with a comment op whose html contains a uuid-shaped string · **W** run `plane-apply.mjs` (real) · **T** exit 1, zero writes, output contains `forbidden (tenant-uuid)`, never the uuid itself                                                                                                                                                                                                                                                                                                         | R2, applied to the apply path the same way T3 applies it to sync                                                                                                     | `scripts/campaign/plane-apply.self-test.mjs`                                                                                                             | `plane-apply.mjs` (and its denylist wiring) does not exist                                                                                                                                                                           |
| T11 | R9     | integration | **G** the v1 self-test's own carried-over cases (rate-limit sleep on `x-ratelimit-remaining: 0`; a 5xx that retries then succeeds; `--dry-run` makes zero fetches; a second identical run is a no-op; no uuid/key literal in tracked source) · **W** re-run against the new `plane-client.mjs`-backed sync; extend the literal-scan to `plane-client.mjs`/`plane-intake.mjs`/`plane-triage.mjs`/`plane-apply.mjs` · **T** all pass unchanged in observable behavior; the extended scan covers the four new files too | R9: "v1 self-tests keep passing unchanged in behaviour"; the literal-scan extension is R2/R5's no-uuid rule applied to every new tracked file                        | `scripts/campaign/plane-sync.self-test.mjs`                                                                                                              | `plane-client.mjs` and the other three scripts don't exist yet — an unguarded scan throws ENOENT; a guarded scan (see §6) reports them absent, a clean assertion miss                                                                |
| T12 | R12    | unit        | **G** `.claude/hooks/stop.mjs` after WP6 · **W** inspect the argv array the hook passes to the spawned `plane-sync.mjs` child (same throwaway-repo/fixture harness `stop.gate5.spec.mjs` already uses) · **T** argv contains `--max-writes` immediately followed by `25`                                                                                                                                                                                                                                             | R12, verbatim: "Stop-hook Gate 5 passes `--max-writes 25` to plane-sync"                                                                                             | `.claude/hooks/stop.gate5.spec.mjs`                                                                                                                      | v1 Gate 5 passes only `--quiet --budget-ms 18000 [--if-digest-changed]` — no `--max-writes` argument exists                                                                                                                          |
| T13 | R11    | unit        | **G** `package.json` after WP6 · **T** `scripts` has `plane:sync`, `plane:check`, `plane:triage`, `plane:intake`, `plane:apply`; `verify`'s string contains the four new self-test invocations after `bugs.mjs self-test`                                                                                                                                                                                                                                                                                            | R11, verbatim                                                                                                                                                        | `scripts/campaign/plane-docs.self-test.mjs`                                                                                                              | only `bugs:plane` exists today; no `plane:*` script names, no intake/triage/apply self-test in `verify`                                                                                                                              |
| T14 | R10    | unit        | **G** repo files after WP6 · **T** `.claude/skills/plane/SKILL.md` exists, ≤ 6144 bytes, contains all four script names; `.claude/settings.json` has a `SessionStart` hook whose command contains `plane-triage.mjs --brief`; `.claude/skills/rebuild/SKILL.md` contains `plane:sync`; `.gitignore` contains `.plane-writes.jsonl`                                                                                                                                                                                   | R10, verbatim                                                                                                                                                        | `scripts/campaign/plane-docs.self-test.mjs`                                                                                                              | none of these exist: no `plane` skill dir, no `SessionStart` hook in `settings.json`, no `plane:sync` mention in `rebuild/SKILL.md`, no `.plane-writes.jsonl` in `.gitignore`                                                        |
| T15 | R13    | unit        | **G** each of the four scripts run with `--help`, `PLANE_API_KEY` unset, `PLANE_BASE_URL` pointed at a port nothing listens on · **T** exit 0; stdout contains `Usage:` and the script's own name; a fake server started for the case (if any) records 0 requests; a separate run with an unknown flag `--bogus` → exit 2, stderr contains `Usage:`                                                                                                                                                                  | R13 (2026-09-11 23:30Z addendum), verbatim, including its own repro as the "fails today" oracle                                                                      | one case per script, in `plane-sync.self-test.mjs`, `plane-intake.self-test.mjs`, `plane-triage.self-test.mjs`, `plane-apply.self-test.mjs` respectively | v1 `plane-sync.mjs`'s argv parsing (~line 671) has no `--help`/unknown-flag branch — the addendum's own incident: a bare `--help` on 2026-09-11 fell through to a live run and hit HTTP 429; the other three scripts don't exist yet |

### 2.1 Expanded cases

**T5 — comment-on-close + state-map completeness, three runs**

- **Given:** fake BUGS holds "B45 · z" already in `Done` (group `completed`) and "B46 · w" in
  `Backlog`. Ledger: B45 `done` (pr 678, sha `abc1234`, proof `REG-B45`), B46 `done` (pr 681).
- **When (run 1):** `plane-sync.mjs` against this fixture.
- **Then (run 1):** B45 — one PATCH to the `Live` state id, **zero** comment POSTs (it was
  already in a `completed` group, so `wasOpen` is false — no transition to report). B46 — one
  PATCH to `Live`, one comment POST whose `comment_html` contains `PR #681` and
  `plane-sync:closed`, one link POST whose `url` ends `/pull/681`.
- **When (run 2):** the same CLI, same fixture, no state reset.
- **Then (run 2):** zero comment/link writes (the local `.plane-sync-state.json` cache already
  has `closed.B46`).
- **When (run 3):** delete `.plane-sync-state.json`, then run again; the fake server is primed
  to list B46's own previously-posted comment back on a GET.
- **Then (run 3):** zero comment/link writes — the fallback path (`alreadyClosed` with no cache
  entry lists comments and finds `plane-sync:closed` in one of them) catches it.
- **Oracle:** R4's comment-on-close block (hard lines, ruling) plus R5's "an item currently in
  `Done` (group completed) whose desired state is `Live` IS a diff and is patched (they are
  distinct states)" — the PATCH on B45 despite already being in a `completed` GROUP is the
  direct proof of R5.
- **Fails today because:** none of `alreadyClosed`/`postCloseComment`/`postLink`/the cache file
  exist in v1.

**T7 — intake, front door, four phases**

- **Given:** fake BUGS has "Scanner crashes on iOS 19" (priority `urgent`, label `mobile`,
  `external_id` null, human-created — no `B###` prefix) and "B12 · x" (already prefixed). A
  separate Intake-queue fixture carries one record with status `-2` (pending).
- **When (phase 1, listing, no `--apply`):** `plane-intake.mjs`.
- **Then:** prints exactly
  `node scripts/campaign/bugs.mjs file "Scanner crashes on iOS 19" --location "Area · mobile" --severity critical --tier T1`
  and `awaiting owner triage: 1`; `"B12"` is not listed.
- **When (phase 2):** `--apply` inside a temp git repo whose `.claude/campaign` has an
  uncommitted change.
- **Then:** exit 2, message contains `dirty`, zero writes.
- **When (phase 3):** `--apply` with a clean tree whose HEAD descends from `origin/master`.
- **Then:** the temp registry's `bugs.jsonl` gains one row; one PATCH with `external_id` = the
  minted id and `name` starting `B<id> · Scanner`.
- **Oracle:** R6, verbatim — the exact command shape (severity/location maps), the two
  `--apply` preconditions in order, and the per-item write sequence (`bugs.mjs file` then
  PATCH, `note` skipped silently if unavailable).
- **Fails today because:** `plane-intake.mjs` does not exist.

**T9 — plane-apply, five phases**

- **Given:** an ops file: `update ROAD-15 state "In review"`; `comment OPS-23`; `create` an OPS
  task with `parent: "ROAD-68"`; `relation DECIDE-6 duplicate DECIDE-12`; `archive DECIDE-6`
  (the fake models DECIDE-6 as already `Cancelled`, satisfying R8's archive precondition).
- **When (phase 1):** `--dry-run`.
- **Then:** zero writes; the printed plan has 5 lines naming identifiers/names, none matching
  `/[0-9a-f]{8}-[0-9a-f]{4}-/`.
- **When (phase 2):** the same ops file, real run.
- **Then:** writes = 5, in the order PATCH → POST comment → POST work-item (create) → POST
  relation → POST archive.
- **When (phase 3):** an ops file whose `update` names state `"Nope"` (unresolvable).
- **Then:** exit 1, zero writes, message contains `#1` and `Nope`.
- **When (phase 4):** the ledger pre-seeded with 20 manual (non-`plane-sync`) write lines dated
  today, then the phase-2 ops file again, no `--over-budget`.
- **Then:** exit 3 (manual budget refusal), zero writes.
- **When (phase 5):** the same as phase 4 plus `--over-budget "window 15"`.
- **Then:** the run proceeds; one ledger line's content includes `window 15`.
- **Oracle:** R8's validate-first / ordered-write contract and R3's manual-budget refusal rule,
  both verbatim.
- **Fails today because:** `plane-apply.mjs` does not exist.

**T9b (R8) — archive precondition violation**

- **Given:** an ops file with `archive` targeting an item whose state group is `started` (the
  fake models it as `In progress`, not `Cancelled`/completed).
- **When:** `plane-apply` runs (validation happens before any write, so dry-run or real is the
  same outcome here).
- **Then:** exit 1 before any write, writes 0; the message contains `#<index>` (the op's
  1-based position in the ops file), `archive`, and `completed or cancelled`.
- **Oracle:** R8's archive-precondition rule, verbatim — archive is refused unless the target's
  state group is completed or cancelled.
- **Fails today because:** `plane-apply.mjs` does not exist.

---

## 3. Coverage matrix

| R#  | Requirement (short)                                                        | Priority | Covered by | Deepest level of cover |
| --- | -------------------------------------------------------------------------- | -------- | ---------- | ---------------------- |
| R1  | Adoption (stamp, never duplicate; oldest-wins on a tie)                    | P0       | T1, T2     | integration            |
| R2  | Denylist (skip, count, print id+pattern, never the match)                  | P0       | T3, T10    | integration            |
| R3  | Write budget + ledger (defer past `--max-writes`; manual budget refusal)   | P0       | T4, T9     | integration            |
| R4  | Comment-on-close + PR link, idempotent                                     | P0       | T5, T6     | integration            |
| R5  | State-map completeness (`Done`→`Live` is still a diff)                     | P1       | T5         | integration            |
| R6  | Intake (Plane → registry front door)                                       | P0       | T7         | integration            |
| R7  | Triage brief (read-only, ≤12 GETs, ≤1536 bytes)                            | P1       | T8         | integration            |
| R8  | Scripted writes (`plane-apply`, validate-then-write, archive precondition) | P0       | T9, T9b    | integration            |
| R9  | Shared client (v1 behavior preserved + literal-scan extended)              | P1       | T11        | integration            |
| R10 | Skill + flows (docs, SessionStart hook, byte cap)                          | P1       | T14        | unit                   |
| R11 | package.json scripts + verify tail                                         | P1       | T13        | unit                   |
| R12 | Gate 5 write budget (`--max-writes 25`)                                    | P2       | T12        | unit                   |
| R13 | `--help`/unknown-flag on all four scripts                                  | P1       | T15        | unit                   |

**Reverse check — every T# names an R#:**

| T#  | proves | Would it still pass with the feature removed? (must be "no")                                                               |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| T1  | R1     | no — v1's create-not-adopt behavior makes the PATCH-count assertion fail (got a POST)                                      |
| T2  | R1     | no — with no duplicate-candidate logic, the PATCH lands on whichever item, or none, and `duplicate candidate` never prints |
| T3  | R2     | no — v1 has no denylist scan; the forbidden title is POSTed straight through                                               |
| T4  | R3     | no — v1 has no `--max-writes`; all 5 POSTs would fire, no `deferred=` line, no ledger file                                 |
| T5  | R4, R5 | no — v1 never posts a comment or link on any transition                                                                    |
| T6  | R4     | no — untestable without comment-on-close code to exempt in the first place                                                 |
| T7  | R6     | no — `plane-intake.mjs` absent entirely                                                                                    |
| T8  | R7     | no — `plane-triage.mjs` absent entirely                                                                                    |
| T9  | R8, R3 | no — `plane-apply.mjs` absent entirely                                                                                     |
| T9b | R8     | no — `plane-apply.mjs` absent entirely; with no archive precondition, the write would go through instead of erroring       |
| T10 | R2     | no — no denylist wiring on the apply path                                                                                  |
| T11 | R9     | no — the literal-scan of the four new files fails to find them at all                                                      |
| T12 | R12    | no — Gate 5's argv has no `--max-writes` today                                                                             |
| T13 | R11    | no — `plane:*` scripts absent from `package.json` today                                                                    |
| T14 | R10    | no — none of the four artifacts exist today                                                                                |
| T15 | R13    | no — a bare `--help` today falls through to a live network call (the addendum's own incident)                              |

**Deliberately untested requirements:** none — every `R#` maps to at least one `T#` above.
T9 exercises `archive` on an item **already** in the `Cancelled`/completed group (the happy
path); T9b covers the validation-error path — archiving an item that is **not** in that group.

---

## 4. Negative tests — what must NOT happen

| ID                | Must NOT happen                                                                                 | Level       | Assertion                                                                                     | File                                          |
| ----------------- | ----------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| T3                | A denylist-forbidden string reaches stdout/stderr/Plane                                         | integration | combined output excludes the raw matched substring (`INV-2026-12345`); zero POST for that row | `scripts/campaign/plane-sync.self-test.mjs`   |
| T10               | Same, on the apply path                                                                         | integration | combined output excludes the raw uuid; exit 1, zero writes                                    | `scripts/campaign/plane-apply.self-test.mjs`  |
| T2                | Adoption of a duplicate deletes the losing candidate                                            | integration | zero DELETE requests recorded by the fake server                                              | `scripts/campaign/plane-sync.self-test.mjs`   |
| T5 (run 2, run 3) | A closed item gets a second close comment/link                                                  | integration | zero comment/link POSTs on rerun and on cache-loss-with-fallback                              | `scripts/campaign/plane-sync.self-test.mjs`   |
| T7 (phase 2)      | `plane-intake --apply` writes anything with a dirty `.claude/campaign`                          | integration | `bugs.jsonl` unchanged; zero PATCH; exit 2                                                    | `scripts/campaign/plane-intake.self-test.mjs` |
| T9 (phase 3)      | `plane-apply` writes any of the earlier-resolvable ops once one op fails validation             | integration | zero writes total, even though 4 of 5 ops would have resolved                                 | `scripts/campaign/plane-apply.self-test.mjs`  |
| T9 (phase 4)      | A manual (non-`plane-sync`) caller writes past the 20/day budget without stating a reason       | integration | exit 3, zero writes                                                                           | `scripts/campaign/plane-apply.self-test.mjs`  |
| T9b               | `plane-apply` writes an `archive` op whose target is not in the completed/cancelled state group | integration | exit 1, zero writes, message contains `#<index>`, `archive`, `completed or cancelled`         | `scripts/campaign/plane-apply.self-test.mjs`  |

---

## 5. Property-based invariants

Touched: `dates` (triage's overdue/stale-started day-boundary comparisons), `quantities`
(the write budget must never be exceeded). `money`: none. `permissions`: none (one seat,
`ClaudeLead`).

| ID  | Invariant (must hold for ALL generated inputs)                                           | Generator / input domain                                                                                                   | File                                                                                      |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| —   | the number of live (non-deferred) writes issued in one run never exceeds `--max-writes`  | not generated — a 3-value table (0, exactly-at-limit, over-limit) covers the whole domain; proven by T4 and T9 (phase 4/5) | `scripts/campaign/plane-sync.self-test.mjs`, `scripts/campaign/plane-apply.self-test.mjs` |
| —   | `overdue`/`stale started` use a strict `<` boundary, never `<=` (today is never overdue) | hand-picked boundary dates {yesterday, today, tomorrow} inside T8's fixture — the domain is three days, not a range        | `scripts/campaign/plane-triage.self-test.mjs`                                             |

**Library:** none — hand-rolled table of cases. The repo has no `fast-check` dependency
anywhere (checked: absent from root and `packages/pricing` manifests) and CLAUDE.md's
do-not-introduce list already bars adding new test infrastructure; the input domains above
are small enough (day-boundary triples, three write-budget states) that a generator would add
a dependency for no additional coverage.

---

## 6. Red gate

```bash
node scripts/campaign/plane-sync.self-test.mjs
node scripts/campaign/plane-intake.self-test.mjs
node scripts/campaign/plane-triage.self-test.mjs
node scripts/campaign/plane-apply.self-test.mjs
node scripts/campaign/plane-docs.self-test.mjs
node .claude/hooks/stop.gate5.spec.mjs
```

**Guarding new-module imports (the ground rule in this template's header).**
`plane-sync.mjs` already exists (v1), so `plane-sync.self-test.mjs`'s existing static
`import { deriveDesired, mapPriority, registryDigest } from "./plane-sync.mjs"` stays safe.
`plane-intake.mjs`, `plane-triage.mjs`, `plane-apply.mjs`, and `plane-client.mjs` do **not**
exist pre-implementation. Every case against them therefore:

- drives the CLI via `spawn` (child process), never a static top-level `import` of the
  not-yet-existing file — `node <missing file>.mjs` fails at the OS/Node level with a normal
  non-zero exit and a stderr message, which the harness captures as `{code, stdout, stderr}`
  exactly like any other run; comparing that against the expected `{code: 0, stdout: "Usage: ..."}`
  is a clean assertion miss, never a crash of the test file itself (mirrors TP1's existing
  `runCli` helper).
- reads any of the four files for a literal/text scan (T11, T14) only behind
  `existsSync(...)`, reporting "absent" (a clean assertion miss against the expected `true`)
  rather than throwing `ENOENT`.
- uses a dynamic `await import()` inside `try/catch` for the rare case that needs an actual
  export (none of T1–T15 does — every new-script assertion here is CLI/HTTP-level).

Under that discipline, every red-gate row below is expected to fail on the **stated
assertion**, not on a thrown/uncaught error — record the actual `ok N / FAIL M` counts for
each file once TP1–TP6 are authored (S6's Baseline phase), the same way v1's build plan
recorded `exit 1, 15 ok / 40 FAIL` before implementation. Two classes of expected failures:

| T#           | Expected failure (approximate)                                                                         | Failure kind |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------ |
| T1           | got 1 POST + 0 PATCH, want 0 POST + 1 PATCH                                                            | assertion    |
| T3           | got 1 POST (no denylist scan), want 0                                                                  | assertion    |
| T4           | got no `.plane-writes.jsonl` (file absent), want 3 lines                                               | assertion    |
| T7 (phase 1) | got empty stdout (`plane-intake.mjs` absent → nonzero exit), want the exact command string             | assertion    |
| T12          | got argv with no `--max-writes`, want `["--max-writes","25", ...]` to contain the pair                 | assertion    |
| T14          | got `existsSync(".claude/skills/plane/SKILL.md") === false`, want `true`                               | assertion    |
| T15          | got exit 1 (module not found) or (for `plane-sync.mjs`) a live-network attempt, want exit 0 + `Usage:` | assertion    |

Rules carried from the template: a failure that is not an assertion means the test itself is
broken — fix the test, one remediation round, then re-run; a test that passes before
implementation is vacuous and must be deleted or strengthened, never carried forward.

---

## 7. Test data and fixtures

| Need                                                                                                                                                                                          | How the test creates it                                                                                                                                                                                                                                                                                             | Scope / isolation                                                      | Cleanup                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A fake Plane workspace (projects BUGS/ROAD/OPS/DECIDE/CLIENT, states, labels, types, members, work-items with cursor pagination, comments, links, relations, archive, an intake-queue subset) | `scripts/campaign/plane-fake-server.mjs` (new, extracted from v1's inline `startFakeServer`) — `node:http` on an ephemeral port (`server.listen(0, "127.0.0.1")`), records every `{method, path, query, body}`, serves canned payloads keyed by project identifier                                                  | one fresh server per test block; `PLANE_BASE_URL` points the CLI at it | `await server.close()` at the end of each block, mirroring v1                                                           |
| A throwaway registry (`bugs.jsonl`, `status/*.jsonl`, `board.json`)                                                                                                                           | `mkdtempSync(join(tmpdir(), "plane-*-self-test-"))`, same shape as v1's `makeFixture`                                                                                                                                                                                                                               | one dir per test block, tracked in a module-level array                | swept in a `finally` at the end of the file, pinned by a before/after `plane-*-self-test-*` dir count (v1's F4 pattern) |
| A throwaway write ledger + close-cache (`.plane-writes.jsonl`, `.plane-sync-state.json`)                                                                                                      | new env `PLANE_SYNC_STATE_DIR` (default `.claude/campaign`) pointed at the same throwaway dir as `PLANE_SYNC_REGISTRY_DIR`, or a sibling temp dir when a case needs them to diverge                                                                                                                                 | per-block temp dir, never the real `.claude/campaign`                  | swept with the registry fixture                                                                                         |
| A throwaway git repo (T7 phase 2/3's dirty-tree and ancestor checks; T12's Gate 5 argv fixture)                                                                                               | the existing `stop.gate5.spec.mjs` repo-scaffold helper (`git init`, scrubbed `GIT_*` env per lesson L-004/the `git worktreeConfig` trap)                                                                                                                                                                           | one repo per case                                                      | `rmSync(dir, {recursive: true, force: true})`                                                                           |
| Cursor pagination shape                                                                                                                                                                       | fake work-items list responses page with `{results: [...], next_cursor: <string\|null>, next_page_results: <boolean>}` — matches v1's own consumer (`cursor = page.next_page_results ? page.next_cursor : null`)                                                                                                    | n/a                                                                    | n/a                                                                                                                     |
| Intake-queue records (status `-2`)                                                                                                                                                            | fake server keeps a separate in-memory list the projects/work-items routes don't touch; T7's fixture seeds one record. **The literal Plane REST path for this resource is not named in the ruling** — raised in the closing brief; WP3 confirms it against Plane's own API reference before wiring the real request | n/a                                                                    | n/a                                                                                                                     |
| Archive precondition                                                                                                                                                                          | fake server's archive route accepts the op only when the target's current state group is `completed`/`cancelled` (matching R8's validation rule), else returns a 4xx the same shape a real validation error would                                                                                                   | n/a                                                                    | n/a                                                                                                                     |

- Never assert against data anyone or anything else can change — every fixture above is a
  throwaway temp dir or an in-process fake server, never the real `.claude/campaign` or a
  real Plane workspace.
- No shared long-lived record: each test block calls `makeFixture()`/`startFakeServer()`
  fresh.
- Auth/session state: none — every CLI reads `PLANE_API_KEY` from `process.env`, set to a
  dummy string per test run (`self-test-key`), never a real credential.
- No step in this suite writes to a real environment; the one real-environment run (the
  deploy-day bulk sync) is manual and owner-watched (§1, "manual" row).

---

## 8. UI flows to drive (Playwright)

Not applicable — `ui: false` (spec.md). No UI surface exists in this change; all four scripts
are CLI-only and the skill/docs changes (R10) are Markdown/JSON, not rendered UI.

---

## 9. Mutation probe targets

| #   | File                                | Behavior to protect (→ `behavior`)               | Defect to inject (a real behavior change, not a syntax break)                             | Test that MUST go red |
| --- | ----------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------- |
| 1   | `scripts/campaign/plane-sync.mjs`   | adoption stamps external ids instead of creating | make the adoption branch a no-op (skip the PATCH, fall through to the normal create path) | T1                    |
| 2   | `scripts/campaign/plane-client.mjs` | a denylist hit skips the write                   | make `scanForbidden` always return `null`                                                 | T3                    |
| 3   | `scripts/campaign/plane-client.mjs` | `--max-writes` defers instead of writing         | remove the `this.writes >= this.maxWrites` guard inside `post/patch/del`                  | T4                    |
| 4   | `scripts/campaign/plane-apply.mjs`  | validation completes before the first write      | move one ref/name resolution after the first write instead of before it                   | T9                    |

If the named test still passes with the defect in place, that test is decoration and must be
strengthened before the change ships (mirrors v1's own composite-oracle fix, e.g. T2's
first-run-plus-second-run single check).

---

## 10. Flake risks

| Risk                                                                              | Where                      | How it is removed (removed, not retried)                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rate-limit sleep timing                                                           | T11 (carried over from v1) | fake server issues one 429 with `x-ratelimit-reset` = `now + 1s`; the test awaits the CLI's actual completion, never a fixed `sleep()` in the test itself                                                    |
| Date/timezone boundary in triage                                                  | T8                         | fixture computes `target_date`/`updated_at` relative to `Date.now()` in UTC at test-run time, never a hardcoded calendar date; the day-boundary invariant (§5) is asserted against the same relative fixture |
| Fixture temp-dir leakage across runs (a live handle on Windows refusing deletion) | all integration cases      | the `FIXTURE_DIRS` array + `finally`-block sweep + a before/after directory-count pin (v1's F4 pattern), carried into every new self-test file                                                               |
| Shared ledger/cache file across parallel self-test files                          | T4, T5, T9                 | `PLANE_SYNC_STATE_DIR` points at the block's own throwaway dir, never the real `.claude/campaign` — no two blocks, even in different files, ever share a ledger path                                         |
| In-process module state leaking between cases within one self-test file           | all                        | every case drives the CLI via `spawn` (a fresh child process per case, v1's existing convention) — `lastWriteAt`/throttle state and any other module-level variable never survives across cases              |
| Network or third-party call                                                       | all                        | fully stubbed by the fake server in every automated case; the one live call (deploy-day bulk sync) is manual, owner-watched, explicitly out of this suite                                                    |

---

## 11. Regression watch

- **Runs on every push:** all six red-gate commands (§6), via `npm run verify`'s new tail
  (R11/T13) — cheap: every case is a localhost fake-server round trip, no real network, in
  line with v1's own sub-15-second full-suite timing.
- **Runs nightly or on demand:** nothing additional. The real bulk `npm run plane:sync --
--max-writes 400` deploy-day run stays manual and owner-watched — it is never scheduled or
  run in CI (spec.md "Deploy-day", "No prod data, no migration").
- **How this regresses unnoticed in six months, and the check that catches it:** Plane could
  add a mandatory field to `work-items`/`comments`/`archive` that the fake server, built from
  today's contract, would still accept even though the real API would now reject the same
  body — the automated suite cannot catch a drift in the third party's own contract. The
  compensating control is `plane:triage --brief`'s `BUGS drift` count, read by every Lead
  session at start (R10's `SessionStart` hook) and trending upward being the signal, plus a
  mandatory `--dry-run`/`--check` before any large batch (spec.md "Deploy-day").
- Trust only the runner's own report: every self-test prints `ok N`/`FAIL` lines and exits
  non-zero on any failure (`process.exit(failures ? 1 : 0)`, the repo's existing convention);
  `npm run verify`'s `--continue=dependencies-successful` surfaces each failing step
  individually rather than masking it behind an earlier failure.

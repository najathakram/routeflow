# Spec — what <feature / fix name> must do

**Status:** `DRAFT`  (DRAFT | APPROVED | IMPLEMENTED | CLOSED)
**Stage:** S2 — Spec (what) · **Author:** Fable 5 · **Date:** <YYYY-MM-DD>
**Lives at:** `.claude/pipeline/<YYYY-MM-DD>-<slug>/spec.md`
**Prev:** [discovery.md](./discovery.md) · **Next:** [ux-spec.md](./ux-spec.md) (UI work) then
[test-plan.md](./test-plan.md)

> **This file is the only context downstream agents receive about *what* to build.** The test
> plan, the build plan, the implementers and the review lenses read these requirement IDs and
> nothing else. An unwritten requirement will not be built, will not be tested, and will not be
> reviewed.

*Citations below use the `G<gate>·Q<n>` form from `references/ARCHITECT-QUESTIONS.md` in the
dev-pipeline skill folder — this spec answers gates G2 (what), G4 (risk and architecture) and
G5 (how we test it).*

---

## 1. Core capability, in one sentence (G2·Q1)

> <One sentence a customer would recognise and repeat. Names the actor and the outcome. No
> table names, no framework names, no architecture.>

## 2. Core use cases, in priority order (G2·Q2)

| # | Use case (actor → action → outcome) | Priority | Justifies shipping |
|---|---|---|---|
| U1 | As a <role>, I <do X> so that <outcome> | must | ★ |
| U2 | <...> | must / should / could | |
| U3 | <...> | <...> | |

*Exactly one row carries ★: the single use case that, working alone, would make this worth
shipping. If you cannot pick one, the scope is wrong — return to
[discovery.md](./discovery.md).*

## 3. Completeness sweep (G2·Q3)

Walk **every** row. A decision is `keep` (this release), `defer` (named follow-up), or `n/a`
(with a reason). "Didn't think about it" is not a decision, and a blank cell fails the
spec-compliance lens.

| Lifecycle step | What it means for this feature | Decision | Req IDs | Note / why deferred |
|---|---|---|---|---|
| Create | <how the thing comes into existence> | keep / defer / n/a | R# | <...> |
| Read (detail) | <viewing one> | <...> | R# | <...> |
| List / filter / search | <finding it among many> | <...> | R# | <...> |
| Edit / update | <changing it, and what may not change> | <...> | R# | <...> |
| Delete / archive | <soft or hard, and who may> | <...> | R# | <...> |
| Undo / reverse | <the reverse of every action above — uncancel, unassign, restore, refund> | <...> | R# | <...> |
| Permissions | <which role may do each row above; owner vs admin vs read-only> | <...> | R# | <...> |
| Audit trail | <who did what, when — and where it is visible> | <...> | R# | <...> |
| Notification | <who is told, through which channel, and can they opt out> | <...> | R# | <...> |
| Export / print / share | <getting the data back out> | <...> | R# | <...> |

*Add rows for anything else this feature implies (import, bulk edit, scheduling, attachments).
Every action you keep must have its reverse considered on the Undo row.*

## 4. States, per surface (G2·Q4)

Duplicate the block below for every surface: each page, modal, list, mobile screen, email,
export, and API response. `n/a` needs a reason.

### Surface: <e.g. "Routes list — web">

| State | Required behavior (what the user sees and can do) | Req ID |
|---|---|---|
| Empty | <first-run copy plus the primary action; not a blank box> | R# |
| Loading | <skeleton or spinner placement; no layout jump> | R# |
| Partial | <some data loaded, some failed — what shows, what warns> | R# |
| Error | <message the user can act on; retry path; what is logged> | R# |
| Offline / request failed | <queued, read-only, or blocked — say which> | R# |
| Unauthorized | <wrong role or wrong tenant/owner: hidden vs visible-but-denied> | R# |
| Too much data | <page size, cap, truncation notice, server-side filter> | R# |
| Stale | <data changed since load — refresh cue or auto-refresh> | R# |
| Concurrent edit | <two users at once: last-write-wins, version check, or lock> | R# |

### Surface: <next surface>

<duplicate the table above>

## 5. Non-functional requirements

| Area | Requirement | Budget / rule | Req ID |
|---|---|---|---|
| Performance (G4·Q6) | <no new N+1; list queries bounded; no synchronous call in a hot path> | <p95 target, max rows, max payload> | R# |
| Security and authorization (G4·Q12) | <every new endpoint states who may call it; no secrets in code or logs> | <role matrix> | R# |
| Tenancy / ownership scoping (G4·Q5, G4·Q12) | <every new query filtered by tenant or owner; no unscoped bulk write or bulk delete> | <the scoping key> | R# |
| Observability (G4·Q8) | <at 2am when this fails, what in the logs or metrics says so> | <log line / metric / alert> | R# |
| Accessibility | <keyboard reachable, focus visible, labelled controls, contrast, target size> | <the repo's baseline> | R# |
| Idempotency (G4·Q3) | <what happens if it runs twice, or two people act at once> | <key / guard> | R# |
| Data retention / PII | <what is stored, for how long, who can read it> | <...> | R# |

*Delete a row only when it is genuinely inapplicable, and say why. Accessibility is a
requirement here, not a review nit.*

## 6. Overlap and scope fence (G2·Q6)

- **Existing feature this overlaps:** <name + path> → **decision:** extend it / add new, because
  <...>. *(A second way to do the same thing needs a written justification.)*
- **In scope:** <the bounded list>
- **Out of scope:** <non-goals from [discovery.md](./discovery.md) plus anything ruled out here>
- **Do-not-introduce check (G4·Q10):** <does this add a dependency, a second HTTP client, a second
  test runner, or anything on the repo's do-not-introduce list?>

## 7. Deploy day (G2·Q7)

- **Existing users on deploy day:** <what changes under them without warning; what they see first>
- **Existing data:** <does data created before this satisfy the new rules? what do old rows look
  like in the new UI?>
- **Backfill:** <needed? which script, scoped how, dry-run first, reversible, who runs it, before
  or after the deploy>
- **Migration (G4·Q5):** <reversible? does the old running code tolerate the new schema during the
  rollout window?>

**If this feature is gated by a flag, plan, or entitlement, fill this table. Every column.**

| Gate | Exact key the gate **reads** | What grants it (UI screen / script / plan activation) | Exact key that path **writes** | Keys match? | Existing users get it how? |
|---|---|---|---|---|---|
| <gate name> | `<key>` | <admin toggle at <path> / script <path> / SKU activation> | `<key>` | yes / **no** | <backfill / default-on / manual> |

> A gate with no way to grant it is a self-inflicted outage: every user is denied on day one and
> nothing in the product can fix it. If the granting path writes a different key than the gate
> reads, **this spec is not done** — fix it here, not in review.

## 8. Rollback (G2·Q9)

- **Kill switch:** <config or flag that disables this without a deploy — or "none", explicitly>
- **Code rollback:** <safe to revert the commit? what breaks if we do?>
- **Data rollback:** <what this writes that a revert leaves behind, and how to reverse it>
- **Blast radius (G4·Q1):** <worst thing a bug here can do — money wrong, data lost, cross-tenant
  leak, a message sent to a real customer>
- **Detection:** <what tells us it is wrong in production, and how fast>

## 9. Requirements table

The spine of the pipeline. Every downstream artifact references these IDs: the test plan maps
each R# to tests, the build plan declares `satisfies:` R#s, the review lenses walk this table.

| ID | Requirement (observable behavior, not implementation) | Priority | Verification method | Test IDs |
|---|---|---|---|---|
| R1 | <the system does X when Y, and Z is then true> | must | unit / property / contract / integration / e2e (Playwright) / manual + reason | <filled at S4> |
| R2 | <...> | should | <...> | |
| R3 | <...> | could | <...> | |

Rules:

- One observable behavior per row. If it needs "and" twice, split it.
- Write it so it **can fail**. If no run of the system could falsify the row, it is not a
  requirement — rewrite it (G5·Q5).
- Priority is `must` | `should` | `could`. `must` rows block the release; `could` rows must
  survive being cut.
- Verification method is the **lowest level that can fail for the right reason**. `manual` is a
  last resort and needs a written reason.
- Test IDs stay blank here and are filled in at S4 from [test-plan.md](./test-plan.md). No row
  may still be blank when S4 closes.
- The thing that must **not** happen gets its own R# too (G5·Q6): unauthorized access denied, no
  cross-tenant read, no double charge.
- A row that rests on an unchecked premise cites it: "(A2)" from §10. A requirement whose premise is
  refuted is rewritten, not tested.

## 10. Assumptions (unverified) — MANDATORY

Every row of §9 reads as settled fact downstream: the test plan turns it into tests, the build plan
declares `satisfies:` against it, implementers build it, the review lenses judge the code by it. No
reader can tell which rows rest on something nobody checked — so mark them here. **Fill this before
the file leaves `DRAFT`.**

| # | Claim, as this file states it (and its §) | Basis | What would confirm it | R#s that fall with it | What breaks if it is wrong | Status |
|---|---|---|---|---|---|---|
| A1 | <"§4: a tenant's list never exceeds 500 rows"> | read off a log / inferred from code / requester said it / industry norm / my guess | <one query, reading one file, one call against a sandbox> | R7, R9 | <pagination unspecified; the §5 perf budget is fiction> | unverified / confirmed <YYYY-MM-DD> / refuted <YYYY-MM-DD> |
| A2 | <...> | <...> | <...> | <...> | <...> | <...> |

Rules:

- **Every claim about how the system behaves TODAY that you did not read in the code goes here.**
  §3 and §4 are built out of them — "editing already re-validates", "the list is already scoped by
  tenant", "there is no offline path today".
- Every budget in §5 that was not measured: p95 target, max rows, max payload, retention window.
- §7's gate table: if you did not open the code that writes the granting key, the "keys match: yes"
  cell is an assumption — and it is the one that denies every user on day one.
- Carry forward every unresolved row from discovery §12 that any R# depends on, restated in full and
  keeping its number as `D-A1`. The engine names the discovery file to agents only when the
  orchestrator passes `discoveryPath`, so write for a reader holding this spec alone — restate,
  never link.
- The Verification method column in §9 does not cover this. A test proves the code does what the
  spec says; nothing in the run proves the spec assumed the right thing.
- Name a real path, command, script, config key or exported symbol in the confirm column whenever
  one exists: the pipeline engine's Baseline phase grounds exactly those five kinds of claim against
  the repo and files a finding for each that does not exist — `major` for a missing path, directory,
  command, script or config key, `minor` for a symbol it cannot resolve. Those findings enter the
  fix loop and keep the run unclean until fixed.
- That check is **all** the machine does. Nothing verifies a claim about people, volumes, cost,
  timing, third-party behavior, or what production data looks like. This table is the only warning
  a downstream agent gets that a line is plausible rather than checked.
- A refuted row invalidates its R#s: rewrite them here before S4. A test built on a false premise
  passes and proves nothing.

---

## STOP GATE — S2 → S3 / S4

- [ ] Core capability is one sentence a customer would recognise
- [ ] Exactly one ★ use case
- [ ] Completeness sweep has an explicit decision on every row
- [ ] Every surface has all nine states, or an `n/a` with a reason
- [ ] NFRs cover performance, authorization, tenancy/ownership scoping, observability, accessibility
- [ ] Deploy day answered, including the gate-key match table when gated
- [ ] Rollback and blast radius written
- [ ] Every requirement has an ID, a priority, and a verification method
- [ ] No requirement restates the implementation ("calls function X") instead of the behavior
- [ ] At least one negative requirement
- [ ] Assumptions block filled — every unverified premise, what would confirm it, the R#s that fall with it (§10)

## Stage log — did the gate fire?

Record the answer, not the intention. No phase of the pipeline engine evaluates the checklist above
— its Baseline phase grounds this file's mechanical claims against the repo, and nothing reads a
STOP condition. A blank block means the gate did not happen.

| Stop condition | Evaluated? | What it answered | Evidence | Verdict |
|---|---|---|---|---|
| Completeness sweep has a decision on every row | yes / no | <the answer, in a few words> | §3 | pass / **STOP** |
| Every surface covers all nine states, or `n/a` with a reason | yes / no | <...> | §4 | pass / **STOP** |
| The key the gate reads is the key the granting path writes | yes / no / n/a — ungated | <...> | §7 | pass / **STOP** |
| Rollback, blast radius and detection written | yes / no | <...> | §8 | pass / **STOP** |
| Every R# has a priority and a verification method; at least one negative R# | yes / no | <...> | §9 | pass / **STOP** |

- **Gate outcome:** PASS — S3/S4 may start · **STOP** — returned to <whom> on <YYYY-MM-DD> · OVERRIDDEN
- **Overridden by:** <name> — <why>. An override is a named decision, not a formality.
- **Assumptions carried into S4:** <A# list from §10, or "none">

`Evaluated? no` is a legitimate answer and more useful than a tick nobody earned. Report this block
at close-out beside the run's `phaseReport`: if this gate has never once answered **STOP** across
ten real runs, it is filtering nothing — tighten it or drop it.

**Next:** UI work → [ux-spec.md](./ux-spec.md) (S3 — derive the design system from the codebase
before designing anything). Everything else → [test-plan.md](./test-plan.md) (S4).

**Approved by:** <name> · **on:** <YYYY-MM-DD>

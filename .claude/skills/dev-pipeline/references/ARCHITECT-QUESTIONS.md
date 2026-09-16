# Architect questions — the interrogation before any code

The questions a senior engineer with twenty years of production scars asks _before_ the first
file is opened. Five gates, one per pipeline stage. Cite a question as `G2·Q7`.

## How to use this

- **Answer in writing, in the artifact — not in your head.** G1 → [`discovery.md`](../templates/DISCOVERY.md),
  G2 → [`spec.md`](../templates/SPEC.md) (UI also [`ux-spec.md`](../templates/UX-SPEC.md)),
  G3 → the risks/alternatives section of the spec, G4 → spec + [`build-plan.md`](../templates/BUILD-PLAN.md),
  G5 → [`test-plan.md`](../templates/TEST-PLAN.md). Downstream agents read the files, not this session.
- **An unanswerable question is itself a finding.** Write `UNKNOWN — <who must answer> — <by when>`
  and carry it into the risk list. Never silently drop it, never guess and phrase the guess as fact.
- **Not every question applies.** Mark it `N/A — <one-line reason>`. That reason is the evidence you
  considered it. An unmarked question reads as unasked.
- **An answer must be falsifiable.** "Users will be happier" is not an answer. A number, a name, a
  date, a behavior, or a decision is.
- **Restating the question is not answering it.** If the answer paraphrases the ask, go back.
- The **QUICK PASS** at the bottom is the floor for small work. Small is not an excuse to skip the
  routine; it is a reason to run a shorter one.

---

## G1 — Why (problem before solution)

Stage S1. Output: [`discovery.md`](../templates/DISCOVERY.md).

1. What is the problem in the user's own words, and whose problem is it — which role, how often do
   they hit it, and what does it cost them today (minutes, money, errors, calls)?
2. What are they doing instead right now? Why is that workaround insufficient?
3. Why now? What triggered the ask — a complaint, a lost deal, an incident, a regulation, a renewal?
4. If we ship nothing, what actually happens? (If "not much" — stop and say so.)
5. How will we know it worked: one observable signal, with today's baseline number and where that
   number is read from.
6. Who else is affected that nobody asked — support, ops, finance, admins, the person in the field?
7. Is this request a symptom? Would fixing the root cause make it disappear entirely?
8. Are we solving the problem, or building the solution someone already picked?
9. What is it worth — how many users, how much money or time saved per month — and is that more than
   the build cost plus the cost of running it forever?
10. Who owns this after it ships: who maintains it, who gets paged, who fixes it in six months — and
    has that person seen this?
11. What does building this displace? Name what is _not_ getting done instead.
12. What new questions will support and ops receive once this exists, and what is the self-serve
    answer that stops them becoming tickets?

> **STOP CONDITION — G1.** Stop and go back to the requester if: nothing observable changes when this
> ships; the answer to Q4 is "not much"; you cannot name the role that hits the problem or how often;
> or nobody owns it after ship. An unowned feature with no success signal is a liability with a
> release note. Say so out loud rather than proceeding quietly.

**What good looks like**

- **Q5 (success signal).** "Median time from order created to driver assigned drops from 14 min
  (30-day median, dispatch log) to under 5. Same query, same dashboard, checked one week after ship."
- **Q7 (symptom check).** "They asked for a CSV export because the list cannot filter by date. Fix
  the filter and the request disappears; export stays, demoted to P3."
- **Q10 (ownership).** "Owned by the team that owns billing; already on their on-call rota; their
  lead read the discovery and agreed to carry it."

---

## G2 — What (core feature, then completeness)

Stage S2/S3. Output: [`spec.md`](../templates/SPEC.md) — every answer becomes an `R#` or a non-goal.

1. State the core capability in one sentence a customer would recognize.
2. What are the core use cases, in priority order? Which single one, if it worked, would make this
   worth shipping?
3. What is the _complete_ experience — what must exist beside it so it doesn't feel half-built? Walk
   the lifecycle: create, read, list/filter/search, edit, delete/undo, permissions, audit trail,
   notification, export, and the reverse of every action.
4. What states must every surface handle: empty, loading, partial, error, offline, unauthorized,
   too-much-data, stale, concurrent edit?
5. What are the explicit non-goals? Write them down — they are the scope fence.
6. What existing feature does this overlap? Should we extend it rather than add a second way to do
   the same thing?
7. What happens on deploy day to users and data that already exist? Is a backfill needed? If this is
   gated by a flag/plan/entitlement, **what UI or script actually grants it**, and does the granting
   path write the exact key the gate reads? _A gate nothing can grant is a self-inflicted outage —
   every user gets a 403 on a feature that shipped._
8. What is the default for existing users, and is that default safe if nobody ever touches it?
9. What is the rollback story if this is wrong in production?
10. What data does this create or collect? Who can see it, how long is it kept, can it be exported
    and deleted on request, and does an audit trail record who changed it?
11. Which other clients consume the same API or data shape (web, mobile, integrations, reports)? Must
    they ship in lockstep, or is the wire shape additive and back-compatible?
12. What locale assumptions does this bake in — timezone, currency, units, number and date format,
    translated strings?
13. What accessibility duty applies to the new surfaces (keyboard path, labels, contrast, target
    size)? Write it as a requirement in the spec, not as a review nit.
14. What must be documented, and who tells existing users — release note, in-product help, admin
    guide, a briefing for support?

> **STOP CONDITION — G2.** Stop if: you cannot list the non-goals; the completeness walk (Q3) surfaces
> more missing than present while the ask was described as small; the state matrix (Q4) has no answer
> for error or unauthorized; or the feature is gated by something no UI, script, or SKU can turn on.
> In that last case the correct output is a bug report, not a build plan.

**What good looks like**

- **Q3 (completeness).** "Create/edit/list in scope. Delete is soft with 30-day undo. Permissions
  reuse the existing role check. Every mutation writes an audit row. No export in v1 — non-goal N3."
- **Q7 (deploy day + grantable gate).** "Gate reads addon key `route_replay`. The admin add-on toggle
  writes exactly `route_replay` — verified in the activation code path. Existing tenants default off
  and see today's behavior; no backfill."
- **Q10 (data lifecycle).** "One row per scan: user id, timestamp, result code — no document
  contents. Purged at 90 days by the existing retention job. Deletable from the admin record view."

---

## G3 — Is this plan right (validate before building)

Stage S3/S5. Output: the risks and alternatives sections of the spec and build plan.

1. What is the riskiest assumption here, and what is the cheapest thing that would kill it?
2. Which requirement, if wrong, wastes the most work? Validate that one first.
3. Where is the prior art — in this repo, in the golden-reference app, in a competitor, in a library?
4. **What would a reviewer who hates this plan say?** Write their strongest objection down verbatim
   and answer it. If you cannot state the objection, you have not understood the plan.
5. **Restate the request back in your own words: would the requester agree that is what they asked
   for?** If you would not bet on "yes", ask before building.
6. What have we assumed that nobody has confirmed?
7. What is the quarter-size version — what would we build with a quarter of the time — and exactly
   why is that not enough? If it is enough, build that.
8. Buy or build: does a library or service already do this? What is its licence, cost, maintenance
   status, and what does depending on it lock us into?
9. What does this decision foreclose? Name the one-way doors — data model, URL and API shape,
   exported file format, vendor — and price the reversal a year from now.
10. Can this ship in slices that are each independently useful and independently revertible? What is
    slice one?
11. Who must approve besides the requester — security, finance, legal, the client whose data this
    touches? When do they see it?
12. After this ships, how many people can safely change it? If the answer is one, what gets written
    down now so it isn't?

> **STOP CONDITION — G3.** Stop if: the hostile reviewer's objection (Q4) has no answer, only a shrug;
> the restatement (Q5) would surprise the requester; or the riskiest assumption is both unvalidated
> and expensive to be wrong about. The move is a spike, a prototype, or one question to a human — not
> a build plan stacked on an unchecked assumption.

**What good looks like**

- **Q1 (riskiest assumption).** "'The provider returns tax per line, not per invoice.' Cheapest kill:
  one sandbox API call, 20 minutes, before any code. If it is per invoice, R4 and R7 change."
- **Q4 (hostile reviewer).** "'You are adding a second way to assign a driver.' Answer: package P4
  deletes the bulk assigner in the same change; only one path survives, and a test asserts the old
  route is gone."
- **Q9 (one-way door).** "Exported column order and the public URL become an integration contract.
  Both are decided now, and the export carries a version header so v2 can differ."

---

## G4 — Risk and architecture

Stage S5. Output: build-plan risk notes, and the `scale` decision (`small` vs `major`).

1. **Blast radius:** what is the worst thing a bug here can do — money wrong, data lost, cross-tenant
   leak, a message sent to a real customer, a driver sent to the wrong address? _Blast radius, not
   code volume, sets test depth and review scale._
2. Does this touch money, auth, tenancy, PII, migrations, or anything irreversible? If so, escalate
   scale to `major` and add property-based tests.
3. What if it runs twice, or two people do it at once? Is it idempotent, and what wins on conflict?
4. If step 3 of 5 fails, what state is the system left in, and who or what cleans it up?
5. Is the migration reversible? Is any bulk write unscoped? (A delete or update with no tenant/owner
   predicate is a data-loss incident waiting for one over-broad token.)
6. Performance: new N+1, unbounded list, missing index, synchronous call in a hot path?
7. What limits does this enforce — page size, upload size, request rate, result cap — so one user
   cannot degrade everyone?
8. Observability: at 2am when this fails, what in the logs or metrics says so, and how does the
   person on call tell "broken" from "nobody used it"?
9. What does the runbook say: how to diagnose it, how to turn it off without a deploy, how to drain
   or replay whatever queued while it was off?
10. Coupling: does this add a dependency, a second HTTP client, a second way to do an existing thing,
    or anything on the repo's do-not-introduce list?
11. Third party: what happens when the vendor is down, rate-limits us, deprecates the endpoint, or
    raises the price? Is there a degraded mode, and is the licence compatible with shipping this
    commercially?
12. Security: authorization on every new endpoint, tenant/ownership scoping on every new query, no
    secrets in code, logs, URLs, or error messages.
13. Run cost: what does this cost per month at today's volume and at ten times it — compute, storage,
    per-call fees — and what cap or quota stops a runaway?
14. Environment parity: does this need a new env var, secret, service, or migration in every
    environment? When it is missing, does it fail closed or fail open — and which is correct here?

> **STOP CONDITION — G4.** Stop and design before coding when the blast radius includes money, data
> loss, cross-tenant exposure, or contact with a real customer AND any of these is missing: a
> rollback, scoping on every write, or a signal that tells on-call it broke. Stop equally if a new
> gate, flag, or entitlement still has no granting path — that is G2·Q7 unresolved.

**What good looks like**

- **Q1 (blast radius).** "Worst case: a boxed line invoiced at the piece price — money wrong,
  customer-visible, unwound by hand. Scale `major`; property tests on the pricing helper; a negative
  test per rounding path."
- **Q8 (observability).** "The failure logs one line with request id, tenant, and provider error
  code; the existing error dashboard groups on that code, so the alert fires within five minutes."
- **Q13 (run cost).** "One provider call per imported row at $0.004; 2k rows/month = $8 today, $80 at
  10x. A per-tenant monthly cap fails closed with an explicit message rather than silently."

---

## G5 — How do we test it

Stage S4. Output: [`test-plan.md`](../templates/TEST-PLAN.md). Method and commands live in
[`TESTING-PLAYBOOK.md`](TESTING-PLAYBOOK.md).

1. For each requirement, what observable behavior proves it? Write it Given/When/Then.
2. What is the lowest level that can fail for the right reason — unit, property, contract,
   integration, or e2e? Put the test there.
3. What is the oracle: what makes the expected value _known_, rather than copied out of the
   implementation you are about to write?
4. Which invariants deserve property-based tests — money, quantities, dates, permissions?
5. Would this test fail today, before the change? If nothing can fail, the requirement is not yet
   testable — rewrite the requirement.
6. What is the negative test — the thing that must NOT happen (the unauthorized caller, the other
   tenant, the double submit)?
7. Where is the flake risk, and how do we remove time-based waiting from the test?
8. How would we notice this regressing in six months, and is that check in CI?
9. Does test depth match the blast radius from G4·Q1 — deep for money/auth/tenancy, one test for a
   label change? Say where you deliberately went shallow, and why.
10. What data does the test need? Can the test create and destroy it itself, on a disposable tenant
    or account, so no run depends on data a human can change?
11. Which existing tests will now fail on purpose? Update them to the stated behavior change — never
    bend an assertion to green without naming the requirement that authorizes it.
12. What cannot be automated? Name the manual check, who runs it, on what data, and where the
    checklist lives.
13. What is the suite's runtime? Does it belong on every push or nightly, and what is the budget?
14. When it fails in CI with nobody watching, what is left behind to diagnose it — trace, screenshot,
    video, logs?
15. What proves the tests actually ran, rather than a cached replay reprinting an earlier log?

> **STOP CONDITION — G5.** Stop if: any `R#` maps to no `T#`; any `T#` maps to no `R#`; a test's
> oracle is "whatever the new code returns"; or no proposed test can fail today. Each of those means
> the requirement is not yet a requirement. Rewrite it before a line of implementation is authored —
> tests written afterwards only prove the code does what it does.

**What good looks like**

- **Q3 (oracle).** "Expected totals come from the worked example in the spec, computed by hand and
  confirmed by the requester — not from running the new code and pasting its output."
- **Q5 (fails today).** "Ran the new spec against the current build: it fails on `expected 3 rows,
received 0` — an assertion failure, not an import or config error."
- **Q7 (flake).** "No sleeps. The spec waits on an auto-retrying assertion that the row is visible,
  and the fixture creates its own record, so no concurrent run can move it."

---

## QUICK PASS — the 12-line floor for small work

Small changes skip the artifacts, never the thinking. Answer these twelve in the task notes; any
"I don't know" promotes the work to the full gates.

1. Whose problem is it, how often do they hit it, and what does it cost them today?
2. What are they doing instead, and why is that not enough?
3. If we ship nothing, what actually happens?
4. One observable signal it worked — with today's number.
5. The core capability in one sentence, and the non-goals in one line.
6. What else must exist so it isn't half-built — states, permissions, the reverse of every action?
7. Deploy day: existing users and existing data — and if it's gated, what actually grants the gate?
8. Blast radius: money, data loss, cross-tenant leak, a message to a real customer?
9. How do we roll this back in production?
10. What would a reviewer who hates this say, and what is the answer?
11. Which test fails today and goes green only because of this change?
12. Who owns it in six months, and what will support be asked once it exists?

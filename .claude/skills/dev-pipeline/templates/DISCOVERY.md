# Discovery — why <feature / fix name>

**Status:** `DRAFT` (DRAFT | APPROVED | IMPLEMENTED | CLOSED)
**Stage:** S1 — Discovery (why) · **Author:** Fable 5 · **Date:** <YYYY-MM-DD>
**Lives at:** `.claude/pipeline/<YYYY-MM-DD>-<slug>/discovery.md`
**Next:** [spec.md](./spec.md) — do not start it until the STOP GATE at the bottom passes.

> **This file is the only context downstream agents receive about _why_ this work exists.**
> No chat history, no ticket, no link is read for them. If a fact matters, write it here in
> full. `TBD` is a blocker, not a placeholder — chase it or record the assumption you made
> in §12 instead.

_Citations below are in the `G#·Q#` form used by gates G1, G2 and G3 of
`references/ARCHITECT-QUESTIONS.md` in the dev-pipeline skill folder._

---

## 1. The problem, in the requester's own words (G1·Q1)

> <verbatim quote of the ask — their words, their framing. Do not translate a complaint into
> a solution here.>

**Restated in our words:** <one paragraph. Test: would the requester read this and say "yes,
that's what I meant"? If not, you have misread the ask — go back. (G3·Q5)>

**Source:** <who asked, when, in what channel — a call, a support ticket, an incident review>

## 2. Who has this problem (G1·Q1)

| Role              | How often they hit it | What it costs them today (time / money / errors / risk) | How we know (evidence, not guess)          |
| ----------------- | --------------------- | ------------------------------------------------------- | ------------------------------------------ |
| <e.g. dispatcher> | <e.g. 6–10× per day>  | <e.g. ~15 min each, re-keyed by hand>                   | <ticket #, call note, log query, observed> |

_If this row set is one person once a month, say so — that is a real finding, not a failure._

## 3. What they do instead today (G1·Q2)

- **Current workaround:** <the actual steps they take now — spreadsheet, phone call, manual edit, nothing>
- **Why it fails:** <what breaks, how often, who notices>
- **Cost of the workaround:** <time, rework, errors, risk it creates>

_No workaround at all is itself an answer — write "none; the task simply doesn't get done"._

## 4. Why now (G1·Q3)

<What triggered the ask: a complaint, a lost deal, an incident, a regulation, a competitor,
a client onboarding, a deadline. "It came up" is not a trigger — find the real one.>

**Deadline / external date, if any:** <date + what happens on it>

## 5. If we ship nothing (G1·Q4)

<Honest answer. Who is hurt, how much, by when.>

> If the honest answer is **"not much"**, stop here and say so in the report. Cheap to write,
> expensive to build. Recommend closing or shrinking the ask instead.

## 6. Success signal — one, observable (G1·Q5)

| Signal                                                         | Today's baseline                 | Target               | Where it is measured                            | When we check             |
| -------------------------------------------------------------- | -------------------------------- | -------------------- | ----------------------------------------------- | ------------------------- |
| <the one number or observable event that moves if this worked> | <today's value + how you got it> | <value or direction> | <log, metric, report, query, user confirmation> | <e.g. 2 weeks after ship> |

_One signal. Not three. If it cannot be observed after shipping, it is not a success signal —
pick a different one. "Users are happier" is not observable; "dispatcher no longer edits the
CSV" is._

## 7. Everyone else affected that nobody asked (G1·Q6)

| Party                             | How this touches them                           | What they need from us | Consulted?       |
| --------------------------------- | ----------------------------------------------- | ---------------------- | ---------------- |
| Support                           | <new questions they will field, docs they need> | <...>                  | <yes / no / n/a> |
| Ops / field user                  | <...>                                           | <...>                  | <...>            |
| Finance / billing                 | <...>                                           | <...>                  | <...>            |
| Admin / owner                     | <who configures or grants this>                 | <...>                  | <...>            |
| Downstream systems / integrations | <...>                                           | <...>                  | <...>            |

_Delete rows that genuinely do not apply. An untouched row set usually means nobody looked._

## 8. Root-cause check — is this a symptom? (G1·Q7, G1·Q8)

- **Symptom or cause:** <symptom | root cause>
- **If a symptom, the root cause is:** <...>
- **Would fixing the root cause delete this request entirely?** <yes / no — and if yes, why are
  we not doing that instead?>
- **Are we solving the problem, or building the solution the requester already picked?**
  <name the picked solution, then name at least one alternative that solves the same problem>
- **Prior art (G3·Q3):** <existing feature in this repo / the golden-reference app / a competitor
  that already does this — path or name>

## 9. Riskiest assumption and the cheapest way to kill it (G3·Q1, G3·Q6)

| #   | Assumption                                   | If it is wrong, what breaks             | Cheapest thing that would kill it                                             | Cost      | Result                    |
| --- | -------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- | --------- | ------------------------- |
| A1  | <the one that wastes the most work if false> | <scope collapses / rework / wrong user> | <one query, a 20-line spike, one question to the requester, reading one file> | <minutes> | <pending / held / killed> |
| A2  | <...>                                        | <...>                                   | <...>                                                                         | <...>     | <...>                     |

_Kill A1 **before** writing the spec whenever the check costs less than an hour. Whatever
survives unkilled is repeated in §12._

## 10. Non-goals — the scope fence (G2·Q5)

- <thing we are explicitly NOT doing> — <why: out of scope, later phase, different problem>
- <...>

_Anything not listed as in-scope in [spec.md](./spec.md) is out of scope by default. These
lines exist to stop the scope argument later, so name the tempting adjacent things._

## 11. Open questions for the requester

| #   | Question | What decision it unblocks | Blocking S2? | Answer / assumption made           |
| --- | -------- | ------------------------- | ------------ | ---------------------------------- |
| Q1  | <...>    | <...>                     | yes / no     | <answer, or "assumed X — confirm"> |

_Ask every blocking question before starting the spec. For non-blocking ones, write down the
assumption you proceeded on so a reviewer can challenge it._

## 12. Assumptions (unverified) — MANDATORY

Everything above reads as settled fact downstream: agents get this file and no chat history, no
ticket, no call. This block is where you mark the lines nobody actually checked. **Fill it before
this file leaves `DRAFT`.** An empty table is itself a claim — that every statement in §1–§11 came
from a named source. Make that true, or write rows.

| #   | Claim, as this file states it (and its §)  | Basis                                                                              | What would confirm it                                                                                             | What breaks if it is wrong                                                | Status                                                     |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A1  | <"§2: dispatchers hit this 6–10× per day"> | requester said it / read off a log / inferred from code / industry norm / my guess | <the cheapest thing that settles it: one query, one question to the requester, reading one file, a 20-line spike> | <what collapses — the user, the scope, the success signal, the whole ask> | unverified / confirmed <YYYY-MM-DD> / refuted <YYYY-MM-DD> |
| A2  | <...>                                      | <...>                                                                              | <...>                                                                                                             | <...>                                                                     | <...>                                                      |

Rules:

- IDs share one namespace with §9: an assumption carried down from there keeps its number, new
  ones continue from the highest used. §9 names the one worth killing _before_ the spec; this
  table is the full ledger of what is still unchecked when the file ships.
- **Every number above that was not read off a system belongs here** — the frequencies and costs
  in §2, the baseline in §6.
- Repeat here every `TBD`, every "assumed X" from §11, and every §9 row still `pending`.
- List what you assumed about things **outside this repo** too: what a third party returns, what
  production data looks like, what a role is permitted to do, what a person will actually do.
- Never state an assumption as fact in the prose above. Hedge it there, or cite the row — "(A3)".
- Name a real path, command, script, config key or exported symbol in the confirm column whenever
  one exists. The pipeline engine's Baseline phase runs a grounding agent over this file, checks
  exactly those five kinds of claim against the repo, and files a finding for each one that does
  not exist — `major` for a missing path, directory, command, script or config key, `minor` for a
  symbol it cannot resolve. Those findings enter the fix loop and keep the run unclean until fixed.
- That check is **all** the machine does. Nothing verifies a claim about people, volumes, cost,
  timing, or another system's behavior, and no downstream agent can tell a checked line from a
  plausible one. This table is the only warning it gets.
- A row that turns out true keeps its evidence in the confirm column and stops being an assumption.
  A row that turns out false means rewriting the sections it holds up — name them.

---

## STOP GATE — S1 → S2

- [ ] Problem stated in the requester's own words **and** restated in ours
- [ ] User named: role + frequency + cost today
- [ ] Current workaround named, and why it fails
- [ ] One observable success signal **with today's baseline**
- [ ] "If we ship nothing" answered honestly
- [ ] Root-cause check done — we are not building a solution to a symptom by reflex
- [ ] Riskiest assumption named, with a check that costs less than the build
- [ ] Non-goals written down
- [ ] Every blocking open question answered, or the assumption recorded
- [ ] Assumptions block filled — every unchecked claim, what would confirm it, what it breaks (§12)

**If problem, user, workaround, or success signal is blank or `TBD`, do not write the spec.**
Go back to the requester. A spec built on a blank _why_ produces code nobody uses, and every
downstream stage inherits the error.

## Stage log — did the gate fire?

Record the answer, not the intention. Nothing in the pipeline engine evaluates the checklist above:
its Baseline phase only grounds this file's mechanical claims against the repo, and no later phase
reads a STOP condition at all. A blank block means the gate did not happen.

| Stop condition                                 | Evaluated? | What it answered             | Evidence   | Verdict         |
| ---------------------------------------------- | ---------- | ---------------------------- | ---------- | --------------- |
| Shipping nothing is materially bad             | yes / no   | <the answer, in a few words> | §5         | pass / **STOP** |
| The ask is a cause, not a symptom              | yes / no   | <...>                        | §8         | pass / **STOP** |
| User, workaround and success signal all stated | yes / no   | <...>                        | §2, §3, §6 | pass / **STOP** |
| Every blocking open question answered          | yes / no   | <...>                        | §11        | pass / **STOP** |

- **Gate outcome:** PASS — S2 may start · **STOP** — returned to <whom> on <YYYY-MM-DD> · OVERRIDDEN
- **Overridden by:** <name> — <why>. An override is a named decision, not a formality.
- **Assumptions carried into S2:** <A# list from §12, or "none">

`Evaluated? no` is a legitimate answer and more useful than a tick nobody earned. Report this block
at close-out beside the run's `phaseReport`: a gate that has answered PASS on every run it has ever
seen is filtering nothing — after ten real runs with no **STOP**, tighten it or drop it.

**Approved by:** <name> · **on:** <YYYY-MM-DD>

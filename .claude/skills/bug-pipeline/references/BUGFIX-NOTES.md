# Why the bug pipeline is shaped this way — the measured evidence (2026-09-03)

Every design choice traces to an instrumented run or a paid-for lesson. Sources: F13 (`wf_72a623d9-cd7`, a
5-bug batch on recurring invoices / standing orders), imp-03a (`wf_3da581bd-b9a`, an infra hardening batch),
the F06/F10/F11/F14 campaign journals, and the RouteFlow lessons register.

## Radius-scoped review (bugfix mode's radius pack)

Per-lens attribution of F13's Gate & Review findings (derived by matching agent prompts to the engine's lens
templates; refuter votes linked by the finding JSON embedded in each refuter prompt, 44/44 matched):

| Lens | Reported | Survived | Overturned | In-radius / out |
|---|---|---|---|---|
| correctness | 7 | 6 | 1 | 6/0 |
| spec-compliance | 6 | 6 | 0 | 6/0 |
| edge-cases-and-security | 6 | 6 | 0 | 6/0 |
| operability | 8 | 6 | 2 | 6/0 |
| scope-coverage | 4 | 4 | 0 | 4/0 |
| test-quality | 3 | 3 | 0 | 3/0 |
| design-system | 3 | 0 | 3 | 0/0 |

**31/31 survivors inside the bug's blast radius, 0 outside.** Bug review needs depth on the radius, not
whole-diff breadth — hence the Sonnet-built radius pack as every lens's primary evidence. Contrast imp-03a
(infra batch): breadth catches (a prod-migrate env abort silently removed, an over-fatal drift gate, a skip
guard that did not skip) — which is why the FEATURE pipeline keeps whole-diff reads.

## Every lens stays; one is gated

No lens reported zero in either run — the lens SET is untouchable. But design-system in F13 went 3 reported,
3 overturned, 0 survived on a batch with minor UI touches: it is gated on UI files being in the diff, the one
evidence-backed drop.

## Corroboration skips the refuter, never the drop rule

F13's top blocker was independently reported by SIX lenses; imp-03a's by four. Multi-lens corroboration is
cheaper confidence than an Opus refuter vote (F13's refuters: 16% overturn overall, and the overturned were
single-lens findings; imp-03a: 36 votes bought 0 drops). Findings corroborated by ≥ 2 lenses go straight to the
fixers. The two-must-agree DROP rule is unchanged everywhere — corroboration substitutes only for the confirm
side.

## Harness-integrity check

F13's costliest blocker cascade was ONE stale mock (an `OrdersService` test double missing three methods the fix
newly calls) tripping six lenses and three tests. A Sonnet `low` read of the touched specs against the planned
surface changes catches this class for cents, before authoring.

## Adversarial cause refutation (S2)

F11: **every** suggested fix recorded in the bug registry was refuted on investigation. A fix built on an
unverified cause is the most expensive kind of green — so the cause is attacked before any code, by an agent
whose job is to disprove it.

## Behavioral red bar

Feature runs relaxed to a structural bar because spec tests cannot always fail on exact values pre-build
(F06/F14 burned remediation rounds proving it). A bug's repro test CAN and MUST fail on the bug's own wrong
value — "close enough" reproduction is non-reproduction. In bugfix mode a persistent behavioral shortfall is a
major blocker.

## Fix-revert probes

The strongest mutation for a bug fix is the bug itself: restore the file's HEAD content (by copy, never git
resets — the implementation is uncommitted during a run, so HEAD IS the pre-fix state), the REG test must go
red, restore, hash-verify. Probes report their own pre/post hashes; a moved baseline is classified
`baselineDisturbed`, never a restore failure (the 2026-09-03 stash incident: an external process rewrote the
tree between the checksum agent and the probes, and the engine would have sent a fixer to "reconstruct" two
healthy money files).

## Sibling sweep

A bug's twin ships more often than the bug returns: the F14 authorization matrix (one grant bug → a matrix
across controllers), the multer lockfile prune (one lock entry → an orphaned subtree silently killing every
upload behind a 201), lessons L-029 (sibling paths) and L-037 (reversal enumeration). Grep is Sonnet-cheap;
judging hits is one Opus pass.

## The final pass stays

In the F13 BUG batch the Fable final pass caught a major money-durability defect (a crash window leaving
`nextRunAt` advanced), a tenancy-adjacent authorization hole, a silent semantics change, and a UI race — four
real findings the lenses missed. Bug batches in this codebase touch money; the HIGH-risk final pass earns its
keep.

## Cost frame

F13 (bug batch, morning engine): $33.15 output / 3h23m active. imp-03a (infra, evening engine): $27.28 / 2h20m.
The bug pipeline's $8–14 / 45–70min expectation comes from: no discovery/spec/UX stages, radius-packed lens
input, smaller diffs, corroboration-skipped refuters — while ADDING cause refutation, harness check, revert
probes and the sibling sweep. Cheaper by scoping input, never by removing checks.

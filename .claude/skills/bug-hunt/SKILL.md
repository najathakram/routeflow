---
name: bug-hunt
description: >
  Hunt for real, verified defects in RouteFlow — correctness bugs, functional inconsistencies,
  dead controls, unnecessary steps, and UX friction — and append them to the bug register.
  Auto-load when asked to: "find bugs", "are there more bugs", "audit", "QA pass", "deep dive",
  "review the codebase", "what's broken", "pre-release check", "early detection", "sanity check
  before shipping", "why does this feel off", "friction", "unnecessary steps", "UX audit",
  "find issues", "harden this", "is this production ready".
---

# Skill: RouteFlow Bug Hunt (QA + UX deep-dive)

You are a QA and verification engineer with thirty years on production money systems, who is also
a product designer. Two instincts define the work: **a claim without file:line evidence is a
rumour**, and **a feature that technically works but wastes the user's time is still a defect**.

Three hunt rounds have run against this repo (95 verified entries, `local-assets/docs/routeflow-bug-register.html`).
This skill is what those rounds learned. Read [`references/hunt-classes.md`](references/hunt-classes.md)
for the class catalogue and yields, [`references/bug-signatures.md`](references/bug-signatures.md)
for the recurring code shapes, [`references/ux-audit.md`](references/ux-audit.md) for the experience
axis, and [`references/verification.md`](references/verification.md) for the evidence contract.

## Ground rules (non-negotiable)

1. **Evidence or drop it.** Every claim cites repo-relative `path:line` the agent actually opened,
   caller _and_ callee. Line numbers drift — name the symbol too.
2. **Refute first.** The default stance on every candidate is that it's wrong. A finding survives
   only after a _separate_ agent tries to kill it and fails. In round 2, verification changed the
   substance of 6 of 53 findings and reversed 2 — skipping it ships fiction.
3. **Never re-report.** Read the register first; it also carries an _Investigated & Cleared_
   section of invariants proven sound. Re-chasing cleared ground is the most common waste.
4. **Check both apps.** "No UI calls this" is false if mobile calls it. This exact error produced
   two wrong claims before it was caught. Grep `apps/web` **and** `apps/mobile`.
5. **Compute the numbers yourself.** For any arithmetic claim, execute the function or work the
   example. B46 (the worst critical found) was confirmed by running `calcNextRunAt` on real dates,
   not by reading it.
6. **Read-only.** Hunting never edits source. Runtime checks use `routeflow-demo` or a `qa-*`
   tenant only, per the test-tenant policy — and prefer read-only queries.
7. **No real client names** anywhere in findings, ever.

## The three layers

Run them in order; each is useful alone.

### Layer 1 — Scan (minutes, mechanical)

```bash
node .claude/skills/bug-hunt/scripts/scan-signatures.mjs
```

Greps for the twenty-six code shapes that have historically _been_ bugs here (dead hooks,
confirm-then-navigate, impossible enum branches, money re-derivation, swallowed writes…). Exit 1
on a high-signal hit, so it can gate CI or a pre-PR check. Hits are leads, not findings — each
still needs Layer 3 before it enters the register.

Adding a signature? It must ship with an `offender`/`clean` fixture pair —
`scan-signatures.mjs --self-test` (a step of `npm run verify`) fails on any signature that has
none, and on any whose fixtures don't prove it in both directions.

### Layer 2 — Hunt (fan out by bug _class_, never by file)

Fan out one agent per class from `references/hunt-classes.md`. **Class, not area** — this is the
single most important structural choice. Area-based splitting ("audit invoices") re-finds the same
shallow issues; class-based splitting ("find every place money is re-derived", "find every
conservation invariant that doesn't balance") finds what reading a screen never would.

**Model tiering (empirical, not decorative):**

| Work                                                                                                                      | Model             | Why                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Conservation invariants, state-machine reachability, shared-mirror math, schema/migrations, test-gap inference, forensics | **Fable**         | Needs constructing adversarial sequences and counter-examples. Produced 5 of round 2's 14 criticals from 6 agents. |
| Concurrency/races, security composition, freshly-merged code, triage/dedup judging                                        | **Opus**          | Threat-modelling and cross-PR reasoning.                                                                           |
| Mechanical per-class sweeps (dead UI, dropped DTO fields, cache invalidation, date formatting)                            | **Sonnet**        | High volume, low ambiguity — but only behind a strong verifier.                                                    |
| **Verification of any critical claim**                                                                                    | **Fable or Opus** | Never weaker than the finder. This is where being wrong is most expensive.                                         |

(Mythos is not selectable in the agent picker; Fable is the same underlying model, so Fable _is_
the top tier here.)

Give every finder: the register (to dedup), the money-discipline context, the evidence contract,
and an explicit instruction to report **what it checked and found sound** — that list is as
valuable as the findings and prevents the next round re-treading it.

### Layer 3 — Verify (refute-first, then write)

Group survivors ~5 per verifier. Each returns `CONFIRMED` / `PARTIAL` (true with corrections) /
`REFUTED` (wrong — keep it, in the cleared section). Refutation modes to force explicitly: the
guard exists elsewhere in the chain; the "dead" branch is reachable; it was already fixed
(`git log -S <symbol>`); the path is unreachable so it's dead code not a live bug; the two sides
of a claimed mismatch actually agree; the arithmetic is right when you do it yourself.

## Writing a finding

Every entry is the same triple, in the user's terms, not the code's:

- **Meant to do** — what the UI promises, from the user's point of view.
- **Actually does** — the verified behaviour today.
- **The gap** — what silently doesn't happen, or how the user is misled.

Plus: area · surface, severity, `path:line` evidence, and a 1–2 sentence suggested fix.

**Severity** — `critical` money or data wrong/destroyed · `high` operational failure or a record
that lies · `medium` broken promise or workflow dead end · `low` cosmetic or dead code.
A silent wrong number outranks a loud crash: users route around crashes and trust wrong numbers.

## Appending to the register

The register and the user guide are companions in `local-assets/docs/` and move together.

1. New findings take the next free **B-number** — never reused, never renumbered.
2. A finding that _deepens_ an existing entry enriches it in place; it does not become a duplicate.
3. Refuted claims go to **Investigated & Cleared** with why — never deleted.
4. When a fix ships: flip the chip to `Fixed · #PR`, update the matching guide entry if
   user-visible behaviour changed, and republish **both** artifacts to their existing URLs.
5. Then record what the bug **taught** in [`.claude/lessons/LESSONS.md`](../../lessons/LESSONS.md)
   — the register says what broke, the lessons file says what to do differently. That write
   belongs to the fix session, not to a hunt (hunting stays read-only); read the lessons file
   before a hunt too, so a known class isn't re-derived from scratch.

Full protocol and both artifact URLs: memory `project_bug_register_2026-08-28`.

## Scoping a run

| Ask                           | Shape                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| "quick check before shipping" | Layer 1 + 2–3 classes touching the change                                                       |
| "find bugs in X"              | Layer 1 + every class that touches X, verified                                                  |
| "are there more bugs"         | Full Layer 2 fan-out on classes not yet run — check the register's coverage first               |
| "why does this feel clunky"   | `references/ux-audit.md` lenses; correctness classes only where friction hints at a real defect |
| "is it production ready"      | All three layers + the forensic data-integrity script                                           |

## Hard-won cautions

- **Yield falls, criticality doesn't.** Round 3 classes were less picked-over than round 2's;
  the untouched class always beats a second pass over a hunted one. Track coverage, not volume.
- **A hook with no callers is the highest-yield single signature in this repo** — seven findings.
  Always check both apps before claiming it.
- **The code map is a map, not the territory.** It has been stale (it claimed MSRP was unmerged
  after it shipped). Verify in source; fix the map when it's wrong.
- **Freshly merged code is unaudited code.** After any merge train, re-anchor line numbers and
  hunt the new surface — it has never been looked at.
- **Don't report enhancements as bugs.** "This could be nicer" belongs in the guide's suggestions
  chapter. A bug is a broken promise, wrong data, or a dead end.

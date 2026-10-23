---
name: future-proof
description: >-
  RouteFlow's mandatory DESIGN GATE (owner ruling R19, 2026-10-08: no plasters, nothing a planned
  version will replace). Before any spec, bug-fix ruling or lead/SA design ruling is approved, and
  before any build starts, the author fills a `## Design Gate` block: program-map fit with facts at a
  pinned sha, an area sweep of open items in the same files, a variation map across business types
  (wholesaler, jobber, POS counter, delivery, mixed, super admin) and scale tiers marked BUILD NOW /
  SEAM NOW / LATER, a replace-later check, class-not-instance (one helper + inventory pin, tests red
  on the wrong value), data and time foresight, scale, the apple-ux lens, change-friendliness with
  expected diff sizes, a cost/stop rule and batched owner questions. Reviewers PASS/FAIL it and the
  lead rejects a spec or PR without it. Use when designing or specifying a feature, writing an SA
  spec or a ruling, before dev-pipeline S1-S3 or a bug-pipeline S3 fix ruling, planning a fix that
  touches a shared model (billing, units, permissions, settings, tenancy, orders/invoices,
  counter/POS, money), reviewing a spec or PR against its gate, or when anyone says "future proof",
  "plaster", "band-aid", "interim", "will this be replaced", "how would other tenants use this",
  "variation map", "seam", "area sweep", "fix the whole area", "chunk these fixes" or
  "/future-proof". Typo-class edits are exempt.
---

# Future-proof — the Design Gate

Owner ruling R19 (2026-10-08) is binding: no plasters. Every piece of work is built so the next one can stand on it.
Nothing is built that a planned version will replace. Seams, registries and settings keep later improvements small
(R19-1 to R19-3). R19-4 adds the variation map, and the owner's 10-08 additions add big-picture fixes, owner questions
at planning, and chunked fixes.

This skill applies those rulings: **one block every spec fills, one checklist every reviewer uses, and one log that
makes the gate sharper.**

**Why, measured.** On 2026-10-08, all 8 SA specs that went to Opus review failed their first review. Reaching APPROVED
took 20 verdicts, 18 of them FAIL. The must-fix findings repeat ten classes: facts assumed rather than read; per-site
fixes; red tests already green on master; values decided at one moment and used at another; old-shape data; narrow
models; and a boundary patched for four rounds. Each class maps to a check below ([EVIDENCE](references/EVIDENCE.md)).

## When the gate runs, and who runs it

| Work                                                                                     | Form                                    | Where it lives                                                    | Written by                         | Checked by                                   |
| ---------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| New feature, program step, new model or table; any money, auth, tenancy or schema design | **Full**                                | `## Design Gate` in the spec (SA spec, or dev-pipeline `spec.md`) | SA architect                       | Opus spec reviewer, then the lead            |
| Small change, UI polish, a one-area fix, a fold of review text that changes the design   | **Lite** (every heading, one line each) | spec preamble, bug-pipeline `cause-ruling.md`, or the PR body     | SA (the lead, for its own rulings) | spec or PR reviewer                          |
| P0 security or money hotfix (live harm now)                                              | **Hotfix** (3 lines)                    | hotfix PR body, plus an ACTION-ITEMS row                          | lead                               | PR reviewer; the follow-up gets Full or Lite |
| Typo-class edit (a string, a label, a comment)                                           | exempt                                  | —                                                                 | —                                  | —                                            |

- **Routing** (`model-routing`). Decisions run on **Opus 5.5 @ high**; use `xhigh` only to frame money, auth, tenancy
  or schema work. The fact pack is gathered read-only by **Sonnet 5.5 @ medium**, or by Haiku 4.5 @ low for pure
  listing. The pack holds the area-sweep lists, the call-site inventory, the program rows and the path:line reads.
  Gatherers never rule.
- **Timing.** The gate is written **during** planning (dev-pipeline S1–S2, bug-pipeline S3), while it can still change
  the design.
- **Tools.** The templates are in [GATE-TEMPLATE](references/GATE-TEMPLATE.md). Check a gate's completeness with
  `node .claude/skills/future-proof/scripts/check-gate.mjs <spec.md>`, or pass `-` to read a PR body from stdin.

## The checks

Each check is one heading in the template. Its PASS/FAIL criteria are in
[REVIEWER-CHECKLIST](references/REVIEWER-CHECKLIST.md). Topics the dev-pipeline spec template already owns are pointed
to, never restated: overlap (§6), deploy day and the gate-key table (§7), rollback (§8) and assumptions (§10).

### G1 Fit — program map, ground truth, reuse

- **Program.** Name the program or train. Look in the newest `.claude/handoffs/*-WORK-PLAN.md` (§C trains, §D
  programs, §H Later), in `docs/product/` (the domain's P1 and P2 capabilities), in `.claude/sa/RULINGS.md` and in the
  owner rulings. "None" needs a reason.
- **Ground truth.** Read the code before designing (the code map, then the area file, then the file). Every
  load-bearing fact is **path:line at a pinned sha**, or is **measured live** as a command plus its output. List
  **every writer** of each field or state the design reads (L-125, L-204), and read third-party APIs at their pinned
  version. "X already does Y", taken from memory, caused the most must-fix findings on 10-08.
- **One model.** Extend before adding. A second store or computation of the same thing needs a written reason. A
  backfill or script calls the same service function, never a second SQL writer. Specs that share a rule state it
  identically.

### G2 Variation map — business types × scale (R19-4)

- **One line per axis.** The axes are wholesaler/distributor · jobber · retail POS counter · delivery/route · mixed ·
  super admin · single store/1 user · small team · multi-branch/multi-warehouse · high volume (thousands of SKUs or
  orders a day, many drivers or terminals). Add one more line for surfaces and roles: web, mobile (which mirrors web),
  buyer portal, driver and super admin. The template has prompts for each axis.
- **Mark each line** **BUILD NOW** (in this change), **SEAM NOW** or **LATER** (a note only). SEAM NOW means shaped
  now so the later change is small: a field, an enum value, a registry row, a strategy hook, a parameter that defaults
  to today's behaviour, a setting, pagination or an index.
- **Build only BUILD NOW.** Every SEAM NOW item is visible in this change's data model or interface, at the place the
  seam column names.
- **Read a capability, never a type.** Rules read a derived answer (`capabilities.fulfilment`, in
  `packages/types/api/fulfilment.ts`), a setting or a registry. They never read a profile key, a tenant slug or a raw
  mode. A tenant type is a row in `apps/api/src/billing/business-profiles.ts`. New behaviour gates ship **dark**
  (CLAUDE.md, "Entitlement gates").
- **YAGNI guard.** A seam names the real type, tier or planned program that needs it, and costs S or less now. With no
  named need, the line is LATER.

### G3 Replace-later

- **List every planned program that touches the area:** units, permissions, billing, settings IA, POS WOW, tenancy,
  order-screen steps, staff PIN switch, multi-branch, or whatever else the plan shows. For each one, ask whether it
  would replace or rework this work.
- **If it would,** build the **final shape now**, or a **clean seam** that it plugs into. An interim (device-local
  business state, a display-only read, a single-till table) ships only with an **owner-approved expiry** (a date or a
  trigger), an ACTION-ITEMS row naming the final shape, and the conditions that keep it safe meanwhile. SA-740's
  interim is the model.
- **Review-round signal.** If a fold opens new must-fix findings, or a boundary needs a growing list of exceptions, the
  model is wrong. Stop folding, and re-run G1 and G3. SA-732 needed four FAIL rounds before it reached a boundary that
  held by construction.

### G4 Class, not instance

- **Inventory.** State the class. Then list every call site, writer and reader **by a code predicate**, never by hand.
  Examples: "every `user.update*` that writes `status`", "every writer of a given table". Hand lists grew between
  review rounds in SA-733, SA-743 and SA-756.
- **One helper, pinned.** Route the class through **one helper**. Pin it with a structural spec in the style of
  `apps/api/src/common/no-bare-cron.spec.ts`, or (cheapest) with a **required parameter or type**, so the compiler
  finds every site. Nothing fails open: `undefined` throws, there is no `process.env` fallback, and zero targets is an
  error (L-202).
- **Red on the wrong value.** Each red row names master's value **observed today** (run it; never predict it) and the
  value after. A failure on a compile error, an unknown field or a 400 for an unknown property is not red. A row that
  cannot be red on master is a guard. The structural pin sits beside the behavioural test, never in its place (L-205).

### G5 Data and time

- **Schema.** Changes are additive only and ride the next owner sitting's bundle: one folder per change, CHECKs on new
  columns, and Squawk reasons (the SA-741 shape; see `db-migration`). A SEAM NOW column rides the **same** folder,
  because a later migration costs another sitting.
- **Snapshot or live.** What a record must show forever (label, tier price, tax, zone) is snapshotted on it. Current
  state is read live. A past document is never re-derived from today's catalog (SA-729 §2).
- **Authority and time.** The server recomputes money and builds every identity that others key on. A value decided at
  one moment and used at another is re-read inside the write transaction, the CAS or the lock. State the event order,
  what happens on redelivery, and how multiple devices, tabs and offline replay behave.
- **Old shape meets new code.** Cover in-flight attempts, rows issued ahead, and legacy or mislabelled rows: a census
  first, then a dual-read until a hard date. The **dark → enforced flip is its own deploy day**.
- **Money** lives in `@routeflow/pricing`, with `roundMoney` on every monetary write.

### G6 Scale

- **Queries.** Paginate or batch, on an index that exists (or ships in the bundle). Run one query per page, never one
  per row. Lists of ids go through batch endpoints.
- **Caps.** Every cap is **one named constant** with its reason. It becomes a per-tenant setting only when a real tier
  needs a different value.
- **UI.** It works at 10 items and at 10,000: server search or pagination, never a fetch-all picker (the `limit: 0`
  sentinel tops out at 10k).

### G7 UX lens (UI work)

- **Flow first.** Run the `apple-ux` principles on the planned flow **before** writing the spec: the vital few; one
  primary action per state (A3); the control where the eye is, at the moment of need (A1, A2); one-step undo with input
  kept (A4); and nothing the job does not need (A5). For an existing screen, take a baseline with `/apple-ux --quick` or
  `--recheck` on fresh master.
- **No feature loss** (owner, 10-07). Write a parity inventory of every control, field, shortcut, deep link and role gate
  on a changed screen. Removing or hiding any of them needs the owner's OK. A moved control keeps a link to its new
  place.
- **Placement sign-off** (owner, 10-08). Every placement of a control or setting carries an explicit agreement from both
  apple-ux and apple-design, with reasons. Settle any disagreement in the spec, before a builder starts.

### G8 Change-friendliness

- **Config over code.** A setting takes its home from `SETTINGS_REGISTRY` (`packages/types/api/settings-registry.ts`),
  with a row and a screen. Capability modes go in `apps/api/src/billing/feature-registry.ts`. Per-mode behaviour is an
  exhaustive map over the shared union, so a new mode fails to compile until it is handled.
- **Shared contracts.** DTOs, enums (`X_VALUES` plus the parity spec, L-072) and error codes live in `packages/types`.
  Clients show mapped codes, never server text. Every flag has a removal plan, and the new seam gets a code-map entry.
- **Future requirement → expected diff size**, for each SEAM NOW and LATER line: **XS** (a registry or config row),
  **S** (about 100 lines or fewer, one area, no migration), **M** (a migration, or two areas) or **L** (rework of a
  shipped model). Aim for S or smaller. An L means the seam is missing: fix the design, not the estimate.

### G9 Cost and stop

- **A quick fix is right** only for a P0 security or money hotfix, or for an owner-dated deadline that the final shape
  cannot meet. It then carries the Hotfix gate: a dated, owner-approved follow-up to the final shape, with its area
  sweep filed as that follow-up.
- **Don't over-engineer.** Generalise only along axes that G2 names with a real type, tier or program. No frameworks, no
  base classes, no settings nobody sets. A seam that costs more than the BUILD NOW work becomes LATER, unless G3 shows
  that the rework would cost more.
- **Justify the shape.** Say in one line why it beats the quick fix.

### G10 Owner questions — asked at planning

Anything uncertain becomes an owner question **now**, batched into **one** question box (`AskUserQuestion`). Each
question puts the recommended option first and says what each option costs. Obvious answers are decided and stated,
not asked. Never guess in the spec, and never ask mid-build. A builder who meets an unanswered decision stops and raises
it, and the RUN-LOG records a miss.

## Fixing: the area, not the symptom

This is an owner addition from 10-08. It binds bug-pipeline and every fix.

1. **Big-picture fix.** Before ruling, look at the whole area: the module and flow, its sibling paths (web, mobile,
   portal, scripts, crons), and the programs that touch it. Make the adjustments that keep the area future-proof, not
   only the symptom's fix. The ruling names the class (G4) and the replace-later answer (G3).
2. **Ask at planning.** An unsettled cause, rule or preference goes into the batched question box (G10) during the
   ruling. It never goes to the builder.
3. **Chunked fixes, starting with an area sweep.** Before building, list every open item in the same files and flow:
   the bug registry by path, tracker issues, ACTION-ITEMS rows, and review nits. The exact queries are in the template.
   Fix the items together, on one branch.
   - **One area per branch.**
   - **Each issue gets its own commit and its own red-first test**, so any one of them reverts alone.
   - Split by sub-area once the chunk passes the size ratchet (`scripts/size-ratchet-gate.mjs`) or about 600 changed
     lines.
   - Money and security items keep their **Opus review**, even inside a chunk.
   - A **P0 hotfix never waits** for a chunk; it files its area sweep as the follow-up.
   - The PR body lists **every issue id it closes**, and every deferred id with its row.
   - Defer an item only for a stated reason: it needs a sitting, it needs an owner ruling, it belongs to another area,
     or the size cap was hit. A deferred item keeps its row.

## Enforcement

- **The lead, before review.** Run `check-gate.mjs` on the spec before dispatching any review. Exit 1 returns the spec
  to the SA unreviewed. A spec without a gate is not reviewed, ruled on or briefed. A ruling that folds review text
  names the gate headings it re-checked.
- **Optional pre-pass.** A Sonnet 5.5 @ medium pre-review against the checklist can run before the Opus review, to cut
  fold loops.
- **The spec reviewer (Opus)** also returns `GATE: PASS | FAIL (G#: reason)`. A FAIL on any heading fails the spec.
- **The builder's brief** carries the BUILD NOW and SEAM NOW lists (with where each seam lives), the pin, the red rows
  and the chunk's issue ids.
- **The PR reviewer** (in-lane Opus, and `pre-merge-review`) checks the PR against the gate, using the PR-stage list in
  the checklist. A PR with no gate reference (a spec link, or a Lite or Hotfix block) is a BLOCK.
- **The harness.** The UserPromptSubmit router (`~/.claude/skills/model-routing/scripts/route-task.mjs`) prints
  `Design Gate required → /future-proof (R19)` on dev-pipeline and bug-pipeline routes, in projects that carry this
  skill. Stop-hook Gate 6 (`.claude/hooks/stop.mjs`, spec `stop.gate6.spec.mjs`) warns when a feat/* or fix/* branch
  has code but neither its spec nor the HEAD commit body carries a gate. Gate 6 is dark and never blocks; enforcing it
  is a separate, owner-approved diff, made only after RUN-LOG evidence.
- **Flow pointers** sit at dev-pipeline S1, bug-pipeline S3, new-feature, pre-merge-review §1, fleet-lead §6, and the
  STOP GATE in dev-pipeline `templates/SPEC.md`. They are in both the repo and the global copies.

## Neighbours (integrate, don't duplicate)

| Skill                                             | Owns                                                                      | How the gate uses it                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `dev-pipeline`                                    | S0–S8; spec template §6, §7, §8, §10                                      | written in S1–S2 and pasted into `spec.md`; S6 approves only with it                     |
| `bug-pipeline`                                    | evidence, cause refutation, the S3 ruling (sibling patterns, data repair) | the area section, plus a Lite gate in `cause-ruling.md`                                  |
| `new-feature`, `code-map`                         | scaffold order (web is the reference); INDEX → area → file                | the G2 surfaces line; G1 reads the map; G8 names the seam's entry                        |
| `lessons-learned`                                 | the register and `LESSONS-DIGEST.md`                                      | cite ids; L-072, L-125, L-167, L-169, L-189, L-202, L-205 and L-210 recur in design work |
| `apple-ux`, `apple-design`, `db-migration`        | the UX audit and placement craft; additive schema                         | G7; G5                                                                                   |
| `pre-merge-review`, `model-routing`, `fleet-lead` | the PR gate; who runs what; provenance and SA rulings                     | the PR checks; the routing line; lead enforcement                                        |

## Learning clause

This clause is mandatory. Its canonical text is in `~/.claude/skills/dev-pipeline/references/LEARNING-CLAUSE.md`.

1. **Read before gating:** the newest 5 [RUN-LOG](references/RUN-LOG.md) entries, `LESSONS-DIGEST.md` and the
   EVIDENCE classes. Cite whatever applies.
2. **Measure, never estimate.** For each gated spec, record the first-review verdict, the verdicts to APPROVED, the
   must-fix findings by class, and the **gate misses** (a must-fix of a class the gate covers, or a builder stopped by
   an unanswered decision). Gate 6's warn count is the dark-mode signal. Pipeline runs also close out with
   `closeout.mjs` or `session-usage.mjs`.
3. **Record.** Write one RUN-LOG line per gated spec. Add an entry whenever **the gate caught a would-be plaster** (what
   it was, and which check caught it), or **something passed the gate and was later replaced or reworked** (which check
   missed it, and the sharper question it now asks). Every surprise also gets a lesson.
4. **Act every 10 gated specs.** Compare the first-review PASS rate and the verdicts per spec with the baseline. Sharpen
   the check behind any recurring miss, and merge or cut any check that caught nothing in the 10. A candidate in 3 or
   more entries goes to the owner as a written proposal.
5. **Prove the change.** A skill edit ships with `check-gate.mjs --self-test` passing, plus a RUN-LOG line naming what
   it should improve. A harness edit also runs its own spec.

## Files

[GATE-TEMPLATE](references/GATE-TEMPLATE.md) (the three blocks, axis prompts, area-sweep queries) ·
[REVIEWER-CHECKLIST](references/REVIEWER-CHECKLIST.md) (PASS/FAIL per heading, PR-stage checks, brief snippet, lead
steps) · [EVIDENCE](references/EVIDENCE.md) (failure classes, baseline, good shapes, worked variation maps) ·
[SEAMS](references/SEAMS.md) (house seams with paths, seam patterns, anti-patterns) · [RUN-LOG](references/RUN-LOG.md)
· [CLAUDE-MD-ADDITION](references/CLAUDE-MD-ADDITION.md) (for the lead's close-out commit) · `scripts/check-gate.mjs`
(the completeness checker; `--self-test` proves it against the template).

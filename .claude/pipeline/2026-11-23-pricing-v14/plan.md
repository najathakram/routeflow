# Plan: pricing v14, PR by PR (Phases 2 and 3)

Spec: [spec.md](spec.md). Base `d977b00d4b`. The order is SA-1254's (2026-11-24) and binds every PR:
schema, ladder, catalog, gates, billing, web, publish, site, docs. **Nothing here starts before the Full
architect panel on the spec**, and nothing starts before the 2026-11-28 demo.

Every code PR is Tier 1 (billing): two Opus PASSes at the exact merging sha, posted on review board
#4456. Docs-only PRs are Tier 2. The lead's coordinator merges. Each PR names its roadmap row, the
claims-register rows it changes, and the SA-1254 conditions (V1-V12) and cases (T1-T14) it carries.

Phase 1 is done: the docs PR and the static-tests PR, both 2026-11-24.

## Rules for every PR

- A detached worktree with its own `npm ci`; jest with `--maxWorkers=4`.
- Conventional Commits, subject of 72 characters or fewer; HEAD carries `Bookkeeping-Follow-Up: pending`.
- At or under 400 added non-test lines, with `## Design Gate`, the fix-revert probes it carries, and a
  control inventory.
- Never amend a published PlanVersion. Never flip a gate. Never touch a live tenant.
- Schema changes are additive and go in the one schema sitting: a fresh backup first, then
  `prod-migrate.mjs`, then drift 0.
- Red-first: every new test is seen failing on the wrong value before it passes.

## Phase 2

| Step | PR | Requirements | Conditions and cases | Size | Depends on | Migration |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Full architect panel on this spec | all | V1-V12 | docs | demo over | no |
| 1 | **Schema:** `PLUS` in TenantPlan, the per-tenant protection end and notice dates, the founding marker, the store-ordering cap column; one additive migration | R2, R5, R15, R16 | V9; G5 | S | 0 | yes, one sitting |
| 2 | **Ladder:** CORE, PLUS and ALL_IN identity maps both ways; C1' with the tie rule; the V3 matrix test; the one JS mirror; the order parity spec over the five mirrors, bundling the drifted audit-script copy (W-1288) | R2, R7 | V1, V2, V3; T1-T4, T9, T13; P1, P6 | M | 1 | no |
| 3 | **Catalog:** `plan-catalog-v14.definitions.ts` and `publish-plan-catalog-v14.ts` with `--dry-run` (not published); legacy rows at v13 prices, not for sale; add-ons restating `includedAtPlan`; delivery $0 with the $49 ladder constant; the ladder spec | R1, R4 (flags in rows), R5, R6, R7, R8 | V3, V4, V5, V6; T7, T8; P2, P4 | M | 2 | no |
| 4 | **Gates:** new plan flags and add-on keys, all dark; the registry census; SA-1204's private item closed before the first paid add-on gate | R4 | V11 | S | 3 | no |
| 5 | **Billing:** the pinned-price fix (no published-SKU fallback for pinned accounts); protection-date writes (dry-run first); the store-ordering allowance at approval; trial (C7 carry, 14 days on Pro); moving down and GROWTH→PLUS at renewal; card checkout before a self-serve plan goes active; the upgrade nudge; the review and notice jobs, dry-run by default, skipping overrides | R9, R11, R12, R13, R14, R15 | V4, V9, V10, V12; T5, T6, T14; P3 | split into PRs of 400 lines or fewer | 3, 4 | no |
| 6 | **Web:** one display-name helper; no raw keys in customer copy; the "Your plan" card with price and protection date; effect wording and "Keep current plan"; the cap-based picker copy retired; admin labels for the two Growths | R3, R12, R18 | V7, V8; T11, T12; P5 | M | 5 | no |
| 7 | **Publish** (production; one command per owner yes): the census (also answers Q1's `GROWTH` count), re-pin every unpinned payer, the dry run (stop on any non-trial bill change), a fresh backup, the publish, the protection dates written, `post-deploy-check`; LITE accounts re-pinned to CORE after the census proves no flag is lost | R1, R15, R17 | V6, B1165; T10 | XS | 6 deployed | catalog rows; data, dry-run first |
| 8 | **Site:** the one-line pricing, pinned to the catalog on sale; the pin test's `ON_SALE_VERSION` moves to 14 in the same PR | R19 | G4 class 1 | S | 7, site rebrand landed | no |
| 9 | **Docs** (Tier 2): billing-plans, the claims register, the code map, the roadmap rows | all | - | docs | 8 | no |
| 9+ | One enforcement diff per gate, each after the owner's blast-radius report | R4 | V11 | XS each | 7 | no |

Step 5 is the widest. It splits into PRs of 400 added non-test lines or fewer, in this order: the
pinned-price fix and the protection-date writes, then the store-ordering allowance, then trial and
moving down, then card checkout, then the nudge and the jobs. The Full panel may re-cut it.

The publish waits until the web PR is deployed (V6). The pricing page and the pin test move together
in step 8, never before v14 is on sale.

## Open before step 6 ships

- **Q1, old Growth's plan name after v14.** The owner answered "No one uses growth. So can change". The
  architect is re-ruling it, and it depends on the production census in step 7, run read-only earlier
  if the panel asks. Step 6's display-name helper takes the answer as one entry.

## Phase 3

Each gets its own spec and ruling; none rides the Phase 2 PRs.

| # | PR | Requirements | Size | Note |
| --- | --- | --- | --- | --- |
| 3.1 | Scope note: drivers completing a regulated stop on the web | R20 | docs | First. Before Pro is sold to tobacco wholesalers with vans |
| 3.2 | Web signature and age or ID capture at the stop | R20 | M | Per the scope note's ruling |
| 3.3 | Guided move-in as a bookable one-time service | R21 | S | Builds on F-11 |
| 3.4 | Pro extras status and rows | R22 | docs | F-10 console steps are the owner's |
| 3.5 | Small sale helpers, one paragraph each; build only what the owner picks | R23 | docs | QuickBooks-ready CSV first is the recommendation |
| 3.6 | F-18 and F-20 scoping notes | | docs | Already in `docs/product/pricing-roadmap.md` |

## Roadmap rows this programme needs

These rows go in a docs-only bookkeeping PR (`.claude/roadmap/README.md`), not in a code PR:

- a feature row for pricing v14 (Phases 2 and 3; folds F-12 and F-13);
- a feature row for drivers completing a regulated stop on the web;
- a feature row for card checkout before a plan goes active;
- a feature row for the store-ordering allowance;
- a feature row for guided move-in as a bookable service;
- a feature row for the founding-account marker;
- a feature row for message threads with stores and drivers (claims register A9);
- a deferred row for margin warnings and priority support (Pro extras without a row);
- a deferred row for the tobacco license expiry flag (claims register A1).

## Stop and ask the owner when

- a change would alter what a paying account is billed or can use;
- the census or dry run shows any non-trial bill change (back to the architect, no publish);
- a gate would move from dark to enforced;
- a migration touches billing tables (every column in step 1);
- a claim on a live public page turns out to be untrue.

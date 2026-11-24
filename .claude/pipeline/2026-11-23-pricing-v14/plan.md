# Plan: pricing v14, PR by PR (Phases 2 and 3)

Spec: [spec.md](spec.md). Base `d977b00d4b`. **Nothing here starts before the architect's ruling**, which
re-rules SA-1204 into this programme after the 2026-11-28 demo. Each PR is Tier 1 (billing). The
architect rules first, then two Opus PASSes at the exact sha go on review board #4456. The lead's
coordinator merges. Each PR names its roadmap row and the claims-register rows it changes.

Phase 1 is done: the docs PR and the static-tests PR, both 2026-11-24.

## Rules for every PR

- A detached worktree with its own `npm ci`; jest with `--maxWorkers=4`.
- Conventional Commits, subject of 72 characters or fewer; HEAD carries `Bookkeeping-Follow-Up: pending`.
- Never amend a published PlanVersion. Never flip a gate. Never touch a live tenant.
- Schema changes are additive and go in one sitting folder. A fresh backup comes first, then
  `prod-migrate.mjs`, then the drift check.
- Red-first: every new test is seen failing on the wrong value before it passes.

## Phase 2

| # | PR | Requirements | Size | Depends on | Migration |
| --- | --- | --- | --- | --- | --- |
| 2.0 | Ruling: SA-1204 re-ruled; the new Growth key named; R11 trial-end choice | spec G10 | docs | demo over | no |
| 2.1 | Schema sitting: the new Growth enum value, the store-ordering cap column, protection end, founding marker, scheduled add-on price and notice date | R2, R9, R15, R16, R6 | M | 2.0 | yes, additive |
| 2.2 | `plan-catalog-v14.definitions.ts` with the ladder spec (not published) | R1, R4, R5, R6, R7, R8 | M | 2.1 | no |
| 2.3 | New plan flags and add-on keys, all dark; the registry census | R4 | S | 2.2 | no |
| 2.4 | Rank ladder for the three new keys; inclusion for Pro; move-in for Pro paid yearly | R7 | S | 2.2 | no |
| 2.5 | Store-ordering allowance at approval; the 26th-store block with both prices | R9 | M | 2.1, 2.3 | no |
| 2.6 | Card checkout before a self-serve plan goes active | R14 | M | 2.2 | no |
| 2.7 | Moving down: the confirm step; the trial end | R11, R12 | S | 2.5 | no |
| 2.8 | The upgrade nudge | R13 | S | 2.4 | no |
| 2.9 | Old Growth display: a pinned `GROWTH` account never sees $199 as its plan | R3 | S | 2.2 | no |
| 2.10 | Read-only report: paying accounts, pins, protection end, v14 price | R15, R17 census | S | 2.1 | no |
| 2.11 | Publish v14 (owner go-ahead) | R1 | XS | 2.2-2.10 | catalog rows |
| 2.12 | LITE accounts re-pinned to Essentials after the census (owner go-ahead) | R17 | S | 2.10, 2.11 | data, dry-run first |
| 2.13 | Pricing page to v14: one line; the pin test's `ON_SALE_VERSION` moves to 14 in the same PR | R18 | S | 2.11, 2.6 | no |
| 2.14+ | One enforcement diff per gate, each after the owner's blast-radius report | R4 | XS each | 2.11 | no |

The pricing page and the pin test move together in 2.13, and never before v14 is on sale.

## Phase 3

| # | PR | Requirements | Size | Note |
| --- | --- | --- | --- | --- |
| 3.1 | Scope note: drivers completing a regulated stop on the web | R19 | docs | First. Before Pro is sold to tobacco wholesalers with vans |
| 3.2 | Web signature and age or ID capture at the stop | R19 | M | Per the scope note's ruling |
| 3.3 | Guided move-in as a bookable one-time service | R20 | S | Builds on F-11 |
| 3.4 | Pro extras status and rows | R21 | docs | F-10 console steps are the owner's |
| 3.5 | Small sale helpers, one paragraph each; build only what the owner picks | R22 | docs | QuickBooks-ready CSV first is the recommendation |
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
- a gate would move from dark to enforced;
- a migration touches billing tables (every row in 2.1);
- a claim on a live public page turns out to be untrue.

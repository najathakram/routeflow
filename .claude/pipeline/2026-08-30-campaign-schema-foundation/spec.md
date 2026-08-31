# F01 · Schema foundation — spec

**Status: EXECUTED** · One consolidated additive migration in slot
`20260908000000_campaign_schema_foundation`, applied to prod (backup first, owner-reviewed,
`prod-migrate.mjs`) BEFORE this PR merges. No behavior change anywhere.

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                             | Prio | Verified by                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| R1  | Every column the nine consuming batches need exists after one migration (list in discovery.md)                                                                                                                                                                                                                                          | P0   | migration replay (CI `db-migrations.yml`) + `prisma validate`                                        |
| R2  | **Additive only**: no DROP TABLE/COLUMN, no rename, no data rewrite; every new column nullable or defaulted                                                                                                                                                                                                                             | P0   | reading `migration.sql` — its only DROP is the narrower unique INDEX being replaced by the wider one |
| R3  | Existing rows stay valid: `NumberingSequence.year` defaults 0 and the widened unique `[tenantId, docType, year]` cannot collide rows that were unique on `[tenantId, docType]`                                                                                                                                                          | P0   | T2 + set theory: widening a unique key never introduces collisions                                   |
| R4  | The unique-input rename ripples nowhere beyond `numbering.service.ts`                                                                                                                                                                                                                                                                   | P0   | T1 (tsc over the full API build config)                                                              |
| R5  | New enum values (`RETURN`, `ORDER`) match the series the ad-hoc minters emit today (RET- pad 4, ORD- pad 5) so F16 can adopt without renumbering                                                                                                                                                                                        | P1   | DEFAULTS entries pinned against `returns.service.ts:37` / `orders.service.ts:1916`                   |
| R6  | Deploy-day answer: nothing reads or writes any new column until its consuming batch lands, so deploying app code before/after the migration in any order is safe — **except** the migration must precede this PR's own deploy only because `numbering.service.ts` now queries by the widened key (the sole runtime consumer in this PR) | P0   | grep: the five updated call sites are the only runtime reads touching changed shapes                 |

## Non-goals (fenced)

- No writers, DTO fields, UI, or service logic for any new column (consuming batches own those).
- No RLS work (F02b, its own migration slot `20260909000000_rls`).
- No adoption of `NumberingService` by the five ad-hoc minters (F16).
- No backfill of `Estimate.issueDate` (stays NULL; readers keep their `?? createdAt` fallback until F27).

## Entitlement/deploy-day trap check

No new gate, no entitlement key, no flag — nothing here can 403 anyone on deploy day. The one
ordering constraint (migration before app deploy) is the house rule anyway.

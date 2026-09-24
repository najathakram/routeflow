# Spec — policy layer phase 1, API (PR-A)

Status: IMPLEMENTED (PR-A) · run 2026-09-24-policy-layer-phase1 · scale major · profile standard (HIGH: schema, tenancy)

**Source of truth:** SA-138, `.claude/sa/POLICY-LAYER-SPEC.md` on `origin/docs/sa-registers-0922`
(issue #938 comment 5808457303). This file only numbers its PR-A requirements for the test plan;
where the two disagree, SA-138 wins.

Problem (SA-138 §intro): tenants need per-tenant behaviour choices (at-door edits, credit approval band,
price disclosure) without abusing entitlements; `SystemConfig` has no schema, cache, history or scope.
Deploy-day: additive table, zero rows, no production reader → byte-identical behaviour; the owner applies
the migration to prod BEFORE merge (L-184). Rollback: drop the unread table + enum.

| R#  | Requirement (SA-138 ref)                                                                                                                                                                        | Priority |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| R1  | Registry `policy-registry.ts`: `<area>.<name>` keys, kind enum/money/set, zod schema, default, scopes, description, added, `pilotPending`; 3 pilot keys, all pilotPending, no call sites (§3.1) | must     |
| R2  | policy ≠ entitlement: no `flag.` key, no FEATURE_REGISTRY key, no boolean capability, no guard imports PolicyService, no per-key failMode (§1, §2)                                              | must     |
| R3  | `PolicyValue` + `PolicyScopeType` in platform.prisma, tenantId NOT NULL, MODEL_DOMAIN, additive migration, lint:migrations + split --check + drift clean (§3.2)                                 | must     |
| R4  | `resolve` layers default → TENANT → CATEGORY → CUSTOMER, newest-createdAt tie-break (§3.3)                                                                                                      | must     |
| R5  | a stored value failing the schema is skipped with logger.error; next layer wins (§2)                                                                                                            | must     |
| R6  | resolve never throws: DB error → default + logger.error (§2)                                                                                                                                    | must     |
| R7  | 30 s per-tenant cache (EntitlementsService shape, pruned at 1000), invalidate on write (§3.3)                                                                                                   | must     |
| R8  | set/clear validate against the registry (400: key, schema, scope, scopeId, reason) (§3.3)                                                                                                       | must     |
| R9  | append-only: supersede + insert in ONE tenantTransaction; nothing updated but supersede stamps, nothing deleted (§3.2)                                                                          | must     |
| R10 | writes serialized by `withAdvisoryLock` family `policy-write`, key `${tenantId}:${key}`, no in-process lock (§3.2)                                                                              | must     |
| R11 | ONE AuditLog row per write: `policy.set`/`policy.clear`, entityType PolicyValue, meta {key, scopeType, scopeId, old, new, reason}, impersonatedBy stamped (§3.3)                                | must     |
| R12 | `/policies`: GET OPERATOR+, PUT/DELETE TENANT_ADMIN with reason, GET /:key/history; addon-free (§3.4)                                                                                           | must     |
| R13 | TENANT-scope effective values in `TenantFeaturesResponse.modes`; customer/category values never leave the server (§3.5)                                                                         | must     |
| R14 | tenant isolation: another tenant's rows invisible; a foreign scopeId refused (§3.6)                                                                                                             | must     |
| R15 | shared request/response types in `packages/types/api` (CLAUDE.md)                                                                                                                               | must     |
| R16 | no production code reads a policy; full suite unchanged; GET /policies on `test` = 3 keys, 0 rows (§3.6, §5)                                                                                    | must     |

Non-goals (PR-A): web admin page (PR-B), any pilot call site (PR-C/D/E), SystemConfig migration,
CATEGORY scope on any pilot, platform-admin cross-tenant view.

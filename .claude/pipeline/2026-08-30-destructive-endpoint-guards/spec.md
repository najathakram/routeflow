# Spec — destructive endpoint guards (B126, B127)

Status: APPROVED · REVIEWED 2026-08-30 — grounded against the repo; amendments: R8 added
(OrderCreditNote Restrict FK), B127 deploy-day corrected (no UI caller).
Base: master `6c8f1401`. Scale MAJOR. ui: false. No migrations. No schema change.

## Files in scope

- `apps/api/src/system-config/settings.controller.ts` (B126 handler + its guard)
- `apps/api/src/system-config/dto/clear-financial-data.dto.ts` (**new**, typed confirmation)
- `apps/api/src/customers/customers.service.ts` (B127 `deleteAllCustomers`)
- Specs (see test-plan.md) + `.claude/code-map/{api.md,CHANGELOG.md,_meta.json}`

## Requirements

| R#     | Priority | Requirement                                                                                                                                                                                                                 | Verified by       |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **R1** | P0       | `clearFinancialData` deletes only rows belonging to the **calling tenant**. Every one of the ten `deleteMany` calls is tenant-scoped.                                                                                       | T1, T2            |
| **R2** | P0       | When the resolved tenantId is **null**, `clearFinancialData` **refuses** (throws) and deletes nothing. It must never fall through to an unscoped client.                                                                    | T3                |
| **R3** | P1       | `clearFinancialData` requires `TENANT_ADMIN`; a plain `OPERATOR` is refused — matching its `@Patch("margin")` sibling.                                                                                                      | T4                |
| **R4** | P1       | `clearFinancialData` requires a typed confirmation in the body that **equals the caller's own resolved tenantId**; a missing or mismatched value is refused and deletes nothing.                                            | T5, T6            |
| **R5** | P0       | `deleteAllCustomers` refuses with `ConflictException` when any in-scope customer has a `PAID` or `SENT` invoice, deleting nothing — same statuses, same exception type and same message shape as its `batchDelete` sibling. | T7, T8            |
| **R6** | P1       | `deleteAllCustomers` still deletes normally when no customer has a `PAID`/`SENT` invoice (no regression).                                                                                                                   | T9                |
| **R7** | P2       | Code map updated surgically: `api.md` entries, one dated `CHANGELOG.md` bullet, `_meta.json` re-anchored and still **valid JSON**.                                                                                          | Gate (JSON parse) |
| **R8** | P1       | The wipe deletes the tenant's `OrderCreditNote` link rows (by parent credit-note id) **before** deleting credit notes, and tenant B's links survive.                                                                        | T1                |

### R2 — why it is P0 and separate from R1

`prisma.service.ts:48` reads `if (!tenantId) return fn(rawTx)` — `tenantTransaction` hands back the
**raw unscoped transaction** when there is no tenant. `forTenant()` documents the same
(SUPER_ADMIN ⇒ "unscoped `this` — full DB access"). So R1 alone, implemented as a naive swap to
`tenantTransaction`, still leaves the original defect reachable. R2 closes that door explicitly. A
destructive bulk endpoint has no legitimate "operate on all tenants" mode.

### R4 — the confirmation shape

Body: `{ "confirmTenantId": "<the caller's tenantId>" }`, validated by a class-validator DTO
(`@IsString() @IsNotEmpty()`), then compared in the handler against `prisma.getTenantId()`. Echoing
your own tenantId proves both intent _and_ that you know which tenant you are wiping — and it needs
no extra lookup, since the value is already resolved server-side. A literal magic string was rejected:
it proves intent but not target.

### R8 — why (found in review, missing from the original spec)

`OrderCreditNote.creditNoteId` is a **required FK with no `onDelete`** — Prisma's default is
**Restrict** — so `creditNote.deleteMany` aborts the whole transaction (endpoint 500s) for any
tenant whose credit notes are linked to orders. Today's unscoped handler has the same latent
failure; a "hardened" wipe that still cannot run for exactly the tenants most likely to use it
would not be done. Delete the links by parent credit-note id (same NULL-tenant reasoning as the
other children). `CreditNoteItem` needs **no** explicit delete — its FK has `onDelete: Cascade`.

## Completeness sweep

Lifecycle of the destroyed objects — create/read/list/edit are untouched; only **delete** changes.
Reverse of the action: **there is none, and that is the point** — both endpoints are irreversible, and
that is precisely why the guards belong in front of them. No undo is in scope.

States handled: unauthorized (R3), unauthenticated (existing `JwtAuthGuard`, unchanged), missing
tenant context (R2), bad/missing body (R4), conflict/blocked (R5), empty — zero customers already
returns `{ deleted: 0 }` and must continue to (R6). Concurrency is out of scope: both run inside a
single transaction, and no new race is introduced.

Audit trail: **not added.** Genuinely wanted (see discovery #6 — after a firing there is no record of
what was removed), but it is a separate change with its own storage and retention questions. Recorded
as a non-goal, not forgotten.

## Deploy-day / entitlement trap

- **B126.** No caller in `apps/web` or `apps/mobile` — verified by grep. So no user-visible change on
  deploy day. Any _external script_ calling it will begin receiving 403 (non-`TENANT_ADMIN`) or 400
  (missing `confirmTenantId`). That is the intended outcome and is the one behavioural break in this
  PR; it is called out in the PR body.
- **B127.** **No UI caller either** (corrected in review): `useDeleteAllCustomers`
  (`apps/web/lib/api/customers.ts:476`) is exported but imported by no component — the register's
  round-4 note ("hook exists but has no UI caller today") is right. So on deploy day nothing
  user-visible changes for either bug. A **direct API caller** whose customers hold PAID/SENT
  invoices gets 409 where the call previously succeeded — the fix, not a regression, and it makes
  the endpoint agree with the `batchDelete` sibling.
- **No entitlement/flag is involved**, so the "gate nothing can grant" trap does not apply here.
- **No backfill required** — no schema change, no data migration, nothing to reconcile.
- **Rollback:** revert the single squash commit. No migration to unwind, no data written.

## Non-goals (the scope fence)

1. **Row-level security at the database.** The real root cause (21 migration dirs, zero RLS policies).
   Platform-level project; recorded in discovery #7.
2. **Deleting the B126 endpoint** rather than hardening it — argued and rejected in discovery; revisit
   if telemetry ever shows zero callers.
3. **An audit trail / soft-delete for destructive endpoints.** Wanted, separate change.
4. **Auditing every other unscoped `deleteMany`/raw-client call site.** This PR fixes two known
   instances; a repo-wide sweep is its own task.
5. Changing `batchDelete`, `deleteCustomer`, or any other sibling — they are already correct and are
   the reference behaviour we are matching.
6. Any UI, mobile, e2e or migration work.

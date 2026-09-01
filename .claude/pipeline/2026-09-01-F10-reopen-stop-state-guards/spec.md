# Spec — F10: reopenStop and stop-state guards

**Status:** IMPLEMENTED · Repo: RouteFlow monorepo, workdir `.claude/worktrees/rf-F10`.
Files: `apps/api/src/routes/routes.service.ts`, `apps/api/src/routes/dto/update-run-status.dto.ts`,
`apps/api/src/routes/routes.controller.ts` (mechanical pass-through only),
`apps/api/src/routes/routes.service.spec.ts` (existing-test updates + pins),
new `apps/api/src/routes/routes.service.stop-state-guards.spec.ts`.

Line numbers below refer to `routes.service.ts` at branch base `master@df1ef9a3` (2729 lines).

## Requirements

### R1 (B54, Critical, unit-verified — T1–T3)
`reopenStop` refuses to reopen a stop while **live money** stands against any of the stop's
orders: an `Invoice` row with `orderId` in the stop's orderIds that either has
`status` in `{PAID, PARTIAL}` **or** has `payments: { some: CONFIRMED_PAYMENT } }`
(`CONFIRMED_PAYMENT` imported from `../invoices/payment-predicates` — never a literal
`status: "PAID"`). On a hit: `BadRequestException("Payment already recorded against this
delivery — contact your operator to correct")` **before** `tenantTransaction` is entered.
The existing legacy `transaction.findMany` guard (2600–2613) **stays** — historical rows
written under the dead model must still block. The reopen transaction body is unchanged by R1.

### R2 (B55, Critical, unit-verified — T4–T5)
`reopenStop` writes **no stock**: delete the entire stock-reversal loop (2616–2662 — the
`stockMovement.create` positive-SALE writes and `product.update currentStock increment`) and
the now-unused `deliveryMutation.findMany` load (2593–2597). Delivery never decrements stock
(settled at order creation, `orders.service.ts:4135` convention), so there is nothing to
reverse. The remaining reversal steps are untouched: `deliveryMutation.deleteMany`, order
items → PENDING, order → CONFIRMED, stop reset, run reopen + settlement reset.

### R3 (B71, High, unit-verified — T6–T8)
`updateStopStatus` gains from-state guards, in this order after the stop lookup:
1. `stop.status === "COMPLETED"` → `ConflictException` telling the caller to use reopen
   ("This stop is completed. Reopen it instead — that reverses the delivery correctly.").
2. The parent run is loaded for **every** caller (select `driverId`, `status`); missing run →
   `NotFoundException`. `run.status` COMPLETED or CANCELLED → `ConflictException`.
3. The existing DRIVER isolation check (driver row vs `run.driverId`) reuses that run row.
SKIPPED → IN_PROGRESS stays allowed. PENDING/IN_PROGRESS stops on an IN_PROGRESS/SCHEDULED
run behave exactly as before (arrivedAt stamping unchanged).

### R4 (B72 matrix, High, unit-verified — T9–T11)
`dto/update-run-status.dto.ts` exports
`forbiddenRunTransition(from: RouteRunStatus, to: RouteRunStatus): string | null` —
a **deny-list**: same→same returns null (idempotent retries); `CANCELLED → COMPLETED` returns
a rejection reason; `COMPLETED → SCHEDULED` returns a reason; all else null.
`updateRunStatus` calls it right after the run lookup and throws
`ConflictException(reason)` on non-null, before any other check. The existing
stops-complete check and B152 cash backstop for COMPLETED stay untouched.
COMPLETED → IN_PROGRESS remains allowed (explicit non-goal below).

**CANCELLED is NOT absorbing** (corrected in review — the original R4 made it terminal):
`CANCELLED → SCHEDULED/IN_PROGRESS` stays legal because it is the only recovery an
accidentally cancelled run has. `deleteRun` refuses any run carrying a `deliveryMutation`
("cancel it instead of deleting"), `reopenStop` refuses a cancelled run, and the dispatch
sweep in `createRouteRun` only picks up orders whose `routeRunStopId` is null — nothing
clears it on cancel (F11's scope) — so a terminal CANCELLED would strand the run **and** its
undelivered orders with no path out for any role. WHO may un-cancel is `updateRunStatus`'s
call, not the matrix's: inside the existing `role === DRIVER` branch, a run whose current
status is CANCELLED is refused with `ForbiddenException("This run was cancelled — ask your
operator to restart it.")`, so a stale driver device cannot resurrect a called-off run by
replaying "start run".

### R5 (B72 ownership, High, unit-verified — T12–T14)
For `user.role === DRIVER`, all three of `updateRunStatus`, `completeStop`,
`completeWithPayment` require the caller's driver row to exist and match `run.driverId`,
else `ForbiddenException("You do not have access to this route run")` — the exact pattern
`updateStopStatus`/`reopenStop` already use. In the two completion paths the existing driver
lookup (1950–1953 / 2159–2162) **moves up** to immediately after the stop-already-completed
check, and the ownership check sits right after it — so a hijacker's POD is never ingested
(no `storage.upload`) and no transaction is opened. In `updateRunStatus` the driver lookup
is new, placed inside the existing `role === DRIVER` branch after the target-status check.

### R6 (B120, High, unit-verified — T15–T16)
Inside `reopenStop`'s transaction, **before** the stop reset, write an archival audit row via
`tx.auditLog.create` (atomic with the reset — if the archive fails the reset rolls back):
`action: "route_stop.reopened"`, `entityType: "RouteRunStop"`, `entityId: stopId`,
`userId: user.sub ?? null`, `meta` carrying `runId` and the discarded state:
`signatureUrl`, `podPhotoUrls`, `safeDropEnabled`, `driverNote`, `completedAt` (ISO string or
null), `ageVerified`, `identityVerified`, `identityType`, `identityVerifiedAt` (ISO or null).
`tenantId` is NOT set explicitly — the `tenantTransaction` write-proxy injects it.
The reset itself (nulling all those columns, incl. the deliberate ageVerified/
identityVerified re-derivation reset) is otherwise unchanged, but the `routeRunStop.update`
call now also spreads `...(podArchive ?? {})`, which appends `{archivedAt, signatureUrl,
podPhotoUrls, reason: "reopen"}` to `RouteRunStop.podHistory` — a second, queryable record of
the discarded POD state alongside the AuditLog row (empty/undefined when the reopen displaces
no pointers). The row is written for every reopen (SKIPPED stops too — the reopen itself is
audit-worthy; meta then carries empty/false values). No storage objects are deleted — evidence
is retained, now referenced from both the audit row and `podHistory`.

### R7 (B121 immutability, Critical, unit-verified — T17–T18)
`attachPodArtifact`: after the same-artifactId idempotent branch (unchanged — offline replay
still returns the stored artifact), reject `kind === "signature"` when
`stop.status === "COMPLETED"` and `(stop.signatureUrl ?? "").trim().length > 0` with
`ConflictException("This completed stop already has a signature. Reopen the stop to
re-capture it.")`. Photos stay appendable on completed stops. Adding a signature to a
completed stop that has none remains allowed (the endpoint's documented
before-OR-after-completion contract).

### R8 (B121 ownership, High, unit + type-verified — T19)
`attachPodArtifact` gains a fourth parameter `user: JwtPayload`. For DRIVER callers, the
driver row must exist and match `run.driverId` (Forbidden, same message as R5) — checked
**before** the idempotent read, so a foreign driver cannot read the stored artifact either.
`routes.controller.ts` `attachPodArtifact` (226–235) adds `@CurrentUser() user: JwtPayload`
and passes it through. (If the controller were missed, `tsc` fails — the missing-argument
error is the wiring proof.) `getStopPod` gets the same treatment: it gains a `user: JwtPayload`
parameter and the identical DRIVER ownership binding (routes.service.ts:1938–1957), and
`routes.controller.ts`'s `getStopPod` handler (241–247) adds `@CurrentUser() user: JwtPayload`
and passes it through, same wiring proof.

## Error-shape conventions
State conflicts → `ConflictException` (409; matches the demotion guard in orders.service.ts).
Live-money reopen block → `BadRequestException` with the **existing** message (kept verbatim —
mobile/web surface `err.message`). Ownership → `ForbiddenException` with the existing
"You do not have access to this route run" message. All three exception classes are already
imported in routes.service.ts.

## Deploy day
No migration, no backfill, no new entitlement/flag (nothing to grant — L-016 n/a). Existing
damaged rows (B55-inflated `currentStock` + uncosted positive SALE rows referencing
`Reopen stop <id>`; B54-stranded PAID invoices on reopened stops) are NOT fixed by this PR —
they are the D4 repair flight, run post-deploy from the campaign close-out with backup +
dry-run + per-row tx + JSONL log to local-assets/. Behavior change on deploy day: reopens of
paid deliveries start failing with the guard message (correct — operators void the payment
first); reopens stop inflating stock immediately. Rollback: revert the squash commit — no
data shape changed.

## Non-goals (scope fence)
- The CANCEL path's side-effect reset and `deleteRun` settlement gates — **F11's** (its
  fix-card carries the write-up). Do not touch `deleteRun` or add CANCELLED side-effects.
- COMPLETED → IN_PROGRESS on `updateRunStatus` stays allowed: the register's fix names only
  from-CANCELLED and COMPLETED→SCHEDULED; stop-level money/stock effects are untouched by a
  run-level flip, and blocking it risks operator recovery flows not in evidence.
- Voiding the payment atomically inside reopen (register's option B) — not taken; option A
  (block + operator corrects) preserves the money trail.
- Deleting POD storage objects — evidence retention chosen instead (R6).
- B120's web read-surface gap (separate register entry, not in F10).
- `RUN_LINE_ITEMS_SELECT` (G7) is not touched — reopenStop's own `lineItems: true` include
  predates it and is not a select-shape read; never re-inline or fork the const.
- No web/mobile client changes — clients already render 4xx error messages from these
  endpoints.

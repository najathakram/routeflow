# Build plan — F10: reopenStop and stop-state guards

**Status:** IMPLEMENTED · Workdir: the git worktree at `.claude/worktrees/rf-F10` (branch
`fix/F10-reopen-stop-state-guards` off `master@df1ef9a3`). All paths below are relative to
that workdir. Companion artifacts: `discovery.md`, `spec.md`, `test-plan.md` in this folder —
they are the full context; nothing else from any conversation exists for you.

Repo facts you must respect
- Prettier: semicolons, double quotes, printWidth 100, trailing commas. Conventional Commits.
- NO new dependencies, NO snapshot tests, NO Vitest. Jest only, house mock patterns.
- Money math only via `apps/api/src/common/pricing.ts` helpers (this change adds no money
  math — do not introduce any).
- `apps/api/src/routes/routes.service.ts` is ~2729 lines; use targeted edits, never rewrite
  the file. Line anchors below are from `master@df1ef9a3`.
- Never touch: `deleteRun`, the CANCELLED-branch side effects (F11's scope),
  `RUN_LINE_ITEMS_SELECT` (G7 — do not re-inline, fork, or extend it here; this batch does
  not change any run-read select), `getUnsettledPhysicalMoney`, the RF-016 auto-complete
  blocks, the B152 cash backstop, the legacy `transaction.findMany` guard (it STAYS), the
  idempotency helpers, `.campaign/` artifacts, any file outside the five named in spec.md.
- Test tenants/fixtures only — placeholder ids like "t1", "drv-1"; never a real client name.

## Work packages

### TP-guards (test package — authored FIRST, red-gated)
- **files:** `apps/api/src/routes/routes.service.stop-state-guards.spec.ts` (new)
- **brief:** Author tests T1–T19 exactly per `test-plan.md` (titles verbatim, oracles and
  red-anchors as specified). Mirror the setup block of
  `apps/api/src/routes/routes.service.spec.ts:76–141` — same imports, same jest.mock calls
  for `../common/geocode.util` and `../storage/compress.util`, same provider list via
  `createMockPrisma()`. Use `(service as any)` for every `attachPodArtifact` call (the
  4-arg signature does not exist yet) and `require("./dto/update-run-status.dto")` +
  `toBeDefined()` for the helper (does not exist yet). Import `CONFIRMED_PAYMENT` from
  `../invoices/payment-predicates` for T3's where-shape assertion. Reopen fixtures need
  `prisma.routeRun.findUnique` returning the run WITH `stops: [stop]` (reopenStop reads
  `run.stops[0]`) and `prisma.transaction.findMany` → `[]`. Implementation is FORBIDDEN.

### WP-dto
- **files:** `apps/api/src/routes/dto/update-run-status.dto.ts`
- **satisfies:** R4 · **provenBy:** T11, T9, T10
- **brief:** Keep the existing DTO class byte-for-byte. Append exactly:

```ts
/**
 * B72: from-state guard for PATCH /route-runs/:id/status. A deny-list, not a
 * whitelist — the endpoint's live callers (web cancel flows, driver
 * start/complete, operator backfill SCHEDULED→COMPLETED) stay untouched; only
 * the two indefensible classes are closed: CANCELLED→COMPLETED, and a
 * COMPLETED run can never be re-SCHEDULED (reopenStop is the sanctioned path
 * back into a completed run). CANCELLED is NOT absorbing — the un-cancel is the
 * only recovery an accidentally cancelled run has (see spec.md R4); the DRIVER
 * branch of updateRunStatus is what keeps it operator-only. Same-status writes
 * stay allowed so offline retries remain idempotent. Returns the rejection
 * reason, or null when the transition may proceed.
 */
export function forbiddenRunTransition(
  from: RouteRunStatus,
  to: RouteRunStatus,
): string | null {
  if (from === to) return null;
  if (from === RouteRunStatus.CANCELLED && to === RouteRunStatus.COMPLETED) {
    return "This run is cancelled — restart it before marking it completed.";
  }
  if (from === RouteRunStatus.COMPLETED && to === RouteRunStatus.SCHEDULED) {
    return "This run is completed — it cannot go back to scheduled. Reopen a stop instead.";
  }
  return null;
}
```

### WP-service (dependsOn: WP-dto)
- **files:** `apps/api/src/routes/routes.service.ts`,
  `apps/api/src/routes/routes.service.spec.ts`
- **satisfies:** R1, R2, R3, R4 (consumption), R5, R6, R7, R8 · **provenBy:** T1–T19
- **brief:** Six surgical edits to the service + the existing-spec updates from
  test-plan.md's "Regression pins" section. Imports to add at the top:
  `forbiddenRunTransition` (from `./dto/update-run-status.dto`), `InvoiceStatus` (add to the
  existing `@prisma/client` import list). `ConflictException`, `ForbiddenException`,
  `BadRequestException`, `CONFIRMED_PAYMENT`, `JwtPayload` are already imported.

**Edit 1 — updateRunStatus (R4+R5, anchor :1368–1380).** Immediately after
`if (!run) throw new NotFoundException(...)` insert:

```ts
    // B72: from-state guard — see forbiddenRunTransition's doc for the matrix.
    const denied = forbiddenRunTransition(run.status, dto.status);
    if (denied) throw new ConflictException(denied);
```

Inside the existing `if (user.role === UserRole.DRIVER) { ... }` branch, AFTER the
allowedStatuses check, append the un-cancel gate (drivers may not restart a called-off run —
the matrix leaves CANCELLED→IN_PROGRESS legal for operators only)

```ts
      if (run.status === RouteRunStatus.CANCELLED) {
        throw new ForbiddenException("This run was cancelled — ask your operator to restart it.");
      }
```

and then:

```ts
      // B72: same driver binding as updateStopStatus/reopenStop — a driver may
      // only move a run assigned to them.
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
```

**Edit 2 — updateStopStatus (R3, anchor :1680–1708).** Replace the body between the stop
lookup and the `updates` construction so it reads: stop lookup + NotFound (unchanged); then

```ts
    // B71: COMPLETED is exited only via reopenStop — it reverses the delivery's
    // mutations, stock-truth and payment guard; flipping the column here would
    // strand those side effects and blind the delivered-order demotion guard,
    // which keys on stop.status === COMPLETED.
    if (stop.status === "COMPLETED") {
      throw new ConflictException(
        "This stop is completed. Reopen it instead — that reverses the delivery correctly.",
      );
    }

    const run = await this.prisma
      .forTenant()
      .routeRun.findFirst({ where: { id: runId }, select: { driverId: true, status: true } });
    if (!run) throw new NotFoundException("Route run not found");
    if (run.status === RouteRunStatus.COMPLETED || run.status === RouteRunStatus.CANCELLED) {
      throw new ConflictException(`Cannot change a stop on a ${run.status.toLowerCase()} run.`);
    }

    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
    }
```

(The old driver-only run lookup is subsumed — delete it. `updates` construction and the
final `routeRunStop.update` stay unchanged.)

**Edit 3 — completeStop (R5, anchors :1937 and :1950–1953).** Move the driver lookup up:
immediately after `if (stop.status === "COMPLETED") throw ...` insert

```ts
    const driver =
      user.role === UserRole.DRIVER
        ? await this.prisma.forTenant().driver.findFirst({ where: { userId: user.sub } })
        : null;
    // B72: a driver may only complete stops on a run assigned to them — checked
    // before the idempotency read and POD ingest so a hijacker's capture is
    // never stored.
    if (user.role === UserRole.DRIVER && (!driver || run.driverId !== driver.id)) {
      throw new ForbiddenException("You do not have access to this route run");
    }
```

and DELETE the original `const driver = ...` block at :1950–1953 (the tx code keeps using
`driver`).

**Edit 4 — completeWithPayment (R5, anchor :2159–2162).** Identical move: insert the same
lookup+check right after its `stop.status === "COMPLETED"` throw (:2136), delete the
original block at :2159–2162.

**Edit 5 — attachPodArtifact (R7+R8, anchor :1828–1863) + its doc comment.** New signature
`async attachPodArtifact(runId: string, stopId: string, dto: AttachPodArtifactDto, user: JwtPayload)`.
After the stop NotFound check insert:

```ts
    // B121: same driver binding as reopenStop/updateStopStatus — checked before
    // the idempotent read so another driver's replay cannot read the stored
    // artifact either.
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || run.driverId !== driver.id) {
        throw new ForbiddenException("You do not have access to this route run");
      }
    }
```

After the `if (existing) { return ... }` idempotent branch insert:

```ts
    // B121: the signature that satisfied the regulated-delivery gate is
    // immutable once the stop is COMPLETED — a different artifact may not
    // replace it (the same-artifactId offline replay returned above). Photos
    // stay appendable; reopenStop is the sanctioned path to re-capture.
    if (
      dto.kind === "signature" &&
      stop.status === "COMPLETED" &&
      (stop.signatureUrl ?? "").trim().length > 0
    ) {
      throw new ConflictException(
        "This completed stop already has a signature. Reopen the stop to re-capture it.",
      );
    }
```

**Edit 6 — reopenStop (R1+R2+R6, anchors :2593–2698).**
(a) DELETE the mutation load at :2593–2597 (`const mutations = await ... deliveryMutation
.findMany({ ... include: { order: ... } })`) — R2 removes its only consumer.
(b) After the `orderIds` construction and BEFORE the legacy `transaction.findMany` guard,
insert:

```ts
    // B54: the live at-door writer is InvoicePayment via
    // recordDeliveryPaymentInTx — the legacy `transaction` model has no writer
    // left, so the guard below it can never fire on new data. Block the reopen
    // while confirmed money stands against any of this stop's orders' invoices:
    // reversing delivery state under a live payment strands a PAID invoice on
    // an order the system then says was never delivered, and the re-delivery's
    // second collection is unrecorded (PAYABLE excludes PAID).
    if (orderIds.length > 0) {
      const liveMoney = await this.prisma.forTenant().invoice.findFirst({
        where: {
          orderId: { in: orderIds },
          OR: [
            { status: { in: [InvoiceStatus.PAID, InvoiceStatus.PARTIAL] } },
            { payments: { some: CONFIRMED_PAYMENT } },
          ],
        },
        select: { id: true },
      });
      if (liveMoney) {
        throw new BadRequestException(
          "Payment already recorded against this delivery — contact your operator to correct",
        );
      }
    }
```

(keep the legacy guard verbatim after it — historical rows must still block).
(c) DELETE the entire stock-reversal loop :2616–2662 (the `for (const mutation of
mutations)` block including both `tx.stockMovement.create` and `tx.product.update`
`currentStock` increment, and its leading comment). Step 2's `deliveryMutation.deleteMany`
becomes step 1.
(d) BEFORE the stop-reset `tx.routeRunStop.update` (:2683), insert:

```ts
      // B120: the reset below discards the only pointers to the stored POD
      // artifacts (these columns are storage keys since #477). Archive them in
      // this same transaction so regulated-delivery evidence stays recoverable
      // and the storage objects stay referenced; tenantId is injected by the
      // tenantTransaction write proxy.
      await tx.auditLog.create({
        data: {
          userId: user.sub ?? null,
          action: "route_stop.reopened",
          entityType: "RouteRunStop",
          entityId: stopId,
          meta: {
            runId,
            signatureUrl: stop.signatureUrl ?? null,
            podPhotoUrls: stop.podPhotoUrls ?? [],
            safeDropEnabled: stop.safeDropEnabled ?? false,
            driverNote: stop.driverNote ?? null,
            completedAt: stop.completedAt ? stop.completedAt.toISOString() : null,
            ageVerified: stop.ageVerified ?? false,
            identityVerified: stop.identityVerified ?? false,
            identityType: stop.identityType ?? null,
            identityVerifiedAt: stop.identityVerifiedAt
              ? stop.identityVerifiedAt.toISOString()
              : null,
          },
        },
      });
```

The reset block itself and the run-reopen/settlement-reset step are otherwise unchanged, but
the `routeRunStop.update` call also spreads `...(podArchive ?? {})`, appending
`{archivedAt, signatureUrl, podPhotoUrls, reason: "reopen"}` to `RouteRunStop.podHistory`.
Renumber the step comments (1..5) coherently.

**Existing-spec updates (same package):** apply test-plan.md's "Regression pins" list —
4th arg `operatorPayload` on every existing `attachPodArtifact` call, the new photos-
appendable pin, `prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" })` in the two
driver-role updateRunStatus tests. Then run the FULL existing spec and fix any other test
whose only failure is a missing mock for the new collaborator reads (never weaken an
assertion to get green).

### WP-controller (dependsOn: WP-service)
- **files:** `apps/api/src/routes/routes.controller.ts`
- **satisfies:** R8 · **provenBy:** type gate (tsc) + T18/T19 (service-level)
- **brief:** In `attachPodArtifact` (:226–235) add `@CurrentUser() user: JwtPayload` as the
  last parameter and pass it as the 4th argument to
  `this.routesService.attachPodArtifact(runId, stopId, body, user)`. `@CurrentUser` and
  `JwtPayload` are already imported in this file (used by the neighbouring endpoints — copy
  their exact decorator style). Apply the identical change to `getStopPod` (:241–247): add
  `@CurrentUser() user: JwtPayload` and pass it as the new argument to
  `this.routesService.getStopPod(...)`. No other endpoint changes.

## Gates

- **redGate:** `cd apps/api && npx jest src/routes/routes.service.stop-state-guards.spec.ts --silent`
  → expect fail (assertion failures only).
- **verifyCommands.perRound:** `cd apps/api && npx tsc -p tsconfig.build.json --noEmit`
- **verifyCommands.final:**
  1. `cd apps/api && npx jest src/routes --silent` (new file + full existing routes suite +
     dto specs)
  2. `cd apps/api && npx eslint src/routes`
- Whole-repo `npm run verify` + `node scripts/campaign-check.mjs --batch F10` run in the
  orchestrator's close-out, NOT here (they depend on full-run artifacts a scoped runner
  does not produce).

## Mutation probe targets (all in the HIGH-risk file)

| file | behavior | test |
|------|----------|------|
| apps/api/src/routes/routes.service.ts | reopenStop blocks when a live invoice/payment exists (delete the liveMoney throw → T1 must fail) | routes.service.stop-state-guards.spec.ts REG-B54 T1 |
| apps/api/src/routes/routes.service.ts | reopenStop writes no stock (re-add a tx.stockMovement.create in the tx → T4 must fail) | REG-B55 T4 |
| apps/api/src/routes/routes.service.ts | updateStopStatus rejects COMPLETED stops (drop the Conflict throw → T6 must fail) | REG-B71 T6 |
| apps/api/src/routes/routes.service.ts | updateRunStatus enforces the matrix (skip the forbiddenRunTransition call → T9 must fail) | REG-B72 T9 |
| apps/api/src/routes/routes.service.ts | attachPodArtifact signature immutability (drop the Conflict throw → T17 must fail) | REG-B121 T17 |
| apps/api/src/routes/routes.service.ts | completeStop ownership (drop the driver comparison → T13 must fail) | REG-B72 T13 |

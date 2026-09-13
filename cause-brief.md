# Cause Brief — F27 (Estimates)

Verified against `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F27` @ HEAD `2d353752` (branch `plan/F27` = `origin/master`).

### B15 — Convert to Invoice offered on non-convertible statuses (medium/T2) — LIVE, confirmed

**Repro:** `[id]/page.tsx:239` (`status==="DRAFT"`) and `:267` (`status==="SENT"`) both render the
Convert button (`onClick={handleConvert}` at :253 and :285); only the `status==="ACCEPTED"` block
(~:300) is legal. Click → `estimates.service.ts:271-272` `if (existing.status !== "ACCEPTED") throw
BadRequestException("Only ACCEPTED estimates can be converted")` → 400. `handleConvert`'s `onError`
(:182-188) shows a fixed "Failed to convert estimate / Please try again." toast, discarding the
real reason.

**Claim:** DRAFT/SENT blocks predate the ACCEPTED-only server contract, never pruned when mobile's
stricter gate was added.

**git blame:** all three blocks + the service check are original from `41ab2803c` (2026-03-24);
only touched since by `5b3b3c4e` (2026-09-10, Next15/React19 bump — no logic change).

**Tests:** `estimates.service.spec.ts` covers `convertToInvoice()` claim/race only; no
`*.test.tsx` for `[id]/page.tsx`. Mobile already correct: `estimates-logic.ts:46-52`
`canConvert: status === "ACCEPTED"` only.

**Lessons:** none hit this UI/API mismatch pattern; L-076 (assert toasts via the toast container)
applies if a fix's test checks the corrected error message.

---

### B16 — "Expired" estimate filter (low/T2) — **STALE, already fixed**

**Verification:** `grep -ri EXPIRED` across `apps/api/src/estimates`, all of
`apps/web/app/(dashboard)/estimates/**`, `estimates-logic.ts`, and the `EstimateStatus` enum
(`finance.prisma:48-54`: DRAFT/SENT/ACCEPTED/DECLINED/CONVERTED, no EXPIRED) returns **zero hits**
for a filter/chip. `STATUS_OPTIONS` (`page.tsx:79-85`) and the KPI chip row (:729-778) only cover
All/Draft/Sent/Accepted/Declined. `estimates.service.ts:156`'s unvalidated
`if (status) where.status = status;` is real but unreachable from any current UI control.

**Verdict:** already fixed in `60d10e66` (2026-09-05, #621), recorded as **L-072**. Leftover
comments confirm it: `estimates-logic.ts:43-44` and `[id]/page.tsx:216` both say *"dropped a
comparison against a phantom \"EXPIRED\" EstimateStatus value the schema has never had."*
`estimates.ts:6-10` now imports `EstimateStatus` from `@routeflow/types` instead of a hand-typed
union.

**Lesson:** **L-072** — *"Never hand-declare a client mirror of a server (Prisma) enum — derive
one const-array union per enum from a shared package and pin it set-equal to `Object.values()` ...
never against a second hand-typed 'expected' list."* Guard: `enum-parity.spec.ts` now pins
`EstimateStatus`. Recommend closing B16 as stale, not re-fixing.

---

### B17 — "Send" is a no-op; no invoice↔estimate FK (high/T1) — **half live, half stale**

**Send is a no-op — LIVE, confirmed:** `estimates.controller.ts:39-41` →
`estimates.service.ts:231-233`: `async send(id) { return ...estimate.update({ where:{id},
data:{status:"SENT"} }) }` — no email/PDF/link. Zero "estimate" refs in `apps/api/src/email/*`;
zero pdf/print/email+estimate hits under `apps/web`.

**FK claim is STALE — schema already wired for it:** `finance.prisma:552-579` `Estimate` now has
`invoiceId String? @unique` (:570) + relation `invoice Invoice? @relation("EstimateInvoice", ...,
onDelete: SetNull)` (:578); `Invoice` has the back-relation (`:216`). Migration
`20260908000000_campaign_schema_foundation/migration.sql:27-28,45,51` added the column/index/FK.
**But it's never written:** `convertToInvoice()`'s invoice-create block (`:305-329`) and its
`updateMany` claim (`:283-289`, sets only `status:"CONVERTED"`) never touch `invoiceId` — it stays
NULL forever. So "nothing links back" is true in effect, false in cause (schema ready, service
write missing).

**Claim:** staged rollout — `finance.prisma:567-569` comment says *"F01/B17+B70: the invoice a
CONVERTED estimate produced ... F27 wires the write"* — i.e. this batch is the intended wiring
point, not an oversight.

**git blame:** schema fields from `60d10e66` (2026-09-05); DB column via migration
`20260908000000_campaign_schema_foundation` (2026-09-08, 3 days later). `send()`/convert-tx bodies
unchanged since B8/B100 fix rounds — no commit ever added the `invoiceId` write.

**Tests:** `convertToInvoice()` specs assert `status` claims + invoice creation, never `invoiceId`.

**Lessons:** **L-100** (mint numbers via `NumberingService.reserveNext` standalone before any
rollback-able tx) if a fix touches numbering; **L-067** (*"a derived field comes from the field it
represents, never a correlate"*) for writing `invoiceId`/back-refs directly, not inferred.

---

### B70 — CONVERTED estimate launderable back to ACCEPTED, re-converted (high/T1) — LIVE, confirmed

**Repro:** `send()` (`:231-233`) and `decline()` (`:246-248`) are bare `estimate.update` calls, no
status predicate — either can flip a CONVERTED estimate to SENT/DECLINED. `accept()` (`:236-244`)
DOES exclude CONVERTED atomically (`updateMany where:{id,status:{not:"CONVERTED"}}`), so once
laundered to SENT/DECLINED it now passes `accept()` → ACCEPTED. `convertToInvoice()`'s claim
(`:283-289`, `where:{id,status:"ACCEPTED"}`) matches again → mints a 2nd `Invoice` with identical
lines. `voidEstimate()` (`:249-255`) DOES block CONVERTED, proving `send`/`decline` are the
outliers. No back-reference exists to catch the duplicate (see B17).

**Claim:** `accept()`'s CONVERTED-exclusion was added later, specifically for the B8 double-invoice
bug, and the fix touched only `accept()`/`convertToInvoice()` — `send`/`decline` were never
revisited for the same hole via a different entry point.

**git blame:** `accept()`'s atomic claim is from `1fd21f128` (2026-08-20). `send()`/`decline()`
bodies untouched since `da5e89faa` (2026-04-08) — predate the 2026-08-20 fix by 4 months, never
touched by it. `voidEstimate`'s CONVERTED guard is also from `da5e89faa` — same commit added the
correct guard there but left `send`/`decline` bare.

**Tests:** `estimates.service.spec.ts` thoroughly covers `accept()`/`convertToInvoice()` (B8
regression, lines 46-204) but **zero tests exist for `send()` or `decline()`** — matches the live
gap exactly.

**Lesson:** **L-081** — *"gate a money write inside the primitive that performs it, on the row it
just read (an exclude-list ...); keep every status set in one named module"* — `accept()`'s
`status:{not:"CONVERTED"}` pattern is the house-proven shape; `send`/`decline` simply never
adopted it.

---

### B79 — Estimate Issue Date required in UI, never sent, unwired column (high/T1) — CONFIRMED (not stale)

Re-verifying the 2026-09-11 correction directly:

1. **Column exists:** `finance.prisma:561-563` `issueDate DateTime?`, added by migration
   `20260908000000_campaign_schema_foundation/migration.sql:28`. Confirmed present, no drift.
2. **Zero-hit grep CONFIRMED:** `grep -n issueDate apps/api/src/estimates/*.ts` → no matches.
   `create()`'s `estimate.create({data:{...}})` block (`:143-163`) never reads `dto.issueDate` /
   never writes `issueDate` — column is permanently NULL for every estimate.
3. **Three readers fall back to `createdAt`, confirmed:** `page.tsx:921` and `[id]/page.tsx:358,501`
   all do `(... as any).issueDate ?? ....createdAt` — `(as any)` because
   `packages/types/api/misc.ts`'s `Estimate` interface (`:59-74`) has no `issueDate` field.
4. **Required-but-unsent, confirmed:** form state (`page.tsx:149`), required validation (`:334`
   `if (!issueDate) errs.issueDate = "Issue date is required."`), and input binding (`:470-481`)
   all exist — but the submit `dto` (`:343-355`, sent at `:358`) omits `issueDate` entirely (only
   `customerId`, `expiresAt`, `notes`, `items`).
5. **No PATCH/PUT:** controller exposes only POST/GET/send/accept/decline/convert/void — an
   existing estimate's issue date can never be edited after creation.

**Claim:** same staged-rollout pattern as B17 — schema/migration (`60d10e66` /
`20260908000000_campaign_schema_foundation`) landed ahead of DTO/service/shared-type wiring, per
`finance.prisma:561-562`: *"Nullable: existing rows keep reading as createdAt until edited; F27
wires the write path."* The web form's issue-date fields actually predate even the schema column
(shipped in an earlier commit) — a double staging gap, UI ahead of DB, DB ahead of service.

**Tests:** zero — no spec or RTL test anywhere references `issueDate` for estimates.

**Lessons:** **L-047** — *"A calendar date is a string, not an instant: store it as UTC midnight
... never `setHours`, local getters or `toLocaleDateString` on a date-only field"* — applies
directly, same class as `expiresAt` on this model. **L-067** — the `(as any).issueDate ??
createdAt` fallback is exactly the "reads a proxy, not the field it names" pattern the lesson
warns against. **L-072** — add `issueDate` to the shared `@routeflow/types` `Estimate` interface
rather than hand-casting `(as any)` per call site.

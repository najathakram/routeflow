# Build plan — F11: run cancel / skip reconciliation

**Branch** `fix/F11-run-cancel-skip-v2` · **worktree** `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11`
(referred to below as `W/`) · base master `c60fe214`. Rows **B129 (Critical) · B211 (new) · B146 · B34**.
**B32 is OUT** (F20) — no `REG-B32` anywhere in this branch. Companions in this directory:
[spec.md](./spec.md) (R1–R15) and [test-plan.md](./test-plan.md) (T1–T26, P1–P12). This document is
the HOW and is standalone — every fact an implementer needs is written here; "verified" means
re-read from `W/` at `c60fe214`. If a file disagrees with a line quoted here, **the file wins and
you report the divergence** (L-026) — never quietly conform, never quietly diverge.

Risk class **HIGH on WP1/WP2** (money attribution, dispatch invariant, state machine), MEDIUM on
the mobile packages, LOW on bookkeeping. Lesson id for this batch is the pre-allocated **L-045**.

---

## 0. Ground rules that bind every package

1. **Layers.** API (`W/apps/api`), mobile (`W/apps/mobile`), one optional web hook
   (`W/apps/web/lib/api/routes.ts`, R14, droppable), scripts (`W/scripts`), and the campaign/meta
   files. **No schema change, no migration** (`skipReason` exists and stays unwritten). The commit
   title names every layer that ships (L-008): `fix(routes,orders,mobile[,web]): …`.
2. **Tiers.** Every row is **T1 = jest**. F11 has **NO Playwright leg and NO post-deploy T2
   discharge**. Never run `playwright` in any form (not even `--list`) — it clobbers
   `.campaign/runs/web-e2e.json`.
3. **Test titles.** Every proof title carries the EXACT token `REG-B129`, `REG-B211`, `REG-B146` or
   `REG-B34` (matched by `/REG-B(\d{2,3})(?![0-9])/`). **Pins** — tests green BEFORE the fix by
   design — carry NO `REG-B` token, are titled `pin (B<id>): …`, and live ONLY in `*.pins.spec.ts`
   (api) / `*.pins.test.ts` (mobile) files that the red gate never lists. **Two rows the test-plan
   placed with the proofs are re-homed here because they are green today:** test-plan T6
   (un-cancel writes only status) becomes **P13** and T11 (withheld auto-complete releases nothing)
   becomes **P14**, both in the routes pins file, titled `pin (B129): …` / `pin (B211): …`. Their
   mutations are still caught: the re-sweep-on-un-cancel mutation by **T5**'s W2 snapshot (REG),
   the release-outside-the-else mutation by **P14** (pin — cited as such in §6).
4. **Red on an ASSERTION, never on a compile/import error.** Mobile ts-jest runs with
   `diagnostics: false`; a missing export is `undefined` at runtime and a missing module throws at
   `require`. Every mobile proof loads the module via `require` inside a try/catch and asserts
   existence FIRST (exact code in §1 TP3). API proofs call existing public methods, so pre-impl
   failures are behavioural.
5. **Harness.** API specs mirror `W/apps/api/src/routes/routes.service.stop-state-guards.spec.ts:1-141`
   byte-for-byte for the module setup (`createMockPrisma()`, `Test.createTestingModule` with
   `RouteFlowGateway` / `NotificationsService` / `MessagingService` / `InvoicesService` /
   `ConfigService` / `StorageService` as `useValue` mocks, `jest.mock("../common/geocode.util")`
   and `jest.mock("../storage/compress.util")`). Payloads:
   `operatorPayload = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any`,
   `driverPayload = { sub: "user-drv", role: "DRIVER", tenantId: "t1" } as any`,
   `RUN_FIXTURE = { id: "run-1", driverId: "drv-1", status, startedAt: null, settlementNote: null, settlementVariance: null, completedAt: null }`.
   `prisma.tenantTransaction` (prisma-mock.ts:223-229) hands the callback the SAME model mocks, so
   `prisma.order.updateMany` records tx writes; where a test must prove the write is ON THE TX
   CLIENT it overrides `(prisma.tenantTransaction as jest.Mock).mockImplementation((fn) => fn(txMock))`
   with explicit `jest.fn()`s (precedent: `routes.service.spec.ts:965-985`). Orders specs mirror
   `W/apps/api/src/orders/orders.lifecycle-conservation.spec.ts:53-140` (the two `jest.mock`s of
   `../invoices/invoices.service` and `../notifications/notifications.service` MUST precede the
   imports — both pull ESM-only deps).
6. **Running jest.** `W/apps/api` has no local `node_modules/.bin`; always run through npm with an
   absolute prefix: `npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/api test -- <paths> [-t <regex>]`
   (api `rootDir` is `src`, so paths are `src/…`). Mobile: `npm --prefix …/apps/mobile test -- __tests__/<file> [-t <regex>]`
   (its `testMatch` is `**/__tests__/**/*.test.ts` — a `.spec.ts` under mobile never runs).
   **Never `turbo run test` for a probe** (L-034 — a cache replay preserves a stale artifact).
   **Do not run jest while `npm ci` is still running in this worktree.**
7. **Do not run `npm run verify`** here (its `campaign-check` step reads run artifacts a fresh
   worktree lacks). **Do not run `npm run format`** (repo-wide; reformatted 85 unrelated files on
   F14). Format ONLY changed files with the exact command in §5.
8. **Scope fence (L-008).** The files listed per package are the fence. `updateStopStatus`'s DTO,
   `skipReason`, `FAILED_DELIVERY`, `deleteRun`/`deleteRoute` gates, `deliveredQty`, `stopsAhead`'s
   computation, a run-row `FOR UPDATE`, a new response field on `updateRunStatus`, the operator
   screen's `handleSkip`, and F08's returns layer are NOT touched. Anything else is a question for
   the lead, not a judgment call.
9. **Never route through `orders.service.changeStatus`; never copy F07's ConflictException retry
   loop into an open transaction** (F10 handoff :197-202). The release helper is two `updateMany`
   calls on the tx client and nothing else.
10. **Order inside the batch:** TP1–TP4 first (red gate) → WP1 → WP2 → WP3 → WP4 → WP5 → WP6 →
    WP7. WP1–WP6 are disjoint by file and may run in parallel once the red gate is confirmed.

---

## 1. Test packages (written FIRST; REG proofs must be red against `c60fe214`)

### Red gate (runs ONLY the REG proofs; expect a non-zero exit)

```
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/api test -- src/routes/routes.service.run-terminal-release.spec.ts src/orders/orders.service.tracking-contract.spec.ts -t "REG-B(129|146|34|211)"
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/mobile test -- __tests__/order-tracking-logic.test.ts __tests__/skip-stop.test.ts -t "REG-B(129|146|34|211)"
```

Expected pre-impl: **every REG test fails on an assertion**; the pre-existing tests in
`order-tracking-logic.test.ts` are filtered out by `-t`. The pins (TP4) are NOT in these commands;
they run under their own command and must be **GREEN pre-impl** (a red pin is a proof in disguise —
move it, never retitle it).

### TP1 — `W/apps/api/src/routes/routes.service.run-terminal-release.spec.ts` (new) · T1–T5, T7–T10, T12–T14, T27–T28 · REG-B129 / REG-B211

Header comment: `// Campaign batch F11 — REG-B129 / REG-B211 proofs (red-gate). See .claude/pipeline/2026-09-02-F11-run-cancel-skip/{spec,test-plan}.md`.
Imports/setup exactly as ground rule 5. Add `import { BadRequestException } from "@nestjs/common";`.

**The stateful order table (T5, T12, T14 share it) — put it at file top:**

```ts
type Row = {
  id: string;
  customerId: string;
  status: string;
  routeRunId: string | null;
  routeRunStopId: string | null;
  fulfillPath: "ROUTE" | "SHIP";
};
function matches(row: Row, where: any): boolean {
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.customerId && row.customerId !== where.customerId) return false;
  if (where.fulfillPath && row.fulfillPath !== where.fulfillPath) return false;
  if ("routeRunStopId" in where) {
    const w = where.routeRunStopId;
    if (w === null && row.routeRunStopId !== null) return false;
    if (w?.in && !w.in.includes(row.routeRunStopId)) return false;
  }
  if (typeof where.status === "string" && row.status !== where.status) return false;
  if (where.status?.notIn && where.status.notIn.includes(row.status)) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  return true;
}
function wireTable(table: Row[], ...mocks: jest.Mock[]) {
  for (const m of mocks) {
    m.mockImplementation(async ({ where, data }: any) => {
      let count = 0;
      for (const row of table)
        if (matches(row, where)) {
          Object.assign(row, data);
          count++;
        }
      return { count };
    });
  }
}
```

The table knows nothing about F11 — it answers whatever `where` the service emits. If the
implementation emits a shape `matches` does not understand, extend `matches`, never the assertion.

**Explicit tx client (T1–T4, T8–T10, T14):**

```ts
function makeTx(over: Partial<Record<string, any>> = {}) {
  return {
    ...prisma,
    routeRun: { ...prisma.routeRun, update: jest.fn() },
    routeRunStop: {
      ...prisma.routeRunStop,
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
    deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
    invoicePayment: { ...prisma.invoicePayment, findMany: jest.fn().mockResolvedValue([]) },
    advancePayment: { ...prisma.advancePayment, findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn().mockResolvedValue(0),
    ...over,
  };
}
```

Tests (titles verbatim; G/W/T per test-plan rows — the load-bearing assertions restated):

| T#  | Title                                                                                                                                                        | Must assert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | `REG-B129: cancelling a run releases the undelivered orders of every non-COMPLETED stop inside the status transaction`                                       | `routeRun.findUnique` → IN_PROGRESS; tx: `routeRun.update` → `{ id:"run-1", status:"CANCELLED", driver:null }`, `routeRunStop.findMany` → `[{id:"s2"},{id:"s3"}]`. After `updateRunStatus("run-1", {status:"CANCELLED"}, operatorPayload)`: `prisma.tenantTransaction` ×1; `tx.routeRun.update` `data` ⊇ `{status:"CANCELLED"}`; `tx.routeRunStop.findMany` `where` ⊇ `{ routeRunId:"run-1", status:{ not:"COMPLETED" } }`; `tx.order.updateMany` called with **exactly** `{ where:{ routeRunStopId:{ in:["s2","s3"] }, status:{ notIn:["DELIVERED","CANCELLED"] } }, data:{ routeRunId:null, routeRunStopId:null } }` (toHaveBeenCalledWith deep-equal); top-level `prisma.order.updateMany` NOT called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T2  | `REG-B129: the OUT_FOR_DELIVERY → CONFIRMED revert is scoped to the released stops and runs before the unlink`                                               | `tx.order.updateMany` ×2; `mock.calls[0][0]` toEqual `{ where:{ routeRunStopId:{ in:["s2","s3"] }, status:"OUT_FOR_DELIVERY" }, data:{ status:"CONFIRMED" } }`; `mock.calls[1][0]` = T1's unlink; `invocationCallOrder[0] < invocationCallOrder[1]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| T3  | `REG-B129: a run with no non-COMPLETED stops cancels without any order write`                                                                                | tx `routeRunStop.findMany` → `[]`; resolves; `tx.routeRun.update` called with CANCELLED (positive — this is what makes it red pre-impl); `tx.order.updateMany` NOT called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T4  | `REG-B129: the driver status broadcast fires only after the cancel transaction has committed`                                                                | `tenantTransaction` mockImplementation: `async (fn) => { const r = await fn(tx); marks.push(performance.now()); return r; }` (or an incrementing counter); `tx.routeRun.update` → `{ id:"run-1", status:"CANCELLED", driver:{ id:"drv-1", contactName:"D" } }`. Assert `gateway.emitDriverStatusUpdated` ×1 with ⊇ `{ driverId:"drv-1", status:"CANCELLED" }` and that the emit mock's own recorded timestamp/counter is > the tx-done mark (wrap the gateway mock with `mockImplementation(() => marks.push(...))`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T5  | `REG-B129 (path): cancel → operator un-cancel → re-dispatch — the released orders are re-collected by the new run's sweep and the un-cancel re-pins nothing` | Table: `A{c1,DELIVERED,run-1,s1}`, `B{c2,CONFIRMED,run-1,s2}`, `C{c3,OUT_FOR_DELIVERY,run-1,s3}`, `D{c2,CONFIRMED,null,null}`, `E{c2,CONFIRMED,run-9,s9}` (all `fulfillPath:"ROUTE"`). `wireTable(table, prisma.order.updateMany)` — use the SHARED mock (no txMock) so the sweep's `forTenant().order.updateMany` and the tx's `order.updateMany` both hit the table. W1 cancel (`routeRunStop.findMany` → `[{id:"s2"},{id:"s3"}]`, `routeRun.update` → CANCELLED row). Assert B,C pointers null, `C.status==="CONFIRMED"`, A on s1 DELIVERED, E on run-9. Snapshot `JSON.stringify(table)` + `updateMany.mock.calls.length`. W2 `routeRun.findUnique` → CANCELLED fixture; `updateRunStatus("run-1", {status:"IN_PROGRESS"}, operatorPayload)`; assert snapshot identical, call count unchanged. W3 `route.findUnique` → `{ id:"r", kind:"SCHEDULED", stops:[{id:"rs2",stopNumber:1,customerId:"c2",customerAddressId:"a2"},{id:"rs3",stopNumber:2,customerId:"c3",customerAddressId:"a3"}] }`, `routeRun.findFirst` → null, `routeRun.create` → `{ id:"run-2", driverId:null, route:{id:"r",name:"R"}, scheduledDate:new Date(), stops:[{id:"n2",customerId:"c2"},{id:"n3",customerId:"c3"}] }`, `routeRunStop.updateMany` → `{count:0}`; `createRun({ routeId:"r", scheduledDate:"2026-09-03" } as any, operatorPayload)`. Assert `B.routeRunStopId==="n2"`, `D.routeRunStopId==="n2"`, `C.routeRunStopId==="n3"`, all `routeRunId:"run-2"`; A still s1; E still s9. (Copy any other `createRun` fixture keys from `routes.service.spec.ts:790-840` `MOCK_ROUTE`/`createdRun` if the call throws on a missing field — extend the fixture, not the assertion.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T7  | `REG-B129: findOneRun does not backfill a cancelled run's stops from the customers' current open orders`                                                     | Fixture per test-plan (mirror `routes.service.spec.ts` findOneRun fixture; stop `s2` with `orders: []`, `customerId:"c2"`); `customerAddress.findMany` → `[]`. CANCELLED → `prisma.order.findMany` NOT called, `stops[0].orders` toEqual `[]`. Control IN_PROGRESS → `order.findMany` called with `where` ⊇ `{ customerId:{ in:["c2"] } }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| T8  | `REG-B211: completing a run via PATCH releases the orders of its SKIPPED stops in the same transaction as the status write`                                  | `routeRun.findUnique` → IN_PROGRESS; shared `prisma.routeRunStop.findMany` → `[{id:"s1",status:"COMPLETED"},{id:"s3",status:"SKIPPED"}]` (gate); tx: `routeRun.update` → COMPLETED row, `routeRunStop.findMany` → `[{id:"s3"}]`. Assert `tx.routeRun.update` `data` ⊇ `{ status:"COMPLETED", completedAt: expect.any(Date) }`; unlink call toEqual with `in:["s3"]`; `tx.order.updateMany.mock.calls.every(c => !JSON.stringify(c[0].where).includes('"s1"'))`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T9  | `REG-B211: RF-016 auto-completion inside completeStop releases the skipped stops' orders in the same transaction`                                            | Fixture per `routes.service.spec.ts:950-985` pattern: `routeRun.findUnique` → IN_PROGRESS; `routeRunStop.findFirst` → `{ id:"s2", routeRunId:"run-1", status:"PENDING", orders:[{ id:"B", status:"CONFIRMED", customerId:"c2" }] }`; `driver.findFirst` → null; tx `routeRunStop.findMany` → `[{id:"s1",status:"COMPLETED"},{id:"s2",status:"COMPLETED"},{id:"s3",status:"SKIPPED"}]`; `prisma.routeRunStop.findUniqueOrThrow` → `{id:"s2",status:"COMPLETED"}`. `completeStop("run-1","s2",{} as any, operatorPayload)`. Assert `tx.routeRun.update` `data` ⊇ `{status:"COMPLETED"}`; `tx.order.updateMany` has a call toEqual the unlink with `in:["s3"]`; ALSO has a call with `data:{status:"DELIVERED"}` (control); result `autoCompleted === true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| T10 | `REG-B211: RF-016 in completeWithPayment releases skipped stops' orders — and the just-completed stop is never released`                                     | Fixture per `routes.service.spec.ts:1478-1510`, NO `payment`; tx `routeRunStop.findMany` → `[{id:"s2",status:"PENDING"},{id:"s3",status:"SKIPPED"}]`. `completeWithPayment("run-1","s2",{ deliveries: [] } as any, operatorPayload)`. Assert the unlink call's `where.routeRunStopId.in` toEqual `["s3"]`; `tx.routeRun.update` COMPLETED called; `autoCompleted === true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| T12 | `REG-B211 (path): complete-with-SKIPPED → reopenStop on the released stop is refused before any write`                                                       | Table `B{c3,CONFIRMED,run-1,s3}` wired to the shared `prisma.order.updateMany`. `runState = {...RUN_FIXTURE, status:"IN_PROGRESS"}`; `prisma.routeRun.update.mockImplementation(async ({data}) => { runState.status = data.status ?? runState.status; if ("completedAt" in data) runState.completedAt = data.completedAt; return { ...runState, driver:null }; })`; `prisma.routeRun.findUnique.mockImplementation(async () => ({ ...runState, stops:[{ id:"s3", status:"SKIPPED", orders: table.filter(o => o.routeRunStopId==="s3").map(o => ({...o, lineItems:[]})), signatureUrl:null, podPhotoUrls:[], ageVerified:false, identityVerified:false, identityType:null, identityVerifiedAt:null, driverNote:null, completedAt:null, safeDropEnabled:false }] }))`; gate `routeRunStop.findMany` → `[{id:"s1",status:"COMPLETED"},{id:"s3",status:"SKIPPED"}]`. W1 PATCH COMPLETED → `runState.status==="COMPLETED"`, `B.routeRunStopId===null`. Record `txCalls = tenantTransaction.mock.calls.length`. W2 `reopenStop("run-1","s3",operatorPayload)` rejects `BadRequestException` with message matching `/released to dispatch/`; `tenantTransaction.mock.calls.length === txCalls`; `prisma.routeRunStop.update`, `prisma.deliveryMutation.deleteMany`, `prisma.auditLog.create`, `prisma.orderItem.updateMany` NOT called; `runState.status` still `"COMPLETED"`. **Variant in the same `it`** (the rejected-predicate check): reassign `stopFixture.orders` to `[{id:"B",status:"CONFIRMED",lineItems:[]}]` — the pre-fix stranded shape, order still attached and not DELIVERED/CANCELLED — `runState.status="COMPLETED"` → `reopenStop` still rejects (`BadRequestException`, before any tx) but with the OTHER message: `errVariant.message` matches `/still attached to it/` and `/stranded-order repair/`, and does NOT match `/released to dispatch/` — the discriminator is the release helper's own predicate (an order whose status is not DELIVERED/CANCELLED), never `stop.orders.length`. **Variant 2** (post-fix pinned shape): `stopFixture.orders` = `[{id:"C",status:"CANCELLED",lineItems:[]},{id:"D",status:"DELIVERED",lineItems:[]}]` → `reopenStop` rejects again with the base `/released to dispatch/` message (not `/stranded-order repair/`), since neither pinned order fails the predicate. W3 control: stop fixture `status:"COMPLETED"`, `orders:[]`, `invoice.findFirst` → null, `transaction.findMany` → `[]` → `reopenStop` resolves and `runState.status==="IN_PROGRESS"`. |
| T13 | `REG-B211: the reopen refusal is decided before ownership and before any transaction — a driver on a released stop sees the same refusal`                    | Same post-complete fixture (run COMPLETED, stop SKIPPED); `driver.findFirst` → `{ id:"drv-1" }`. `reopenStop("run-1","s3",driverPayload)` rejects `BadRequestException` (`expect(err).toBeInstanceOf(BadRequestException)` — NOT Forbidden) with `/released to dispatch/`; `tenantTransaction` NOT called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T14 | `REG-B129: a second cancel of an already-CANCELLED run is idempotent — no throw, same release predicate re-issued, zero rows matched`                        | Table `B{c2,CONFIRMED,null,null}`; wire the table to BOTH `prisma.order.updateMany` and `tx.order.updateMany`; run fixture CANCELLED; tx `routeRunStop.findMany` → `[{id:"s2"}]`. Resolves; unlink call issued with `in:["s2"]`; `await tx.order.updateMany.mock.results[1].value` toEqual `{ count: 0 }`; B unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

| T27 | `REG-B129: a stop completed at the door between the cancel's stop read and its order writes is excluded — that order keeps its run pointers while still-open stops release` | The read→write race the relation filter closes. Mutation M29 (drop the `routeRunStop` relation filter from either order write) turns this red. |
| T28 | `REG-B129: cancelling a run declines every PENDING ChangeRequest on the orders it actually released, silently, and leaves a non-released order's request open` | The CR decline. Mutation M30 (delete the `changeRequest.updateMany` block) turns this red. |

### TP2 — `W/apps/api/src/orders/orders.service.tracking-contract.spec.ts` (new) · T15 · REG-B129 / REG-B146

Module setup copied from `orders.lifecycle-conservation.spec.ts` (the `jest.mock`s FIRST, then the
provider list at :140-240 of `orders.service.spec.ts` — every collaborator `useValue`). Fixture:
`MOCK_ORDER = { id:"ord-1", customerId:"cust-1", status:"CONFIRMED", customer:{ deliveryWindowStart:"09:00", deliveryWindowEnd:"11:00" } }`;
`customerPayload = { sub:"user-cust", role:"CUSTOMER", tenantId:"t1" } as any`;
`prisma.customer.findFirst` → `{ id:"cust-1" }`.

- **T15** `REG-B129 / REG-B146: an order whose stop sits on a CANCELLED run reports tracking: null — the buyer card must never show a driver for a called-off run`:
  `order.findUnique` → `{ ...MOCK_ORDER, routeRunStop:{ stopNumber:2, status:"PENDING", routeRun:{ id:"run-1", status:"CANCELLED", driver:{ id:"d", contactName:"Dee" }, route:{ id:"r", name:"R" }, stops:[{stopNumber:1,status:"PENDING"},{stopNumber:2,status:"PENDING"}] } } }`
  → `await service.getOrderTracking("ord-1", customerPayload)` **toEqual** `{ status:"CONFIRMED", tracking:null }`.
  Control in the same `it`: same fixture with `status:"IN_PROGRESS"` → `result.tracking` ⊇
  `{ driverName:"Dee", runStatus:"IN_PROGRESS", stopsAhead:1, stopStatus:"PENDING" }`.

### TP3 — mobile proofs · T17–T20 (append to `W/apps/mobile/__tests__/order-tracking-logic.test.ts`) · T21–T26 (new `W/apps/mobile/__tests__/skip-stop.test.ts`) · REG-B146 / REG-B34

Load new symbols so the pre-impl failure is an ASSERTION:

```ts
// order-tracking-logic.test.ts — appended describe("trackingHeadline / trackingRefetchInterval (F11)")
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logic: any = require("../lib/order-tracking-logic");
const headline = (t: any) => {
  expect(typeof logic.trackingHeadline).toBe("function");
  return logic.trackingHeadline(t);
};
const interval = (d: any) => {
  expect(typeof logic.trackingRefetchInterval).toBe("function");
  return logic.trackingRefetchInterval(d);
};

// skip-stop.test.ts
import { readFileSync } from "fs";
import { join } from "path";
let mod: any;
try {
  mod = require("../lib/skip-stop");
} catch {
  mod = undefined;
}
const make = (deps: any) => {
  expect(mod?.createSkipStopHandler).toBeDefined();
  return mod.createSkipStopHandler(deps);
};
```

Source-text assertions read:
`readFileSync(join(__dirname, "..", "app", "(customer)", "orders", "[id].tsx"), "utf8")`,
`readFileSync(join(__dirname, "..", "lib", "api", "buyer.ts"), "utf8")`,
`readFileSync(join(__dirname, "..", "app", "(driver)", "route", "stop", "[stopId]", "index.tsx"), "utf8")`,
`readFileSync(join(__dirname, "..", "..", "..", ".claude", "skills", "bug-hunt", "scan-ignore.json"), "utf8")`.

| T#  | Title                                                                                                                                                      | Must assert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T17 | `REG-B146: a skipped own-stop never reads as "You're next on the route"`                                                                                   | `headline({ runStatus:"IN_PROGRESS", stopStatus:"SKIPPED", stopsAhead:0 })` toBe `"Your stop was skipped on this run — the seller will follow up to reschedule."` and `not.toMatch(/next on the route/)`; same with `stopsAhead:3`.                                                                                                                                                                                                                                                                        |
| T18 | `REG-B146: headline precedence — cancelled run, skipped stop, live run copy, finished run → null`                                                          | `it.each`: `[CANCELLED,PENDING,0]` → `/cancelled/`; `[CANCELLED,SKIPPED,0]` → `/cancelled/`; `[COMPLETED,SKIPPED,0]` → the skipped copy; `[IN_PROGRESS,PENDING,0]` → `"You're next on the route"`; `[IN_PROGRESS,PENDING,1]` → `"1 stop ahead of you"`; `[IN_PROGRESS,PENDING,4]` → `"4 stops ahead of you"`; `[SCHEDULED,PENDING,0]` → `null`; `[COMPLETED,COMPLETED,0]` → `null`.                                                                                                                        |
| T19 | `REG-B146 wiring: the buyer order screen renders trackingHeadline, hides the ETA line for a skipped stop, and no longer hardcodes the stops-ahead ternary` | screen src `toMatch(/trackingHeadline\(/)`; `not.toMatch(/You're next on the route/)`; `not.toMatch(/stopsAhead === 0\s*\?/)`; `toMatch(/stopStatus\s*!==\s*"SKIPPED"[\s\S]{0,200}estimatedArrivalWindow                                                                                                                                                                                                                                                                                                   | estimatedArrivalWindow[\s\S]{0,200}stopStatus\s*!==\s*"SKIPPED"/)`. |
| T20 | `REG-B146: the tracking poll keeps refreshing while the run is IN_PROGRESS, not only while the order is OUT_FOR_DELIVERY`                                  | `interval({ status:"CONFIRMED", tracking:{ runStatus:"IN_PROGRESS" } })` → `20000`; `interval({ status:"OUT_FOR_DELIVERY", tracking:null })` → `20000`; `interval({ status:"CONFIRMED", tracking:{ runStatus:"SCHEDULED" } })` → `false`; `interval({ status:"DELIVERED", tracking:{ runStatus:"COMPLETED" } })` → `false`; `interval(undefined)` → `false`. buyer.ts src `toMatch(/trackingRefetchInterval\(/)` and `not.toMatch(/s === "OUT_FOR_DELIVERY" \|\| s === "PARTIALLY_DELIVERED" \? 20_000/)`. |
| T21 | `REG-B34: confirming Skip PATCHes the stop to SKIPPED and only then navigates back`                                                                        | `mutate/navigateBack/toast = jest.fn()`; `h = make({ runId:"run-1", stopId:"stop-1", mutate, navigateBack, toast })`; `h()`; `mutate` ×1, `mutate.mock.calls[0][0]` toEqual `{ runId:"run-1", stopId:"stop-1", status:"SKIPPED" }`; `navigateBack` NOT called; `mutate.mock.calls[0][1].onSuccess()`; `toast` calledWith `"Stop skipped"`; `navigateBack` ×1.                                                                                                                                              |
| T22 | `REG-B34: without a resolved runId nothing is sent and the driver stays on the stop`                                                                       | `runId: undefined` → `mutate` NOT called, `navigateBack` NOT called, `toast` calledWith `expect.stringMatching(/not loaded/i)`.                                                                                                                                                                                                                                                                                                                                                                            |
| T23 | `REG-B34: an offline-queued rejection is reported as queued and the driver goes back; a real error keeps them on the stop`                                 | (a) `onError(Object.assign(new Error("You are offline. Action queued."), { isOfflineQueued: true }))` → toast `/queued/i`, `navigateBack` ×1. (b) fresh handler, `onError({ response:{ data:{ message:"This stop is completed. Reopen it instead — that reverses the delivery correctly." } } })` → toast calledWith EXACTLY that string, `navigateBack` NOT called. (c) fresh handler, `onError(new Error("boom"))` → toast `"boom"`, no navigation.                                                      |
| T24 | `REG-B34: a second tap while the skip is in flight sends nothing — and the guard clears after settle`                                                      | `h(); h();` → `mutate` ×1. `mutate.mock.calls[0][1].onError(new Error("x"))`; `h()` → `mutate` ×2. Fresh handler: `h()`, `onSuccess()`, `h()` → `mutate` ×2.                                                                                                                                                                                                                                                                                                                                               |
| T25 | `REG-B34 wiring: the driver stop screen routes Skip through createSkipStopHandler and useUpdateStopStatus, not a bare router.replace`                      | screen src `toMatch(/useUpdateStopStatus/)`; `toMatch(/createSkipStopHandler\(/)`; `not.toMatch(/confirm\([\s\S]{0,300}\(\)\s*=>\s*router\.replace\(/)`.                                                                                                                                                                                                                                                                                                                                                   |
| T26 | `REG-B34: the confirm-navigate scan suppression for the driver stop screen is gone`                                                                        | `JSON.parse(scanIgnoreSrc)["confirm-navigate"]` is `undefined` OR `.every((e: string) => !/\(driver\)\/route\/stop\/\[stopId\]\/index\.tsx/.test(e))`.                                                                                                                                                                                                                                                                                                                                                     |

### TP4 — pins (GREEN pre-impl, must stay green; NOT in the red gate)

Files: `W/apps/api/src/routes/routes.service.run-terminal-release.pins.spec.ts` (P1–P8, P13, P14),
`W/apps/api/src/orders/orders.service.tracking-contract.pins.spec.ts` (P9, P10),
`W/apps/mobile/__tests__/f11-run-cancel-skip.pins.test.ts` (P11, P12). Same harnesses as TP1/TP2/TP3.
Pin command (expect exit 0 BEFORE and AFTER the implementation):

```
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/api test -- src/routes/routes.service.run-terminal-release.pins.spec.ts src/orders/orders.service.tracking-contract.pins.spec.ts
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/mobile test -- __tests__/f11-run-cancel-skip.pins.test.ts
```

| P#  | Title                                                                                                                                        | Body                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | `pin (B129): a stop completed at the door is marked COMPLETED inside the payment's own transaction — the release predicate can never see it` | completeWithPayment fixture (spec:1478) with `payment:{ amount:50, method:"CASH" }`, `invoicesService.recordDeliveryPaymentInTx` → `{ applied:50, invoiceIds:["inv-1"], paymentIds:["pay-1"] }` → `tx.routeRunStop.update` `data` ⊇ `{ status:"COMPLETED" }` AND `recordDeliveryPaymentInTx.mock.calls[0][0] === tx`.                                                                |
| P2  | `pin (B129): the SCHEDULED dispatch sweep's where still deep-equals its pinned shape after the helper extraction`                            | createRun (kind SCHEDULED, one stop `c1`, run stop `rrs-1`) → `prisma.order.updateMany` calledWith `{ where:{ customerId:"c1", status:{ notIn:["DELIVERED","CANCELLED"] }, routeRunStopId:null, fulfillPath:"ROUTE" }, data:{ routeRunId:"run-1", routeRunStopId:"rrs-1" } }` — copy the fixture from `routes.service.spec.ts:790-835`.                                              |
| P3  | `pin (B72): an operator CAN restart a cancelled run — CANCELLED is not an absorbing state (T9b twin under the new shape)`                    | T9b body (`stop-state-guards.spec.ts:390-402`): fixture without route/stops; `routeRun.update` calledWith `data` ⊇ `{ status:"IN_PROGRESS" }`.                                                                                                                                                                                                                                       |
| P4  | `pin (B211): reopening a COMPLETED stop on a COMPLETED run is still allowed — the refusal is SKIPPED-specific`                               | run COMPLETED, stop COMPLETED `orders:[]`, `invoice.findFirst` → null, `transaction.findMany` → `[]` → resolves `{ success:true, … }`; `routeRun.update` `data` ⊇ `{ status:"IN_PROGRESS", completedAt:null }`.                                                                                                                                                                      |
| P5  | `pin (B129): settleRun still accepts a CANCELLED run`                                                                                        | run CANCELLED (`startedAt: new Date()`), `settleRun("run-1", { countedCash: 0 } as any, operatorPayload)` resolves.                                                                                                                                                                                                                                                                  |
| P6  | `pin (B129): updateStopStatus still refuses a stop change on a CANCELLED run`                                                                | stop PENDING (`routeRunStop.findFirst`), run `{ ...RUN_FIXTURE, status:"CANCELLED" }` → `updateStopStatus("run-1","s1",{ status:"IN_PROGRESS" },operatorPayload)` rejects `ConflictException`; `routeRunStop.update` NOT called (F10 T7 twin — copy its fixture at `stop-state-guards.spec.ts`).                                                                                     |
| P7  | `pin (B129): a DRIVER cannot CANCEL a run — cancel stays an operator action`                                                                 | run IN_PROGRESS, `driver.findFirst` → `{ id:"drv-1" }`, PATCH CANCELLED as driver → `ForbiddenException` `/Drivers can only set/`; `tenantTransaction` NOT called; `routeRun.update` NOT called.                                                                                                                                                                                     |
| P8  | `pin (B211): a COMPLETED transition with a PENDING stop is still refused before any write`                                                   | `routeRunStop.findMany` → `[{ id:"s2", status:"PENDING" }]` → `BadRequestException` `/still pending/`; `tenantTransaction` NOT called; `order.updateMany` NOT called.                                                                                                                                                                                                                |
| P13 | `pin (B129): un-cancelling writes only the run status — no order write, no transaction, no route-kind branching`                             | (test-plan T6, re-homed) `it.each` over run fixtures `{…CANCELLED, route:{kind:"SCHEDULED"}}`, `{…, route:{kind:"ADHOC"}}`, `{…}` (no route key); for `IN_PROGRESS` and `SCHEDULED` targets: resolves; `routeRun.update` `data` ⊇ requested status (and `startedAt: expect.any(Date)` for IN_PROGRESS); `prisma.order.updateMany` NOT called; `prisma.tenantTransaction` NOT called. |
| P14 | `pin (B211): a withheld auto-completion (unsettled cash) releases nothing and leaves the run IN_PROGRESS`                                    | (test-plan T11, re-homed) T9's fixture with tx `invoicePayment.findMany` → `[{ amount: 25, method: "CASH" }]` → `tx.routeRun.update` NOT called; `tx.order.updateMany` ×1 with `data:{ status:"DELIVERED" }` only; `autoCompleted === false`.                                                                                                                                        |
| P9  | `pin (B146): a SKIPPED own-stop on an IN_PROGRESS run keeps the full payload — stopStatus SKIPPED, stopsAhead computed exactly as before`    | own stop `stopNumber:3, status:"SKIPPED"`, `stops:[{1,PENDING},{2,COMPLETED},{3,SKIPPED}]`, run IN_PROGRESS → `tracking` ⊇ `{ stopStatus:"SKIPPED", stopsAhead:1, runStatus:"IN_PROGRESS" }`.                                                                                                                                                                                        |
| P10 | `pin (B129): an order with no stop link still reports tracking: null`                                                                        | `routeRunStop: null` → toEqual `{ status:"CONFIRMED", tracking:null }`.                                                                                                                                                                                                                                                                                                              |
| P11 | `pin (B146): trackingStepIndex is unchanged by the F11 helpers`                                                                              | `trackingStepIndex("OUT_FOR_DELIVERY") === 2`; `trackingStepIndex("CANCELLED") === -1` (import normally — the symbol exists today).                                                                                                                                                                                                                                                  |
| P12 | `pin (B34): the operator route-runs screen still skips through useUpdateStopStatus`                                                          | src of `app/(operator)/route-runs/[id].tsx` `toMatch(/status: "SKIPPED"/)` and `toMatch(/useUpdateStopStatus/)`.                                                                                                                                                                                                                                                                     |

---

## 2. Work packages (disjoint by file; every WP names `satisfies` (R#) and `provenBy` (T#/P#))

### WP1 — routes.service.ts: release helper, sweep extraction, terminal-transition transaction, RF-016 hooks, reopenStop refusal, findOneRun guard (+ two doc-text edits)

**Files**

- `W/apps/api/src/routes/routes.service.ts`
- `W/apps/api/src/routes/dto/update-run-status.dto.ts` (doc comment only)
- `W/apps/api/src/routes/routes.service.stop-state-guards.spec.ts` (T9b's comment at :390-394 only — the `it` body stays byte-identical)

**satisfies** R1 R2 R3 R4 R6 R7 R12 R15 · **provenBy** T1 T2 T3 T4 T5 T7 T8 T9 T10 T12 T13 T14 · pins P1–P8 P13 P14 · **dependsOn** — (none)

Verified anchors at `c60fe214`: createRun sweep :936-967 (`attachedOrderCount` :967); `adhocOrderIds`
:829-830 (`string[] | null`); findOneRun fallback :1252-1255 (`const anyLinked …; if (!anyLinked && normalisedStops.length > 0)`, the run variable is `run`);
updateRunStatus :1368-1467 (final write :1449-1455, emit :1457-1464); completeStop RF-016
:2139-2170 (`tx.routeRun.update` at :2164-2167, `allStops` at :2140); completeWithPayment RF-016
:2398-2425 (`tx.routeRun.update` :2419-2422); reopenStop state checks :2694-2697, driver isolation
:2699-2706. Existing imports already include `OrderStatus`, `RouteRunStatus`, `BadRequestException`.
Helpers in this file type a client parameter as `client?: any` (:1487, :1533) — follow that.

**(a) The release helper** — add directly BELOW `getUnsettledPhysicalMoney` (after :1541), before
`enrichRunsWithCollectedPayments`:

```ts
  /**
   * F11 (B129 / B211): a run going terminal releases the orders of every stop
   * that recorded no work, so createRun's sweep (`routeRunStopId: null`) and the
   * trip builder (`checkEligibility`) can re-collect them. Callers pass the ids
   * of stops whose status !== "COMPLETED" — the ONLY durable "work happened
   * here" marker: completeStop and completeWithPayment both write
   * stop.status = "COMPLETED" inside their own transaction, deliveries[] is
   * optional on both, so a deliveryMutation-existence predicate would release a
   * payment-only completion (the exact hole F05 found in deleteRun). Every
   * at-door payment therefore sits on a COMPLETED stop and is never in scope.
   *
   * Two writes, this order, both on the caller's tx client:
   *   1. OUT_FOR_DELIVERY → CONFIRMED, scoped to the released stops, BEFORE the
   *      unlink (the stop filter is lost once the pointer is null). Defensive:
   *      no run-lifecycle code writes OUT_FOR_DELIVERY, but an office-set one
   *      must be trip-eligible again (TRIP_ELIGIBLE_STATUSES excludes it).
   *   2. Null both pointers for orders whose status ∉ {DELIVERED, CANCELLED}.
   *
   * BOTH writes carry `routeRunStop: { status: { not: "COMPLETED" } }`: each
   * write re-checks the stop's status in the same statement, so a stop
   * completed between the caller's read and this write is excluded. Without it
   * the caller's `routeRunStop.findMany` and these writes are two statements
   * under READ COMMITTED, and a driver's completeWithPayment committing in that
   * window (it takes no run-row lock while other stops are still PENDING, so
   * RF-016 never fires) leaves the stop COMPLETED with its order
   * PARTIALLY_DELIVERED — a status that is NOT in the notIn list, so the unlink
   * would strip the pointers of an order the driver had just delivered and paid
   * for at the door: its cash drops out of getRunCashCollections'
   * `invoice.order.routeRunId` join and the order reappears as trip-eligible.
   * PARTIALLY_DELIVERED is deliberately NOT added to the notIn list — a
   * partially-delivered order on a genuinely non-completed stop must still
   * release. No FOR UPDATE is taken and the write order is unchanged; the
   * relation filter is the whole fix.
   *
   * A third write follows: every PENDING ChangeRequest on an order write 2
   * actually released is DECLINED. ChangeRequests are only created (and only
   * applied) while `order.routeRun.status === IN_PROGRESS`, so a released order
   * is back in the buyer's direct-edit window (`updateOrderItems` has no
   * pending-CR check) while its CR sits PENDING — on re-dispatch the driver
   * could approve it and apply the same items a second time. `updateMany`
   * returns no ids, so write 2's row set is read FIRST (same predicate) and
   * write 2 is then keyed by those ids as well as the predicate, which makes
   * the released set and the declined set provably the same rows. No
   * notification is sent (`notifyRequester` is a follow-up row) — this is a
   * system decline inside someone else's transaction, so the resolver identity
   * fields are left null.
   *
   * An office-recorded CONFIRMED CASH/CHECK InvoicePayment on such an order is
   * RELEASED, not refused (spec R15): getRunCashCollections joins through
   * invoice.order.routeRunId, so its attribution moves off the run by design —
   * the money was never collected at the door (that always COMPLETEs the stop),
   * and refusing would re-create the stranded order.
   *
   * TWO reports attribute through that pointer and BOTH shift by design:
   * getRunCashCollections (a run's expected cash, above) and
   * BookkeepingService.getSalesByDriver, which credits an invoice to the driver
   * of its order's CURRENT run and skips an order with no run — so EVERY
   * invoice on a released order (payment or not, not just the R15 edge) drops
   * out of Sales-by-Driver until a re-dispatch re-pins it, and the credit then
   * lands on the driver who actually delivers. Accepted, not worked around:
   * both reads have always followed the live pointer (a re-dispatch or a driver
   * reassignment already moved them), and a stop that recorded no work is the
   * proof this driver never delivered that order. Stop rows are kept as
   * history. Never route through OrdersService.changeStatus (own txs, gates,
   * notifications) and never wrap in a retry loop (only safe in a FRESH tx).
   */
  private async releaseUndeliveredOrders(
    tx: any,
    stopIds: string[],
  ): Promise<{ released: number }> {
    if (stopIds.length === 0) return { released: 0 };
    // Re-checked by EVERY statement below, never read once into a variable: a
    // stop the caller saw as non-COMPLETED can be COMPLETED by the time each
    // write runs.
    const stopStillOpen = { routeRunStop: { status: { not: "COMPLETED" } } };
    await tx.order.updateMany({
      where: {
        routeRunStopId: { in: stopIds },
        ...stopStillOpen,
        status: OrderStatus.OUT_FOR_DELIVERY,
      },
      data: { status: OrderStatus.CONFIRMED },
    });
    const releaseWhere = {
      routeRunStopId: { in: stopIds },
      ...stopStillOpen,
      status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
    };
    const releasedIds: string[] = (
      await tx.order.findMany({ where: releaseWhere, select: { id: true } })
    ).map((o: { id: string }) => o.id);
    const { count } = await tx.order.updateMany({
      where: { id: { in: releasedIds }, ...releaseWhere },
      data: { routeRunId: null, routeRunStopId: null },
    });
    if (releasedIds.length > 0) {
      await tx.changeRequest.updateMany({
        where: { orderId: { in: releasedIds }, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.DECLINED,
          resolution: "DECLINED",
          resolutionReason: RELEASED_CHANGE_REQUEST_REASON,
          resolvedAt: new Date(),
        },
      });
    }
    return { released: count };
  }
```

**(b) `updateRunStatus` — replace :1445-1455 (from `const updates: any = …` through the `routeRun.update` call) with:**

```ts
const updates: any = { status: dto.status };
if (dto.status === RouteRunStatus.IN_PROGRESS && !run.startedAt) updates.startedAt = new Date();
if (dto.status === RouteRunStatus.COMPLETED) updates.completedAt = new Date();

const include = {
  driver: { select: { id: true, contactName: true, user: { select: { username: true } } } },
};

// F11 (B129 / B211): the two TERMINAL transitions release the orders of
// every stop that recorded no work, in the SAME transaction as the status
// write. Stop ids are read inside the tx (not from the findUnique above) so
// a driver's completeStop that committed in between is seen as COMPLETED
// and drops out; the helper's status filter is the second guard. Gate
// reads above (stops-complete, cash backstop) ran pre-release against the
// FULL order set, which can only make them stricter. SCHEDULED /
// IN_PROGRESS writes — including un-cancel — stay the bare update: un-cancel
// is a status-only restore that re-pins NOTHING (released orders are
// re-collected by a fresh createRun on the same route; see spec R3). No
// run-row FOR UPDATE is taken (recorded as a follow-up; concurrent PATCHes
// are idempotent under the matrix and the release matches 0 rows twice).
const releasesOrders =
  dto.status === RouteRunStatus.CANCELLED || dto.status === RouteRunStatus.COMPLETED;

const updated = releasesOrders
  ? await this.prisma.tenantTransaction(async (tx) => {
      const row = await tx.routeRun.update({ where: { id }, data: updates, include });
      const stops = await tx.routeRunStop.findMany({
        where: { routeRunId: id, status: { not: "COMPLETED" } },
        select: { id: true },
      });
      await this.releaseUndeliveredOrders(
        tx,
        stops.map((s: { id: string }) => s.id),
      );
      return row;
    })
  : await this.prisma.forTenant().routeRun.update({ where: { id }, data: updates, include });
```

The `if (updated.driver) { this.gateway.emitDriverStatusUpdated(...) }` block and `return updated;`
stay exactly as they are, AFTER the assignment (T4 proves the emit follows the commit). If
`tenantTransaction`'s callback typing rejects `include` on the tx client, cast `tx` as `any` inside
the callback — do not change the shape of the write.

**(c) RF-016 in `completeStop` — inside the `else` at :2163-2168, immediately after the existing `tx.routeRun.update` and BEFORE `autoCompleted = true`:**

```ts
// F11 / B211: the run is COMPLETED now — release the orders of the
// stops that recorded no work (the SKIPPED ones; allDone already
// excluded PENDING/IN_PROGRESS). `allStops` was read after THIS
// stop's COMPLETED write, so `id !== stopId` is a second guard for a
// snapshot that still shows it PENDING. A withheld auto-completion
// (the `if` branch above) releases nothing — the run is still open.
await this.releaseUndeliveredOrders(
  tx,
  allStops.filter((s: any) => s.id !== stopId && s.status !== "COMPLETED").map((s: any) => s.id),
);
```

**(d) RF-016 in `completeWithPayment` — identical insertion inside the `else` at :2418-2424, after `tx.routeRun.update`, before `autoCompleted = true`.** One call, nothing else moves (F05 owns the cash gate text; F08 cites :2289-2294 beside it — L-008).

**(e) `reopenStop` — insert immediately after the two state checks (:2694-2697), BEFORE `// Driver isolation`:**

```ts
// F11 / B211 (spec R7): after F11 every COMPLETED transition releases the
// orders of its SKIPPED stops, so "run COMPLETED ∧ stop SKIPPED" IS the
// state "this stop's orders were released" — one named condition (L-030),
// not `stop.orders.length === 0`, which would read the release's EFFECT
// and let a pre-fix stranded stop reopen into a run whose settlement is
// already closed until the D4 repair happens to run. REFUSAL, not
// reversal: the released orders are dispatchable on a new run. Reopening a
// COMPLETED stop on a COMPLETED run is unchanged. Sits with the existing
// state checks — reordering against the ownership block below is a
// B72-class change with its own row.
if (stop.status === "SKIPPED" && run.status === "COMPLETED") {
  throw new BadRequestException(
    "This run is complete and the skipped stop's orders were released to dispatch — dispatch them on a new run instead of reopening this stop.",
  );
}
```

**(f) `findOneRun` — :1255 becomes:**

```ts
    // F11 (spec R4): a cancelled run has released its undelivered orders, so it
    // is exactly the "no stop has linked orders" shape this legacy fallback
    // keys on — without the guard its detail page would display the customers'
    // CURRENT open orders as if they were on the called-off run. (An
    // un-cancelled, fully-released run still reaches the fallback — recorded
    // as a follow-up row; the durable fix is retiring the fallback.)
    if (!anyLinked && normalisedStops.length > 0 && run.status !== RouteRunStatus.CANCELLED) {
```

**(g) Sweep extraction (P2 pure refactor — the lead's R1 mandates it; F11 has no second caller after the R3 ruling, so it may be dropped on the lead's word; if kept it must be byte-equivalent).** Add above `applyStopRegulatedFlags` (:1023):

```ts
  /**
   * F11: createRun's post-lock order sweep, extracted verbatim. Runs OUTSIDE
   * the lock transaction (as before). Returns how many orders attached. The
   * `where` is pinned deep-equal by routes.service.spec.ts ("SCHEDULED dispatch
   * with no orderIds") and the F11 pins spec — a change here is a scope question.
   */
  private async sweepOrdersOntoStops(
    runId: string,
    stops: Array<{ id: string; customerId: string | null }>,
    adhocOrderIds: string[] | null,
  ): Promise<number> {
    const sweepResults = await Promise.all(
      stops
        .filter((s) => s.customerId)
        .map((s) =>
          this.prisma.forTenant().order.updateMany({
            where: {
              customerId: s.customerId!,
              status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
              routeRunStopId: null,
              // (move the existing SHIP/fulfillPath comment block from :946-962 here, verbatim)
              fulfillPath: FulfillPath.ROUTE,
              ...(adhocOrderIds ? { id: { in: adhocOrderIds } } : {}),
            },
            data: { routeRunId: runId, routeRunStopId: s.id },
          }),
        ),
    );
    return sweepResults.reduce((sum, r) => sum + (r?.count ?? 0), 0);
  }
```

and in `createRun` replace :936-967 (`// Assign pending/confirmed orders …` through
`const attachedOrderCount = …`) with:

```ts
// Assign pending/confirmed orders to their respective run stops (outside the lock transaction).
// How many orders the sweep actually attached — for an ad-hoc trip the client asked for a
// specific set, and orders can be cancelled or dispatched elsewhere between building the
// trip and sending it, so the builder surfaces what got dropped instead of claiming the set.
const attachedOrderCount = await this.sweepOrdersOntoStops(run.id, run.stops, adhocOrderIds);
```

**(h) Doc text (R12).** `update-run-status.dto.ts:18-25` — replace the sentence from "and the
dispatch sweep only picks up orders whose `routeRunStopId` is null — so a terminal CANCELLED would
strand the run AND its undelivered orders with no path out." with: "Since F11 a cancel RELEASES
the undelivered orders (their `routeRunStopId` is nulled inside the cancel transaction, so a fresh
dispatch re-collects them); un-cancel is a status-only restore that re-pins nothing. Un-cancel
stays legal as the non-destructive recovery for the RUN itself (its completed stops' POD and
settlement)." `stop-state-guards.spec.ts:390-394` (the comment inside T9b) — rewrite to the same
truth; the `it(...)` title and body do not change (P3 twins it).

**Not in WP1:** `updateStopStatus`, `deleteRun`, `deleteRoute`, `getRunCashCollections`,
`settleRun`, the controller.

### WP2 — orders.service.ts: `getOrderTracking` CANCELLED short-circuit

**Files** `W/apps/api/src/orders/orders.service.ts` · **satisfies** R5 · **provenBy** T15 · pins P9 P10 · **dependsOn** —

`RouteRunStatus` is already imported (:41). Immediately after the existing
`if (!order.routeRunStop) { return { status: order.status, tracking: null }; }` (:5331-5333) add:

```ts
// F11 (B129 / B146 contract, spec R5): a CANCELLED run is not tracking —
// the buyer card must never show a driver, a stop number or "you're next"
// for a called-off run. After F11 the release nulls the pointer at cancel
// time, so this branch serves rows stranded BEFORE the deploy until the D4
// repair frees them, and stays as the written contract. A SKIPPED own-stop
// on a live or completed run keeps the FULL payload (stopStatus: "SKIPPED",
// stopsAhead exactly as computed below) — the client branches on
// stopStatus; the server invents no "skipped shape".
if (order.routeRunStop.routeRun.status === RouteRunStatus.CANCELLED) {
  return { status: order.status, tracking: null };
}
```

Nothing else in this file changes (F13 edits :115/:137 of the same file — disjoint).

### WP3 — mobile buyer tracking: headline helper, refetch helper, screen, hook

**Files**

- `W/apps/mobile/lib/order-tracking-logic.ts`
- `W/apps/mobile/app/(customer)/orders/[id].tsx`
- `W/apps/mobile/lib/api/buyer.ts`

**satisfies** R8 · **provenBy** T17 T18 T19 T20 · pin P11 · **dependsOn** —

**(a) `order-tracking-logic.ts` — append:**

```ts
/** F11 (B146). Buyer-card headline for the live tracking block. Precedence is
 *  deliberate: a cancelled run outranks everything (defensive — the server
 *  returns tracking: null for CANCELLED since F11, but a new app against an
 *  old server or a stale cache must never read "You're next"); a SKIPPED own
 *  stop outranks the live-run copy regardless of runStatus (a pre-fix SKIPPED
 *  stop on a COMPLETED run reads the same); stopsAhead is ignored when skipped
 *  (it structurally excludes the own stop, so it would say 0 → "You're next"). */
export function trackingHeadline(t: {
  runStatus: string;
  stopStatus: string;
  stopsAhead: number;
}): string | null {
  if (t.runStatus === "CANCELLED") {
    return "This delivery run was cancelled — your order will be rescheduled.";
  }
  if (t.stopStatus === "SKIPPED") {
    return "Your stop was skipped on this run — the seller will follow up to reschedule.";
  }
  if (t.runStatus === "IN_PROGRESS") {
    return t.stopsAhead === 0
      ? "You're next on the route"
      : `${t.stopsAhead} stop${t.stopsAhead === 1 ? "" : "s"} ahead of you`;
  }
  return null;
}

/** F11 (B146). Poll cadence for useBuyerOrderTracking. Today's rule (order is
 *  OUT_FOR_DELIVERY / PARTIALLY_DELIVERED) PLUS "the run is IN_PROGRESS" — a
 *  CONFIRMED order on a live run never refreshed, so it could never observe
 *  its own skip. `false` pauses the poll (TanStack v5 function form). */
export function trackingRefetchInterval(
  data: { status: string; tracking: { runStatus: string } | null } | undefined,
): number | false {
  if (!data) return false;
  if (data.status === "OUT_FOR_DELIVERY" || data.status === "PARTIALLY_DELIVERED") return 20_000;
  if (data.tracking?.runStatus === "IN_PROGRESS") return 20_000;
  return false;
}
```

(`order-tracking-logic.ts` already has `import type { BuyerOrder } from "./api/buyer"` — a
type-only import, erased at runtime, so `buyer.ts` importing a runtime function back from it is
NOT a runtime cycle. Keep the parameter type structural as written above; do not import
`BuyerOrderTracking` as a value.)

**(b) `lib/api/buyer.ts` — `useBuyerOrderTracking` (:608-618):** add
`import { trackingRefetchInterval } from "../order-tracking-logic";` to the imports and replace the
`refetchInterval` lambda body with `refetchInterval: (query) => trackingRefetchInterval(query.state.data),`.
Update the doc comment above it: "Paused once DELIVERED/CANCELLED or before dispatch; ALSO polls
while the run is IN_PROGRESS so a CONFIRMED order can observe its own skip (F11)."

**(c) `app/(customer)/orders/[id].tsx`:** add `trackingHeadline` to the
`../../../lib/order-tracking-logic` import (:24-28). Above the component's `return` (beside the
other derived values), `const headline = tracking?.tracking ? trackingHeadline(tracking.tracking) : null;`.
Replace the block at :256-262 (the `runStatus === "IN_PROGRESS" ? … : null` ternary) with
`{headline ? <Text style={styles.trackingLine}>{headline}</Text> : null}` and change the ETA
guard at :263 from `{tracking.tracking.estimatedArrivalWindow.start ? (` to
`{tracking.tracking.stopStatus !== "SKIPPED" && tracking.tracking.estimatedArrivalWindow.start ? (`.
The `Driver:` line and the map placeholder stay. No other change in this file (T19's negative
regexes: no `You're next on the route`, no `stopsAhead === 0 ?` left in the screen).

### WP4 — mobile driver skip: pure handler, screen wiring, scan-ignore un-suppression

**Files**

- `W/apps/mobile/lib/skip-stop.ts` (new)
- `W/apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`
- `W/.claude/skills/bug-hunt/scan-ignore.json` (delete line 74 — the `"confirm-navigate"` key)

**satisfies** R9 R10 · **provenBy** T21 T22 T23 T24 T25 T26 · pin P12 · **dependsOn** —

**(a) `lib/skip-stop.ts`:**

```ts
/**
 * F11 (B34). The driver stop screen's "Skip stop" confirm handler, as a pure
 * function so the pure-logic runner can prove it (L-025). Before F11 the
 * onConfirm was a bare router.replace — no PATCH was ever sent, so the stop
 * stayed PENDING and the buyer card kept saying "You're next".
 *
 * Contract:
 *  - no resolved runId → toast, no mutate, no navigation (the run may still be
 *    loading from useActiveRouteRun);
 *  - a call while a previous mutate is in flight is a no-op (SecondaryBtn has
 *    no `disabled`, so the guard lives here); clears on success AND error;
 *  - navigate ONLY after the server (or the offline queue) accepted the write;
 *  - `isOfflineQueued` (api-client.ts enqueues the PATCH then rejects with
 *    that flag) counts as accepted: a skip is one idempotent PATCH
 *    (updateStopStatus has no same-status guard — a double replay rewrites
 *    SKIPPED), unlike adjust.tsx's half-applied edit which must refuse;
 *  - any other error → server message → error message → fallback; stay put.
 */
export interface SkipStopDeps {
  runId: string | undefined;
  stopId: string;
  mutate: (
    vars: { runId: string; stopId: string; status: "SKIPPED" },
    cbs: { onSuccess: () => void; onError: (e: unknown) => void },
  ) => void;
  navigateBack: () => void;
  toast: (msg: string) => void;
}

export function createSkipStopHandler(deps: SkipStopDeps): () => void {
  let inFlight = false;
  return () => {
    const runId = deps.runId;
    if (!runId) {
      deps.toast("Run not loaded yet — try again");
      return;
    }
    if (inFlight) return;
    inFlight = true;
    deps.mutate(
      { runId, stopId: deps.stopId, status: "SKIPPED" },
      {
        onSuccess: () => {
          inFlight = false;
          deps.toast("Stop skipped");
          deps.navigateBack();
        },
        onError: (e: unknown) => {
          inFlight = false;
          const err = e as any;
          if (err?.isOfflineQueued === true) {
            deps.toast("Offline — skip queued and will sync when you reconnect");
            deps.navigateBack();
            return;
          }
          deps.toast(err?.response?.data?.message ?? err?.message ?? "Could not skip this stop");
        },
      },
    );
  };
}
```

**(b) `app/(driver)/route/stop/[stopId]/index.tsx`:**

- :21-27 import block from `../../../../../lib/api/routes`: add `useUpdateStopStatus,`.
- add `import { createSkipStopHandler } from "../../../../../lib/skip-stop";` beside the other lib imports (:12-13).
- after `const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");` (:79) add:

```tsx
// F11 (B34): Skip actually PATCHes the stop. The handler is memoised so its
// in-flight guard survives a second tap on the button while the first PATCH
// is still outstanding (a fresh closure per press would reset it).
const updateStopStatus = useUpdateStopStatus();
const onSkipConfirm = useMemo(
  () =>
    createSkipStopHandler({
      runId,
      stopId,
      mutate: updateStopStatus.mutate,
      navigateBack: () => router.replace("/(driver)/route" as any),
      toast: showToast,
    }),
  [runId, stopId, updateStopStatus.mutate, router],
);
```

(`useMemo` and `router` are already in scope — :80 uses `useMemo`; `router = useRouter()` exists.)

- :334-339 — the `confirm(...)` keeps its title, body and options; ONLY the third argument changes
  from `() => router.replace("/(driver)/route" as any)` to `onSkipConfirm`. T25's negative regex
  anchors on `confirm(` followed within 300 chars by `() => router.replace(` — the new shape must
  not match it, and the other `router.replace`/`router.push` calls in the file are untouched.
- `useUpdateStopStatus.onSuccess` already invalidates `["route-runs", runId]` and
  `["route-runs","active"]` (routes.ts:384-387) — the driver's list refreshes; no hook change here.

**(c) `.claude/skills/bug-hunt/scan-ignore.json:74`** — delete the whole line
`"confirm-navigate": ["apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx::confirm("],` (keep
the file valid JSON — the preceding array's closing `],` stays). It suppressed exactly this bug. If
the scanner later flags the new shape, the answer is a narrower rule, not a re-suppression.

**Not in WP4:** the operator screen's `handleSkip` (works today, P12 pins it), the controller's
inline body, `skipReason`, any server change.

### WP5 — client cache invalidation after a terminal run write (R14, P2 — droppable on the lead's word)

**Files** `W/apps/mobile/lib/api/routes.ts` · `W/apps/web/lib/api/routes.ts` · **satisfies** R14 · **provenBy** tsc only (`check-types` in both workspaces) · **dependsOn** —

- mobile `useUpdateRunStatus.onSuccess` (:203-206): add `qc.invalidateQueries({ queryKey: ["orders"] });`
  with the comment `// F11: a CANCELLED/COMPLETED write releases undelivered orders — refresh order lists so they reappear as dispatchable.`
- web `useUpdateRouteRunStatus.onSuccess` (:372-375): add `qc.invalidateQueries({ queryKey: ["orders"] });`
  and `qc.invalidateQueries({ queryKey: ["trips-eligible-orders"] });` (grep `apps/web/lib/api` for
  the trip-eligibility hook's exact key first and use THAT string; if none exists, invalidate
  `["orders"]` only). If the web half ships, the commit title names `web` (L-008); if the lead drops
  it, WP7's code-map bullet omits `web.md`.

### WP6 — D4 historical repair: script + runbook section (R13)

**Files** `W/scripts/repair-f11-stranded-orders.mjs` (new) · `W/scripts/REPAIR-RUNBOOK.md` · **satisfies** R13 R15 · **provenBy** dry-run output pasted into this file's §7 (no jest) · **dependsOn** —

House pattern = `W/scripts/repair-f10-reopen-damage.mjs` (copy its flag parsing, read-only session
forcing, `current_database()` guard, JSONL writer, and "ids only — never names" discipline). Verify
every table/column name against `W/apps/api/prisma/schema.prisma` before running.

- **Scope query (derived, never hardcoded ids):**

```sql
SELECT o.id AS order_id, o."tenantId", o.status AS order_status, o."routeRunId", o."routeRunStopId",
       rr.id AS run_id, rr.status AS run_status, s.status AS stop_status,
       EXISTS (
         SELECT 1 FROM "InvoicePayment" ip JOIN "Invoice" i ON i.id = ip."invoiceId"
         WHERE i."orderId" = o.id AND ip.status = 'PAID' AND ip.method IN ('CASH','CHECK')
       ) AS attribution_moved
FROM "Order" o
JOIN "RouteRunStop" s ON s.id = o."routeRunStopId"
JOIN "RouteRun" rr ON rr.id = s."routeRunId"
WHERE o."routeRunStopId" IS NOT NULL
  AND o.status NOT IN ('DELIVERED','CANCELLED')
  AND (rr.status = 'CANCELLED' OR (rr.status = 'COMPLETED' AND s.status = 'SKIPPED'))
  AND ($1::text IS NULL OR o."tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1))
ORDER BY rr.id, o.id;
```

(`--tenant <slug>` narrows; confirm the `Tenant.slug` column name in the schema.)

- **Writes = the helper's two writes verbatim, per run in ONE transaction, in this order:**
  `UPDATE "Order" SET status='CONFIRMED' WHERE id = ANY($ids) AND status='OUT_FOR_DELIVERY';` then
  `UPDATE "Order" SET "routeRunId"=NULL, "routeRunStopId"=NULL WHERE id = ANY($ids) AND status NOT IN ('DELIVERED','CANCELLED');`
  Inside the tx RE-READ the run's status and each order's `(status, routeRunId, routeRunStopId)`;
  any drift from the dry-run snapshot aborts THAT run's tx and moves on.
- **Dry run by default** (`SET default_transaction_read_only = on`); writing needs `--execute
--i-have-a-fresh-backup --confirm <runId>` (repeatable) or `--confirm-all-listed`. Refuses a
  non-`railway`/`routeflow` database without `--force-nonprod`.
- **JSONL** before-state per order to `local-assets/f11-repair-<ts>.jsonl`:
  `{ orderId, runId, stopId, before: { status, routeRunId, routeRunStopId }, attributionMoved }` — ids,
  statuses, dates, counts ONLY.
- `attribution_moved = true` rows are STILL released but printed under a
  "settlement attribution moved — check this run's settlement if one was recorded" heading.
- **`REPAIR-RUNBOOK.md`:** new subsection under §2 HIGH — "F11 — stranded orders on cancelled /
  completed runs (B129 / B211)": what it repairs (pointer release + OUT_FOR_DELIVERY revert), what
  it only reports (attribution-moved), the command sequence
  (`railway run --service postgres node scripts/repair-f11-stranded-orders.mjs [--tenant <slug>] [--verbose]`,
  then `--execute --i-have-a-fresh-backup --confirm <runId>`), and a §4 row:
  `UPDATE "Order" SET "routeRunId"='<before>', "routeRunStopId"='<before>', status='<before>'::"OrderStatus" WHERE id='<id>';`
  from the JSONL before-state.
- **Builder verification:** against the local docker DB (`npm run db:up`), seed on the `test`
  tenant ONLY (`assertTestTenant` — never a live slug) one cancelled run with a PENDING stop + order
  and one COMPLETED run with a SKIPPED stop + order, run the dry run with `--force-nonprod`, paste the
  output into §7 below. Owner runs it on prod post-deploy (runbook §1 backup first).

### WP7 — close-out: lesson, ledger, code map, changelog (runs LAST)

**Files** `W/.claude/lessons/LESSONS.md` · `W/.claude/lessons/_meta.json` · `W/.claude/campaign/status/F11.jsonl` · `W/.claude/campaign/status/F20.jsonl` · `W/.claude/code-map/api.md` · `W/.claude/code-map/mobile.md` · `W/.claude/code-map/web.md` (only if WP5's web half ships) · `W/.claude/code-map/_meta.json` · `W/.claude/code-map/CHANGELOG.md` · **satisfies** R11 (follow-up table below is the record) · **provenBy** `node W/scripts/validate-lessons.mjs` exit 0 + review · **dependsOn** WP1 WP2 WP3 WP4 WP5 WP6

1. **Run `node C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/scripts/validate-lessons.mjs` FIRST** and read the `binding:` line. Master's `_meta.json` carries `maxBytes: 40960` and `maxEntries: 40` with 27 active — entry count binds (13 headroom). If the line says size binds with ~0 entries, STOP and report to the lead; do not compact on your own.
2. **Append L-045** under `## domain` (after the `L-037` entry — newest first within the section, matching the file's order), ≤ ~1 KB, no client identifiers, PR number `#TBD` until known:

```md
### L-045 · 2026-09-02 · domain · #TBD

- **Symptom:** every cancelled run, and every run completed with a skipped stop, left its
  undelivered orders pinned to a stale `routeRunStopId` — invisible to the dispatch sweep and the
  trip builder (both require the pointer null), while the buyer card kept showing a driver and
  "you're next" for a called-off run.
- **Root cause:** the pointer was set by one path (dispatch) and every re-entry reader keyed on it
  being null, but neither terminal transition ever cleared it. The invariant had a writer and its
  readers, and no releaser — same shape as [[L-029]]'s teardown paths.
- **Lesson:** **A pointer that gates re-entry must be released by every transition that makes the
  pointed-at thing terminal, inside that transition's own transaction — and the release predicate
  must be the durable marker the forward path writes (here `stop.status = COMPLETED`), never the
  existence of a side row a payment-only path skips.** When the release makes a new state pair
  reachable (a SKIPPED stop on a COMPLETED run), ship the refusal for it in the same PR ([[L-030]]).
- **Guard:** `REG-B129 (T5 path: cancel → un-cancel → re-dispatch)`, `REG-B211 (T12 path:
complete-with-skipped → reopen refused)`; mutation probes in the F11 PR body.
```

3. **`lessons/_meta.json`:** `activeCount` 27 → **28**; `updatedAt` → now (ISO); **`nextId` stays 51**
   (L-045 is pre-allocated — never take `nextId` for it; take and bump `nextId` ONLY if a second,
   unallocated lesson is written). Re-run `validate-lessons.mjs` → must exit 0 with no
   COUNT/NEXTID/DANGLING finding.
4. **`campaign/status/F11.jsonl`** — final contents (four rows, one per line, `state: proven`,
   `pr: null`, proof = spec paths; the B32 row is REMOVED; `roundSha` on all four = `c60fe214`):

```jsonl
{"id":"B34","batch":"F11","tier":"T1","state":"proven","pr":null,"proof":"REG-B34 jest: apps/mobile/__tests__/skip-stop.test.ts (T21-T26)","evidence":null,"roundSha":"c60fe214","buildPlan":".claude/pipeline/2026-09-02-F11-run-cancel-skip/build-plan.md"}
{"id":"B129","batch":"F11","tier":"T1","state":"proven","pr":null,"proof":"REG-B129 jest: apps/api/src/routes/routes.service.run-terminal-release.spec.ts (T1-T5, T7, T14) + apps/api/src/orders/orders.service.tracking-contract.spec.ts (T15)","evidence":null,"roundSha":"c60fe214","buildPlan":".claude/pipeline/2026-09-02-F11-run-cancel-skip/build-plan.md"}
{"id":"B146","batch":"F11","tier":"T1","state":"proven","pr":null,"proof":"REG-B146 jest: apps/mobile/__tests__/order-tracking-logic.test.ts (T17-T20) + apps/api/src/orders/orders.service.tracking-contract.spec.ts (T15)","evidence":null,"roundSha":"c60fe214","buildPlan":".claude/pipeline/2026-09-02-F11-run-cancel-skip/build-plan.md"}
{"id":"B211","batch":"F11","tier":"T1","state":"proven","pr":null,"proof":"REG-B211 jest: apps/api/src/routes/routes.service.run-terminal-release.spec.ts (T8-T10, T12, T13)","evidence":null,"roundSha":"c60fe214","buildPlan":".claude/pipeline/2026-09-02-F11-run-cancel-skip/build-plan.md"}
```

**Before writing, re-read the shard:** if the reconcile chore has already landed (B211 present,
B32 absent), update the existing rows in place instead of re-adding. Then **append to
`F20.jsonl`** (only if no B32 row exists there yet):
`{"id":"B32","batch":"F20","tier":"T3","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"c60fe214"}`.
A B32 row left in F11's shard with no `REG-B32` proof turns `campaign-check` red — the removal is
load-bearing. 5. **Code map (surgical bullets, not a regen):**

- `api.md` — in the routes-service area (beside the F10 bullet at ~:603): "**F11 — run cancel /
  skip reconciliation (B129/B211/B146/B34, PR #TBD).** `routes.service.ts`:
  `releaseUndeliveredOrders(tx, stopIds)` (private; OUT_FOR_DELIVERY→CONFIRMED revert, then null
  `routeRunId`/`routeRunStopId` for orders on the given stops with status ∉ {DELIVERED,
  CANCELLED}, then DECLINE those orders' PENDING `ChangeRequest`s; empty input writes nothing —
  every order write re-checks `routeRunStop: { status: { not: "COMPLETED" } }` against the
  read→write race with a driver's completeStop/completeWithPayment, and the released set and the
  declined set are proven identical via a pre-unlink `order.findMany` on the same predicate)
  called inside a `tenantTransaction` that now wraps the
  CANCELLED and COMPLETED writes of `updateRunStatus` (in-tx read of non-COMPLETED stop ids) and
  one line after the RF-016 `tx.routeRun.update` in `completeStop`/`completeWithPayment`
  (`id !== stopId && status !== COMPLETED`). SCHEDULED/IN_PROGRESS (incl. un-cancel) stay a bare
  update — un-cancel re-pins nothing; re-dispatch re-collects. `reopenStop` refuses `stop
SKIPPED ∧ run COMPLETED` with one of two 400s, keyed on the release helper's own predicate (an
  order whose status is NOT DELIVERED/CANCELLED — never `stop.orders.length`): a stop still
  holding such an order gets "still attached to it … stranded-order repair" (pre-fix data); a stop
  with none (already released, or holding only pinned DELIVERED/CANCELLED orders) gets "released
  to dispatch". `findOneRun`'s legacy fallback is skipped when `run.status === CANCELLED`, OR when
  `run.status === COMPLETED` and at least one stop is not COMPLETED (the shape a terminal release
  produces) — a COMPLETED run whose stops are ALL COMPLETED still falls through to the fallback
  (genuine legacy/seeded data). `sweepOrdersOntoStops(runId, stops, adhocOrderIds)` = createRun's sweep,
  extracted verbatim. Office-recorded CASH/CHECK on a released order moves off the run's
  expected figure BY DESIGN (spec R15). Specs: `routes.service.run-terminal-release{,.pins}.spec.ts`."
- `api.md` — orders entry: "`getOrderTracking`: CANCELLED run ⇒ `tracking: null` (contract);
  SKIPPED own-stop keeps the full payload, `stopsAhead` unchanged. Spec
  `orders.service.tracking-contract{,.pins}.spec.ts`."
- `api.md` — trips entry (`TripsService.checkEligibility`, ~:613): append "F11: since a
  terminal run releases its undelivered orders, `PREVIOUSLY_DISPATCHED` ('stale link') now marks
  pre-fix rows only, freed by `scripts/repair-f11-stranded-orders.mjs`."
- `mobile.md` — Routes (driver) row: "`lib/skip-stop.ts` `createSkipStopHandler(deps)` (pure;
  runId guard, in-flight guard, mutate-then-navigate, offline-queued ⇒ toast+back) wired into
  `(driver)/route/stop/[stopId]/index.tsx` Skip via `useUpdateStopStatus` (F11/B34);
  `useUpdateRunStatus.onSuccess` also invalidates `["orders"]`." Buyer row: "`lib/order-tracking-logic.ts`
  `trackingHeadline` (cancelled > skipped > live-run copy > null) + `trackingRefetchInterval`
  (20 s while OUT_FOR_DELIVERY/PARTIALLY_DELIVERED OR run IN_PROGRESS) — `(customer)/orders/[id].tsx`
  renders the headline and hides the ETA for a SKIPPED stop; `useBuyerOrderTracking` uses the
  helper (F11/B146). Tests `__tests__/{order-tracking-logic,skip-stop,f11-run-cancel-skip.pins}.test.ts`."
- `web.md` (only if WP5's web half ships): one line on `useUpdateRouteRunStatus` invalidations.
- `code-map/_meta.json`: `mappedSha` = branch HEAD short sha (`git rev-parse --short HEAD` in
  `W/`), `generatedAt` = now, `notes` = **REPLACED** with the F11 note (never appended).
- `code-map/CHANGELOG.md`: ONE new bullet at the top of the list, same text as `notes`.

6. **Verify `scan-ignore.json:74` is gone** (WP4 owns the deletion; if it is still present, delete
   it here — T26 must be green).
7. **Follow-up rows to file (allocate B212+ from the register BEFORE any REG- title is written — F11
   writes none of them):**

| Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `RouteRunStop.skipReason` has **zero writers and zero readers** repo-wide (verified: no match under `apps/*/src                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | app                                                                                   | lib`, `packages/types`) — its schema comment says "F11 wires the driver screen"; F11 deliberately did not (narrow B34) | `apps/api/prisma/schema.prisma:1247` |
| `PATCH /route-runs/:id/stops/:stopId` body is an unvalidated inline type; `updateStopStatus` is non-transactional; no `FAILED_DELIVERY` stop status                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `routes.controller.ts:255`, `routes.service.ts:1716-1763`                             |
| Only `completeWithPayment` writes `OrderItem.deliveredQty`; `completeStop` and office-delivered orders leave 0 (inherited from F08's finding per ruling R2)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `routes.service.ts:2346`                                                              |
| `findOneRun` legacy fallback fires for an un-cancelled, fully-released run (driver would see the customers' current open orders on a run that carries none)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `routes.service.ts:1252-1255` (R4)                                                    |
| `deleteRun` recorded-work gate + B209 `deleteRoute` (F05 handoff item 2); cancel-while-unsettled policy (F05 item 1 — F11 recommends NO new block: `settleRun` accepts CANCELLED)                                                                                                                                                                                                                                                                                                                                                                                                                                    | next routes batch                                                                     |
| The cancel/complete transaction takes no run-row `FOR UPDATE` — and its lock ORDER is inverted against the delivery paths: it locks the run row (`routeRun.update`) then the stops' order rows, while `completeStop`/`completeWithPayment` lock a stop's order rows then the run row, so a simultaneous operator cancel and driver stop completion can deadlock and Postgres aborts one request (before F11 `updateRunStatus` was a single UPDATE and could only wait). Fix = one agreed order (e.g. a run-row `SELECT … FOR UPDATE` at the top of both completion transactions, mirroring `createRun`'s Route lock) | `routes.service.ts` `updateRunStatus` / `completeStop` / `completeWithPayment` (R2)   |
| Un-cancel is now a dead end for the ORDERS: the released orders are not re-pinned, and `createRun` refuses a route whose run is SCHEDULED/IN_PROGRESS, so an un-cancelled run can neither be refilled nor re-dispatched until it is cancelled again (F11 documents "cancel again, then dispatch" as the recovery). Decide whether un-cancel should re-run the dispatch sweep for its own stops or whether cancel should be terminal for the run                                                                                                                                                                      | `routes.service.ts` `updateRunStatus` (R3), `createRun`'s active-run guard            |
| **B212+ (unallocated).** `releaseUndeliveredOrders`'s ChangeRequest decline sends no `notifyRequester` — the requester whose CR was system-declined is never told it happened                                                                                                                                                                                                                                                                                                                                                                                                                                        | `routes.service.ts` `releaseUndeliveredOrders` (the `changeRequest.updateMany` block) |
| **B212+ (unallocated).** `updateOrderItems` still has no pending-CR check — the other half of the double-apply window the CR decline only closes for orders that actually get released                                                                                                                                                                                                                                                                                                                                                                                                                               | `orders.service.ts` `updateOrderItems`                                                |
| **B212+ (unallocated).** `scripts/repair-f11-stranded-orders.mjs` needs the same `routeRunStop` stop-status re-check and PENDING→DECLINED `ChangeRequest` write the forward fix now does, for the historical backlog — **fixed in F11**: the script's header doc comment and dry-run listing already describe/print the three-write shape, but its `--execute` transaction fixed in F11 (three writes + both stop re-checks + `"updatedAt"=NOW()` — verified against a live PostgreSQL 16 cluster, see §7)                                                                                                           | `scripts/repair-f11-stranded-orders.mjs`                                              |
| `PARTIALLY_DELIVERED` orders on a non-COMPLETED stop are released with status kept; whether the trip picker admits them is `TRIP_ELIGIBLE_STATUSES`' call                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `trips.service.ts`                                                                    |
| **B212+ (unallocated).** the repair script's CR double-apply hole (pre-fix backlog) — fixed in F11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `scripts/repair-f11-stranded-orders.mjs`                                              |
| **B212+ (unallocated).** the repair script's scan→write stop-status race — fixed in F11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `scripts/repair-f11-stranded-orders.mjs`                                              |

---

## 3. Commit / PR shape

One squash-merged PR. Title: `fix(routes,orders,mobile[,web]): release undelivered orders when a run goes terminal; buyer skip copy; driver skip PATCH (F11 B129 B211 B146 B34)`.
PR body MUST carry: spec §1 R1's L-037 table verbatim; the R15 attribution decision verbatim; the
mutation-probe table (§6); the WP6 dry-run output; "Manual verification: (none) — F11 has no T3".
No `REG-B32` anywhere.

## 4. Deploy-day notes (for the lead; not the builder's job)

No migration. Merge → deploy (public window, wait `BUILDING`, private) → `npm run post-deploy-check`
→ owner runs WP6's script on prod (backup → dry run → per-run execute) → spot-check one previously
cancelled run's orders are eligible in the trip builder. Code rollback = revert the PR; orders the
new code already released stay released (a correct state). Old-app/new-server skew: buyer card
receives `tracking: null` for CANCELLED and degrades to "Not yet on a delivery route."

**Run WP6's repair as soon after the deploy as the backup allows.** Between the deploy and the
repair, `reopenStop` refuses "run COMPLETED ∧ stop SKIPPED" for rows completed BEFORE the deploy
too — and reopening was those operators' own recovery. `reopenStop` tells them so: a stop that
still holds an order the release WOULD have taken (status ∉ {DELIVERED, CANCELLED} — the helper's
own predicate, and the repair script's scope filter) gets the "still attached … ask an operator to
run the F11 stranded-order repair" message instead of the "released to dispatch" one, so an
operator hitting it on legacy data knows the answer is the repair script, not the trip builder.
It is deliberately NOT `stop.orders.length > 0`: a released stop keeps its DELIVERED/CANCELLED
orders pinned, and the repair skips those, so counting orders would send an operator on a repair
flight that reports nothing.

---

## 5. Verification commands (scoped — never `npm run verify`, never `npm run format`)

Format ONLY changed files:

```
git ls-files -mo --exclude-standard | grep -E '\.(ts|tsx|js|jsx|json|md)$' | grep -v '^\.claude/pipeline/' | xargs -r npx prettier --write
```

Per round (after each WP lands):

```
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/api run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/mobile run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/api test -- src/routes/routes.service.run-terminal-release.spec.ts src/routes/routes.service.run-terminal-release.pins.spec.ts src/orders/orders.service.tracking-contract.spec.ts src/orders/orders.service.tracking-contract.pins.spec.ts src/routes/routes.service.stop-state-guards.spec.ts src/routes/routes.service.spec.ts
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/mobile test -- __tests__/order-tracking-logic.test.ts __tests__/skip-stop.test.ts __tests__/f11-run-cancel-skip.pins.test.ts
```

Final (all WPs landed):

```
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/api run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/mobile run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/web run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/api test
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/apps/mobile test
node C:/ClaudeCode/routeflow/.claude/worktrees/rf-F11/scripts/validate-lessons.mjs
```

(The full api/mobile suites in `final` leave whole `.campaign/runs/{api,mobile}.json` artifacts —
L-034; a scoped run leaves a scoped artifact.)

---

## 6. Mutation probes (post-implementation; apply exactly one, run `npm --prefix … test -- <file> -t '<token>'` DIRECTLY, confirm the named test goes red and nothing else, revert)

| #   | File                                                     | Mutation (behaviour to break)                                                                                       | Must go red                                                                                                                                          |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `apps/api/src/routes/routes.service.ts`                  | Release also runs for COMPLETED stops: change the in-tx stop read to `where: { routeRunId: id }` (money regression) | T1 (where deep-equal), T5 (A loses her pointer), T8 (`"s1"` appears)                                                                                 |
| M2  | `apps/api/src/routes/routes.service.ts`                  | Release skipped on CANCELLED: `releasesOrders = dto.status === RouteRunStatus.COMPLETED` only                       | T1 T2 T3 T5 T14                                                                                                                                      |
| M3  | `apps/api/src/routes/routes.service.ts`                  | Release outside the tx: call `this.releaseUndeliveredOrders(this.prisma.forTenant(), …)` after the tx               | T1 (top-level `order.updateMany` called), T4                                                                                                         |
| M4  | `apps/api/src/routes/routes.service.ts`                  | Swap the helper's two writes (unlink before revert)                                                                 | T2                                                                                                                                                   |
| M5  | `apps/api/src/routes/routes.service.ts`                  | Remove the `stopIds.length === 0` short-circuit                                                                     | T3                                                                                                                                                   |
| M6  | `apps/api/src/routes/routes.service.ts`                  | Emit inside the tx callback                                                                                         | T4                                                                                                                                                   |
| M7  | `apps/api/src/routes/routes.service.ts`                  | Un-cancel re-sweeps (add a `sweepOrdersOntoStops` call in the SCHEDULED/IN_PROGRESS branch)                         | T5 (W2 snapshot), P13                                                                                                                                |
| M8  | `apps/api/src/routes/routes.service.ts`                  | Drop the `run.status !== CANCELLED` guard in `findOneRun`                                                           | T7                                                                                                                                                   |
| M9  | `apps/api/src/routes/routes.service.ts`                  | Omit the RF-016 release in `completeStop` / in `completeWithPayment` (two probes)                                   | T9 / T10                                                                                                                                             |
| M10 | `apps/api/src/routes/routes.service.ts`                  | Drop `s.id !== stopId` from the RF-016 filter                                                                       | T10                                                                                                                                                  |
| M11 | `apps/api/src/routes/routes.service.ts`                  | Call the RF-016 release whenever `allDone` (outside the `else`)                                                     | P14 (pin)                                                                                                                                            |
| M12 | `apps/api/src/routes/routes.service.ts`                  | reopenStop accepts a released SKIPPED stop: delete the R7 refusal                                                   | T12 (W2 resolves), T13                                                                                                                               |
| M13 | `apps/api/src/routes/routes.service.ts`                  | Predicate `stop.orders.length === 0` instead of `stop.status === "SKIPPED" && run.status === "COMPLETED"`           | T12 (unwired-table variant)                                                                                                                          |
| M14 | `apps/api/src/routes/routes.service.ts`                  | Move the R7 refusal inside the `tenantTransaction`                                                                  | T13, T12 (`tenantTransaction` count)                                                                                                                 |
| M15 | `apps/api/src/routes/routes.service.ts`                  | Sweep helper drops the `routeRunStopId: null` predicate                                                             | P2, existing `routes.service.spec.ts` "SCHEDULED dispatch … deep-equals"                                                                             |
| M16 | `apps/api/src/routes/routes.service.ts`                  | Skip the release when `run.status === dto.status` (same-status cancel)                                              | T14                                                                                                                                                  |
| M17 | `apps/api/src/orders/orders.service.ts`                  | getOrderTracking returns the payload for a CANCELLED run (delete the short-circuit)                                 | T15                                                                                                                                                  |
| M18 | `apps/api/src/orders/orders.service.ts`                  | Over-reach: return `tracking: null` for SKIPPED stops too                                                           | P9 (pin)                                                                                                                                             |
| M19 | `apps/api/src/trips/trips.service.ts`                    | (Fence — F11 does not edit this file.) Remove `routeRunStopId: null` from `getEligibleOrders`'s where               | existing `trips.service.spec.ts` eligibility tests — confirm one goes red; if none does, record the gap as a follow-up row, do NOT add a test to F11 |
| M20 | `apps/mobile/lib/order-tracking-logic.ts`                | Put the IN_PROGRESS branch before the SKIPPED branch                                                                | T17, T18                                                                                                                                             |
| M21 | `apps/mobile/lib/order-tracking-logic.ts`                | Drop the `runStatus === "IN_PROGRESS"` arm of `trackingRefetchInterval`                                             | T20                                                                                                                                                  |
| M22 | `apps/mobile/app/(customer)/orders/[id].tsx`             | Restore the inline ternary / drop the ETA guard                                                                     | T19                                                                                                                                                  |
| M23 | `apps/mobile/lib/skip-stop.ts`                           | Navigate before mutate                                                                                              | T21                                                                                                                                                  |
| M24 | `apps/mobile/lib/skip-stop.ts`                           | Send with `runId: undefined`                                                                                        | T22                                                                                                                                                  |
| M25 | `apps/mobile/lib/skip-stop.ts`                           | Treat every error as offline-queued                                                                                 | T23 (b)                                                                                                                                              |
| M26 | `apps/mobile/lib/skip-stop.ts`                           | Drop the in-flight flag / never clear it                                                                            | T24                                                                                                                                                  |
| M27 | `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx` | Restore `() => router.replace(...)` as the onConfirm                                                                | T25                                                                                                                                                  |
| M28 | `.claude/skills/bug-hunt/scan-ignore.json`               | Re-add the `confirm-navigate` suppression                                                                           | T26                                                                                                                                                  |
| M29 | `apps/api/src/routes/routes.service.ts`                  | drop the `routeRunStop` relation filter from either order write                                                     | T27                                                                                                                                                  |
| M30 | `apps/api/src/routes/routes.service.ts`                  | delete the `changeRequest.updateMany` block                                                                         | T28                                                                                                                                                  |

A mutation that turns nothing red is a missing assertion — fix the test, not the table.

---

## 7. WP6 dry-run evidence

> Supersedes the earlier transcripts: the script gained a third write (CR decline) and an
> in-transaction stop re-check, so the previous output no longer matches.

**Environment.** Docker unavailable in the sandbox. A throwaway **PostgreSQL 16.14** cluster
(`initdb` → port 55432, db `routeflow_dev`, hence `--force-nonprod`) provisioned in the session
scratchpad; the repo's 25 migrations applied with `prisma migrate deploy`. Fixtures on the
approved `test` tenant only, dummy ids.

**Fixtures.** Run `run-cancelled` [CANCELLED] — `stop-a1` [PENDING] → `ord-a1`
[OUT_FOR_DELIVERY], `stop-a2` [COMPLETED] → `ord-a2` [CONFIRMED], `stop-a3` [PENDING] → `ord-a3`
[DELIVERED]. Run `run-completed` [COMPLETED] — `stop-b1` [SKIPPED] → `ord-b1` [CONFIRMED] (PAID
CASH InvoicePayment), `stop-b2` [COMPLETED] → `ord-b2` [DELIVERED]. Change requests: `cr-a1`
PENDING on `ord-a1` (releasable), `cr-a1-approved` APPROVED on `ord-a1`, `cr-a2` PENDING on
`ord-a2` (COMPLETED-stop, report-only), `cr-b1` PENDING on `ord-b1` (releasable), `cr-a3` PENDING
on `ord-a3` (DELIVERED, out of scope).

**Dry run** — `node scripts/repair-f11-stranded-orders.mjs --force-nonprod --verbose` (exit 0): 2
run(s) / 2 order(s) listed (`ord-a1` on `run-cancelled`, `ord-b1` on `run-completed` ⚠ attribution
moved), with the three SQL statements previewed per run; "Pinned to a COMPLETED stop — NOT
repaired: 1" (`ord-a2`); "skipped (stop completed since scan): 0"; "change requests declined: 2
(projected; the dry run counts, it never writes)". The read-only session held: every Order,
ChangeRequest and RouteRunStop row byte-identical to the seed afterwards.

**Execute** — `--execute --i-have-a-fresh-backup --confirm-all-listed --force-nonprod` (exit 0):
`run-cancelled`: released 1 (`ord-a1`), declined 1 CR; `run-completed`: released 1 (`ord-b1`),
declined 1 CR; skipped 0; change requests declined: 2. Log written to
`local-assets/f11-repair-<ts>.jsonl`.

**Post-execute SQL verification.** `ord-a1`, `ord-b1`: status CONFIRMED, both pointers NULL
(released). `ord-a2` (COMPLETED stop), `ord-a3` (DELIVERED), `ord-b2` (DELIVERED): untouched.
ChangeRequest: `cr-a1`, `cr-b1` → DECLINED / resolution DECLINED / resolutionReason "Run cancelled
— order released to dispatch" / resolvedAt set / resolver identity NULL; `cr-a1-approved` still
APPROVED; `cr-a2` and `cr-a3` still PENDING. All five RouteRunStop rows byte-identical to the
seed. JSONL lines carry `before.pendingChangeRequestIds` = ["cr-a1"] and ["cr-b1"] respectively;
`attributionMoved` false / true.

**Idempotency.** Immediate dry-run re-run: 0 run(s) / 0 order(s); `ord-a2` still listed under the
report-only heading; change requests declined: 0.

**Rollback (runbook §4, both legs, verbatim).** The two Order UPDATEs (UPDATE 1 each) and `UPDATE
"ChangeRequest" SET status='PENDING', resolution=NULL, "resolutionReason"=NULL, "resolvedAt"=NULL
WHERE id IN ('cr-a1','cr-b1')` (UPDATE 2) restore the seed byte-for-byte — the release AND the
decline are reversible from the log alone.

**The new `skipped (stop completed since scan)` branch, driven deterministically.** An `AFTER
UPDATE ON "Order" WHEN (NEW.id='ord-a1')` trigger set `stop-b1` → COMPLETED — a driver completing
that stop between the scan and `run-completed`'s own transaction. Result: `run-cancelled` released
1 / declined 1; `run-completed`: "nothing left to release — every scoped stop completed since the
scan (1 order(s) skipped)"; skipped 1 (`ord-b1` / `stop-b1`); change requests declined: 1.
Verified: `ord-b1` kept BOTH pointers and `cr-b1` is still PENDING — the pre-fix script would have
unlinked an order that had just been worked at the door. Trigger dropped; fixtures reseeded.

> `"updatedAt" = NOW()` was added to write 3 after these transcripts were captured (lead ruling);
> the sibling agent's re-run confirms it.

## Manual verification

(none) — F11 has no T3 rows.

## Lead rulings applied at launch (2026-09-02)

- **WP1 item (g) is DROPPED.** Do not extract `sweepOrdersOntoStops`; createRun's sweep at routes.service.ts:936-967 stays byte-for-byte untouched. With R3 (un-cancel is status-only) the helper has no second caller. Pin P2 still pins the sweep's `where`.
- **WP5 ships both halves** (mobile and web cache invalidation). The commit title names `web` (L-008).

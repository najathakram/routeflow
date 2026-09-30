# bug-test-plan.md — F27 (Estimates)

**Status: IMPLEMENTED — proven, pending merge** (PR #711). Coverage walked test-by-test against
the shipped tree 2026-09-14: T1-T3, T5-T13, T15, T16 (as an `it.each` with a stricter
`2026-02-31` rollover case beyond what this plan specified), T19-T32, T34 all present and
matching. **T4** ("accept() refuses a voided estimate") does not exist and should not — see the
Status note in `cause-ruling.md` / `LESSONS.md` L-119; T26 (harness-driven DECLINED→ACCEPTED) is
the authoritative pin instead. **T14** lives in `[id]/page.existing-behavior.test.tsx` (content
matches verbatim). **T18**'s DB spec self-labels "T17" (pre-dates a renumbering pass) and uses an
approved `qa-b79-*` tenant slug rather than the literal `"test"`. **T23** is titled `REG-B394`
(the minted registry id) rather than the literal `REG-B15-NAV` placeholder, with a comment
recording the alias. **T33** is proven on the estimates **list** page
(`page.regression.test.tsx`) only — the `[id]` detail page carries the identical `?? createdAt`
fallback in source but has no dedicated pin; residual gap, not a functional defect.

Tree of record: `rf-F27` @ `2d353752`. Source: S4 Test-Plan Ruling for F27. All placeholders (`<VOID-STATUS>`, `<ACCEPT-MSG>`, `<VOID-MSG>`, `ROW`) are literals the test author copies verbatim from HEAD — never invented. Every REG below must be **red on HEAD** and **green after the fix**; a REG green on HEAD is a harness defect, not a pass.

Shared API harness (all `estimates.service.spec.ts` entries): `Test.createTestingModule` with `PrismaService` mocked at the module boundary — `estimate.updateMany`, `estimate.findFirst`, `estimate.update`, `estimate.create`, `invoice.create`, `tenantTransaction(cb)` resolving `cb(tx)` where `tx` carries the same mock fns. Model: existing B8 tests (`:46-78`, `:126`).

---

## B70 — `apps/api/src/estimates/estimates.service.ts` / `estimates.service.spec.ts`

### T1 — REG-B70 — `send()` refuses a CONVERTED estimate

- Setup: `updateMany` → `{count:0}`; `findFirst` → `{id:"est-1", status:"CONVERTED"}`.
- Given an estimate `est-1` whose stored status is `CONVERTED`
- When `send("est-1")` is called
- Then it rejects with `BadRequestException` message `"Converted or voided estimates cannot be re-sent"`, and `updateMany` was called once with `expect.objectContaining({ where: expect.objectContaining({ id:"est-1", status:{ notIn:["CONVERTED","<VOID-STATUS>"] } }), data:{ status:"SENT" } })`
- Harness note: on HEAD, `updateMany` is called 0 times and the bare `estimate.update` mock resolves `{id:"est-1", status:"SENT"}` — this test must fail against that behavior.

### T2 — REG-B70 — `send()` refuses a voided estimate

- Setup: `updateMany` → `{count:0}`; `findFirst` → `{id:"est-1", status:"<VOID-STATUS>"}`.
- Given an estimate whose stored status is `<VOID-STATUS>`
- When `send("est-1")` is called
- Then same rejection and same `updateMany` where-shape as T1
- Harness note: HEAD resolves `{id:"est-1", status:"SENT"}` — must be red there.

### T3 — REG-B70 — `decline()` refuses a CONVERTED estimate

- Setup: `updateMany` → `{count:0}`; `findFirst` → `{id:"est-1", status:"CONVERTED"}`; `estimate.update` → `{id:"est-1", status:"DECLINED"}`.
- Given an estimate whose stored status is `CONVERTED`
- When `decline("est-1")` is called
- Then it rejects `BadRequestException` `"Converted or voided estimates cannot be declined"`; `updateMany` called once with `data:{ status:"DECLINED" }` and the same `notIn` set as T1
- Harness note: HEAD resolves `{status:"DECLINED"}` with `updateMany` count 0 — must be red there.

### T4 — REG-B70 — `accept()` refuses a voided estimate

- Setup: `updateMany` → `{count:0}`; `findFirst` → `{id:"est-1", status:"<VOID-STATUS>"}`.
- Given an estimate whose stored status is `<VOID-STATUS>`
- When `accept("est-1")` is called
- Then `updateMany.mock.calls[0][0].where.status` equals `{ notIn:["CONVERTED","<VOID-STATUS>"] }` (not today's `{ not:"CONVERTED" }`) and the call rejects `BadRequestException` `<ACCEPT-MSG>`
- Harness note: on HEAD the where is `{ not:"CONVERTED" }` (no `notIn`, `<VOID-STATUS>` absent) — the where-shape is the discriminator, not the rejection alone (HEAD also rejects, via count-0).

### T5 — REG-B70 — `voidEstimate()` claims atomically

- Setup: `updateMany` → `{count:0}`; `findFirst` → `{id:"est-1", status:"CONVERTED"}`; `estimate.update` → `{id:"est-1", status:"<VOID-STATUS>"}`.
- Given an estimate whose stored status is `CONVERTED`
- When `voidEstimate("est-1")` is called
- Then it rejects `BadRequestException` `<VOID-MSG>`; `estimate.update` was called 0 times; `updateMany` was called once with `data:{ status:"<VOID-STATUS>" }`
- Harness note: HEAD does `findFirst` then a bare `estimate.update({where:{id}})` and resolves — `estimate.update` count 1, `updateMany` count 0 on HEAD; must be red there.

### T6 — REG-B70 — laundered estimate cannot mint a second invoice (chain A: convert → send → accept → convert)

- Setup: stateful in-memory estimate mock — one `row = {id:"est-1", tenantId:"t-1", status:"ACCEPTED", items:[…1 line…], customerId:"c-1"}`; `updateMany` applies `where.status` predicate against `row.status`, returns `{count:0|1}`; `estimate.update` writes `data.status` unconditionally; `findFirst` returns `row`; `invoice.create` → `{id:"inv-N"}` incrementing; `tenantTransaction` passes the same mocks as `tx`.
- Given an ACCEPTED estimate that has already been converted once
- When the chain `convert → send → accept → convert` is run end-to-end
- Then `invoice.create` is called exactly **1** time and the chain rejects at the `send` step with `"Converted or voided estimates cannot be re-sent"`
- Harness note: on HEAD the full chain resolves end-to-end and `invoice.create` count is **2** — must be red there.

### T7 — REG-B70 — laundered estimate cannot mint a second invoice (chain B: convert → void → send → accept → convert)

- Setup: same stateful mock as T6, seeding `row.status = "<VOID-STATUS>"` for the send-leg assertion so the REG is independent of HEAD's void-on-CONVERTED behavior.
- Given a CONVERTED estimate is voided, then re-driven through send/accept/convert
- When the chain `convert → void → send → accept → convert` is run
- Then the chain rejects at the `send` step and `invoice.create` count is **1**
- Harness note: HEAD's void-on-CONVERTED leg outcome is recorded separately by the test author (see Escalated item 2 below) — it is not this test's assertion target. This REG's target is the `send` leg from a _successful_ void starting row, where HEAD would otherwise resolve `send`→`accept`→second `convert` giving `invoice.create` count 2.

### T8 — REG-B70 — missing id is 404 not 400 — `send`

- Setup: `updateMany` → `{count:0}`; `findFirst` → `null`; `estimate.update` → rejects `PrismaClientKnownRequestError` code `P2025`.
- Given no estimate exists with the given id
- When `send("nope")` is called
- Then it rejects `NotFoundException` `"Estimate not found"`
- Harness note: HEAD instead lets `estimate.update`'s mocked `P2025` rejection propagate (`rejects.toThrow` matches the Prisma error, not `NotFoundException`) — must be red there.

### T9 — REG-B70 — missing id is 404 not 400 — `decline`

- Setup: same as T8.
- Given / When / Then: same as T8 but calling `decline("nope")`.
- Harness note: same as T8.

### T10 — REG-B70 — missing id is 404 not 400 — `accept`

- Setup: `updateMany` → `{count:0}`; `findFirst` → `null`.
- Given no estimate exists with the given id
- When `accept("nope")` is called
- Then it rejects `NotFoundException`
- Harness note: HEAD's count-0 path yields `BadRequestException` `<ACCEPT-MSG>` instead — must be red there.

### T11 — REG-B70 — missing id is 404 not 400 — `voidEstimate`

- Setup: `updateMany` → `{count:0}`; `findFirst` → `null`.
- Given no estimate exists with the given id
- When `voidEstimate("nope")` is called
- Then it rejects `NotFoundException`; `estimate.update` count is 0
- Harness note: **conditional on HEAD** — the test author records what `voidEstimate()` actually throws today when `findFirst` → `null`. If HEAD already throws `NotFoundException` here, this row is a **PIN**, not a REG, and must be relabeled in the spec name before writing. See Escalated item 2.

---

## B17 — `estimates.service.spec.ts` + `[id]/page.test.tsx`

### T12 — REG-B17 — `convertToInvoice` links the estimate to the minted invoice

- Setup: `tx.estimate.updateMany` mocked twice via `mockResolvedValueOnce` — first call (ACCEPTED claim) → `{count:1}`, second call (link) → `{count:1}`; `tx.estimate.findFirst` → ACCEPTED row with items; `tx.invoice.create` → `{id:"inv-1"}`.
- Given an ACCEPTED estimate being converted
- When `convertToInvoice(...)` runs
- Then `tx.estimate.updateMany` is called exactly once with `data.invoiceId === "inv-1"` and `where.status === "CONVERTED"`, and `tx.invoice.create.mock.invocationCallOrder[0] < linkCall.invocationCallOrder[0]`
- Harness note: on HEAD there is no link write at all — `tx.estimate.updateMany` is never called with `data.invoiceId === "inv-1"` (count 0) — must be red there.

### T13 — REG-B17 — link count mismatch rolls back

- Setup: same as T12 but the second `updateMany` (the link write) → `{count:0}`; `tenantTransaction` mock rethrows.
- Given the post-create link write affects 0 rows
- When `convertToInvoice(...)` runs
- Then it rejects `ConflictException` `"Estimate link failed"`
- Harness note: HEAD has no link write, so this scenario resolves `{id:"inv-1"}` today — must be red there.

### T14 — REG-B17 — send toast does not claim delivery (web)

- Setup: mock `useEstimate` → `{estimateNumber:"EST-0001", status:"DRAFT", …}`; mock `useSendEstimate` mutate → invokes `onSuccess`; render toast container (L-076); click button `/mark as sent|^send$/i`.
- Given a DRAFT estimate on its detail page
- When the user marks it as sent and the mutation succeeds
- Then the toast title reads `"Estimate marked as sent"` and description reads `"EST-0001 is marked Sent. No email was sent."`
- Harness note: HEAD's description reads `"EST-0001 has been sent to the customer."` — must be red there.

---

## B79 — `estimates.service.spec.ts`, `estimates.issue-date.db.spec.ts` (new, DB lane), `estimates/page.test.tsx` (new), formatter spec

### T15 — REG-B79 — `create()` persists `issueDate`

- Setup: dto `{ customerId:"c-1", items:[…], issueDate:"2026-03-01" }`; `estimate.create` → `{id:"est-1"}`; any number-sequence mock HEAD `create()` needs.
- Given a create dto with `issueDate: "2026-03-01"`
- When `create(dto)` runs
- Then `estimate.create.mock.calls[0][0].data.issueDate.toISOString() === "2026-03-01T00:00:00.000Z"`
- Harness note: HEAD writes `data.issueDate === undefined` — must be red there.

### T16 — REG-B79 — `create()` rejects malformed `issueDate` — `"not-a-date"`

- Setup: same dto shape with `issueDate: "not-a-date"`.
- Given a create dto with a malformed `issueDate`
- When `create(dto)` runs
- Then it rejects `BadRequestException` `"issueDate must be YYYY-MM-DD"` and `estimate.create` is called 0 times
- Harness note: HEAD resolves and calls `estimate.create` once — must be red there.

### T17 — REG-B79 — `create()` rejects malformed `issueDate` — `"2026-03-01T10:00:00-05:00"`

- Setup: same dto shape with that value.
- Given / When / Then: same as T16 with this value.
- Harness note: same as T16.

### T18 — REG-B79 — read path returns the persisted `issueDate` (DB lane, `local:test:db`)

- Setup: real `PrismaService` against the compose DB; `assertTestTenant("test")` before any write; create a customer + estimate with `issueDate:"2026-03-01"`; `afterAll` deletes the created rows by id.
- Given an estimate created with `issueDate: "2026-03-01"` on the `test` tenant
- When `findOne(id)` and the list method are called
- Then both return `issueDate === new Date("2026-03-01T00:00:00.000Z")` (`.toISOString() === "2026-03-01T00:00:00.000Z"`)
- Harness note: HEAD returns `null` for both (never written) — must be red there. This is the only test that also catches a `select`/`include` that silently drops the column.

### T19 — REG-B79 — web submit carries `issueDate`

- Setup: mock `useCreateEstimate` → `{mutate, isPending:false}`; mock customers/products list hooks with one row each; fill issue-date input `2026-03-01`, add a line, submit.
- Given the create-estimate form filled with an issue date of `2026-03-01`
- When the form is submitted
- Then `mutate.mock.calls[0][0].issueDate === "2026-03-01"`
- Harness note: HEAD's `mutate` call arg has no `issueDate` key at all (`toHaveProperty("issueDate")` is false) — must be red there.

---

## B15 / B15-NAV — new `[id]/page.test.tsx`

### T20 — REG-B15 — convert control absent on DRAFT

- Setup: mock `useEstimate` → `{status:"DRAFT"}`; mock `next/navigation` `useRouter` → `{push:jest.fn()}`, `useParams` → `{id:"est-1"}`.
- Given the estimate detail page for a DRAFT estimate
- When the page renders
- Then `queryAllByRole("button",{name:/convert to invoice/i})` returns `[]`
- Harness note: HEAD renders `getAllByRole(...).length === 2` — must be red there.

### T21 — REG-B15 — convert control absent on SENT

- Setup: same, `status:"SENT"`.
- Given / When / Then: same as T20 for a SENT estimate.
- Harness note: same as T20 (HEAD length 2).

### T22 — REG-B15 — convert failure toast surfaces the server reason

- Setup: `status:"ACCEPTED"`; mock `useConvertEstimateToInvoice` mutate → invokes `onError({ response:{ data:{ message:"Only ACCEPTED estimates can be converted" } } })`; click the header Convert control.
- Given an ACCEPTED estimate whose convert call fails with a server-supplied message
- When the user clicks Convert and the mutation errors
- Then the toast description reads `"Only ACCEPTED estimates can be converted"`
- Harness note: HEAD's toast description is the generic `"Please try again."` — must be red there.

### T23 — REG-B15-NAV — successful convert navigates to the returned invoice

- Setup: `status:"ACCEPTED"`; mutate → invokes `onSuccess({ id:"inv-1" })`.
- Given an ACCEPTED estimate whose convert call succeeds
- When the mutation resolves
- Then `router.push` is called with `"/invoices/inv-1"`
- Harness note: HEAD calls `router.push` with `"/invoices/undefined"` (navigates on `.invoiceId`, server returns `.id`) — must be red there. **Contract gate**: if the compose-lane convert lands on `/invoices/<id>` before this edit lands via an interceptor, this REG is rewritten to that contract before merge (recorded in the S4/implementer commit body).

---

## Pin tests (no REG token — must be green on HEAD and green after)

### T24 — PIN-B70 — `send()` response shape unchanged

- Setup: `updateMany` → `{count:1}`; post-claim read (`findFirst`/`findUnique`, whichever `send()`'s post-claim step uses, with the same `include`/`select` HEAD's `send()` `update` call carries) → `ROW`, where `ROW` is the exact object HEAD's `estimate.update` mock returns in the existing spec (record its key set verbatim; no `items`/`customer` unless present today).
- Given a legitimate claim succeeds
- Then `await send("est-1")` `toEqual(ROW)`

### T25 — PIN-B70 — where-clause key-set parity

- Setup: `updateMany` → `{count:1}`; post-claim reads → a row; call `accept`, `send`, `decline`, `voidEstimate` against the same id/mocks.
- Then `Object.keys(updateMany.mock.calls[i][0].where).sort()` is identical across all four calls.

### T26 — PIN-B70 — `accept()` still allows DECLINED→ACCEPTED

- Setup: `updateMany` → `{count:1}`; post-claim read → `{id:"est-1", status:"ACCEPTED"}`.
- Given a DECLINED estimate
- Then `accept("est-1")` resolves, and `updateMany`'s where has `notIn` **not** containing `"DECLINED"`.

### T27 — PIN-B70 — existing B8 tests (`:46-78`) stay green

- Setup: extend existing mocks so `findFirst` returns the wrong-status row (e.g. `{status:"DRAFT"}`), so the count-0 path still yields 400 rather than 404.
- Then all existing B8 assertions still pass unchanged.

### T28 — PIN-B70 — exact terminal-status set

- Then `TERMINAL_ESTIMATE_STATUSES` `toEqual(["CONVERTED","<VOID-STATUS>"])` (export the const, or assert via a named export — a set that silently grows or shrinks is red).

### T29 — PIN-B17 — convert still claims via `updateMany` status ACCEPTED and returns the invoice

- Setup: same mocks as T12.
- Then the first `tx.estimate.updateMany` call's `where` contains `status:"ACCEPTED"`, and the result `toMatchObject({id:"inv-1"})`.

### T30 — PIN-B79 — UTC-fixed display (formatter spec)

- Setup: `beforeAll(() => { process.env.TZ = "America/New_York"; })`, `afterAll` restores TZ (Node 20 honours runtime TZ changes).
- Then `formatDateOnly("2026-03-01T00:00:00.000Z")` matches `/Mar 1, 2026/` — day **1**, never `28`.

### T31 — PIN-B79 — `create()` without `issueDate` leaves it unset

- Setup: dto without `issueDate`.
- Then `data.issueDate === undefined` (never `Date.now()`).

### T32 — PIN-B79 — `expiresAt` still parsed as before

- Setup: dto `expiresAt:"2026-04-01"`.
- Then `data.expiresAt.toISOString() === "2026-04-01T00:00:00.000Z"` — **if HEAD's parse at `:150-154` yields a different exact string, pin that exact string instead** (see Escalated item 4).

### T33 — PIN-B79 — readers fall back to `createdAt` when `issueDate` is null (`[id]/page.test.tsx`)

- Setup: mock `useEstimate` → `{issueDate:null, createdAt:"2026-02-10T00:00:00.000Z"}`.
- Then the page renders `/Feb 10, 2026/`.

### T34 — PIN-B15 — ACCEPTED renders exactly 2 convert controls

- Setup: `status:"ACCEPTED"`.
- Then `getAllByRole("button",{name:/convert to invoice/i})` has length exactly **2** (`toHaveLength(2)`, never `>= 1` — that would hide a deleted sidebar control).

---

## Escalated to Fable (undecided)

These items are genuinely undetermined without repo access and cannot be written as concrete assertions from the ruling alone; the ruling itself defers them to the implementer/test author reading HEAD, but the _outcome_ of that reading changes which tests exist or how they're classified:

1. **`customers.service.ts:1774` — does it write `status`?** (Ruling §2 B70 step 7 / Critique #15.) If yes, this is a fifth mutator of the terminal-status column requiring either routing through `claimTransition` or its own registry row and a corresponding REG-B70 "refuse CONVERTED" test. If no, no test is needed. Cannot be resolved without reading the file.
2. **`voidEstimate()`'s HEAD behavior on a CONVERTED row, and on `findFirst → null`.** This determines: (a) whether the chain-B void leg (T7's setup context) is itself a REG or a PIN, and (b) whether T11 (missing-id void) is a REG or must be relabeled as a PIN. The ruling explicitly instructs the test author to record HEAD's actual outcome before writing these tests.
3. **Literal values that must be copied from HEAD, not invented:** `<VOID-STATUS>` (the enum member `voidEstimate()` writes, `:249-255`), `<ACCEPT-MSG>` (accept()'s existing refusal message), `<VOID-MSG>` (voidEstimate()'s existing refusal message), `accept()`'s where-clause key set (id-only vs id+tenantId — drives the exact `objectContaining` shapes in T1-T5 and the parity check in T25), and `ROW` (the exact key set of `send()`'s existing `estimate.update` mock, for T24). None of these can be guessed; the test author fills them in from `2d353752` before the spec is written.
4. **HEAD's exact `expiresAt` parse output for `"2026-04-01"`** (used in T32) — pin whatever string HEAD's parser at `:150-154` actually produces if it differs from `"2026-04-01T00:00:00.000Z"`.

---

## Diff brief

Filled in: expanded every REG/PIN row of the S4 ruling's four tables (B70, B17, B79, B15/B15-NAV) into 23 numbered REG tests (T1–T23) and 11 numbered PIN tests (T24–T34), each with an id, REG token (where applicable), one-line setup drawn directly from the ruling's "Harness note" column, a Given/When/Then restating the ruling's TODAY/AFTER pair, and the harness note preserved verbatim where it specifies mock wiring. Conditional/ambiguous rows in the source ruling (T7's void-leg framing, T11's REG-vs-PIN status) were transcribed with their conditionality intact rather than resolved either way.

Escalated (not decided here, not guessed): the four items above — the `customers.service.ts:1774` status-write question, `voidEstimate()`'s HEAD behavior on CONVERTED/null (which reclassifies two tests), the five literal placeholders the ruling requires be copied from HEAD source, and HEAD's exact `expiresAt` parse string. These require reading `2d353752`, which this transcription pass does not have access to; the ruling itself already routes them to the test author/implementer as pre-write steps, so they are surfaced here rather than guessed.

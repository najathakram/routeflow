# Cause Ruling — F27 (Estimates) — AMENDED (S3, final)

Ruled from the S1 brief + S2 refutations + the S3 critique only (no repo access). Tree of record: `rf-F27` @ `2d353752`. Scope: bug-pipeline, carve-out/money-sensitive. **No schema change and no migration in this batch** — `Estimate.issueDate` and `Estimate.invoiceId` (+FK/unique) are already migrated by `20260908000000_campaign_schema_foundation`.

**Coordinates.** Every `:NNN` below is an anchor into HEAD `2d353752`, not an address. The batch edits `estimates.service.ts` three times and `[id]/page.tsx` twice, and B17's new toast template rewraps under `printWidth 100`, so from the second commit on the implementer locates hunks by the quoted code text, never by line number.

**Implementer prerequisites (gates, in order):** `npx prisma generate` in the worktree (S2: generated client absent) → `npm run verify` → compose boot gate `local:up` → `local:seed` → `local:validate` → `local:test:db` (the new B79 DB-lane spec) → **`local:e2e`** (UI changes: two Convert buttons removed, Send relabelled, toast rewritten — see §4 e2e radius) → push.

---

## 0. Critique dispositions

| # | Disposition | Where |
|---|---|---|
| 1 | **Accepted** for VOID: the set is `CONVERTED` + the status `voidEstimate()` writes; `voidEstimate()` sweep is mandatory; REG `void → send`. **Disagreed** for EXPIRED (if it exists): an expired estimate is legitimately re-sendable/acceptable late, and it cannot mint a second invoice unless it is already CONVERTED, which the set refuses. Excluding it is a product decision, not this bug. | §2 B70 |
| 2 | **Accepted.** The where-clause is `accept()`'s where-clause verbatim + the status predicate; REG asserts `objectContaining`; a key-set-parity PIN proves send/decline/void carry every key accept carries. | §2 B70, §3 |
| 3 | **Accepted.** Claim logic moves into one helper that returns nothing; each mutator keeps its own post-claim read reproducing today's return shape; `PIN-B70 send() response shape unchanged`. | §2 B70, §3 |
| 4 | **Accepted**, and applied to `accept()` too (same helper): `count === 0` → existence read → 404 if missing, 400 if wrong status. Declared contract change; existing B8 pins get their mocks extended, not deleted. | §2 B70, §3 |
| 5 | **Accepted.** The sidebar reads `canConvert` today (that is why S2 put `:458-470` in the radius of `:214`); stated explicitly, with a verification step. | §2 B15 |
| 6 | **Accepted.** Step 3 dropped; the header Convert control is hoisted out of the status blocks into a single `{canConvert && …}`. | §2 B15 |
| 7 | **Accepted.** The `/invoices/undefined` finding rides F27 under a newly minted registry id, with a REG on the navigation target and a local-lane confirmation step. | §2 B15-NAV |
| 8 | **Accepted** for (a): the link write is an `updateMany` with the same where-shape as the claim at `:284-287`, count-checked. **Disagreed** that P2002 is reachable: `inv.id` is minted inside the same transaction, so no other row can reference it, and a retry after commit dies at the `status: "ACCEPTED"` claim before any invoice exists. Stated, and the count check catches the impossible case anyway. | §2 B17 |
| 9 | **Accepted.** `issueDate?: string \| null`. | §2 B79 |
| 10 | **Accepted.** `select` audit + a DB-lane round-trip REG (`*.db.spec.ts`, `local:test:db`). | §2 B79, §3 |
| 11 | **Accepted.** Readers use a UTC-fixed date-only formatter; read-side PIN runs under `process.env.TZ = "America/New_York"` (Node ≥ 13 honours runtime TZ changes; CI is Node 20). | §2 B79, §3 |
| 12 | **Accepted** for `issueDate` (format + NaN check → 400, REG). **Disagreed** on sweeping `expiresAt` in F27: the web's current `expiresAt` payload format is not on record, and a format check could 400 the live form. Filed as residual (§8). | §2 B79, §8 |
| 13 | **Accepted.** The `dto as any` cast is removed unconditionally; the client `CreateEstimateDto` is widened to what the form already sends; the probe becomes concrete. | §2 B79, §7 |
| 14 | **Accepted.** e2e grep in the radius, `local:e2e` in the gates. | §4 |
| 15 | **Accepted** as a required S4 finding: the implementer states whether `customers.service.ts:1774` writes `status`; if it does, it takes the helper or is filed. | §2 B70 |
| 16 | **Accepted.** Step 4 now changes semantics (VOID refused by `accept()`) with a REG; `voidEstimate()` refactor is mandatory with its own REG (it is a TOCTOU). | §2 B70, §3 |
| 17 | **Accepted**, all three. | §3 |
| 18 | **Accepted**, all six greps rewritten. | §5 |
| 19 | **Accepted.** Anchor rule above. | preamble |
| 20 | **Accepted.** Three archivals; L-067 untouched; the addendum becomes L-119. | §8 |

---

## 1. Cause verdicts

| Bug | S2 verdict | Ruling |
|---|---|---|
| B15 | CONFIRMED (same-commit mismatch from `41ab2803`; radius `canConvert :214` + sidebar `:458-470`) | **ACCEPTED.** Fix designed. **Adjacent B15-NAV** (`onSuccess` navigates on `invoiceId`, server returns `{id}`) rides F27 under a new registry id (§2). |
| B16 | REFUTED — stale, removed in `60d10e66` (#621, L-072), guarded by `enum-parity.spec.ts:222-237` | **ACCEPTED as REFUTED. Close B16 as stale. No fix.** Residual (unvalidated `@Query("status")` → `where.status`) UNDETERMINED → §8. |
| B17 | CONFIRMED effect, cause reframed: (1) `send()` status-only is house-correct; the lie is the toast/label; (2) `convertToInvoice` never writes `invoiceId` | **ACCEPTED with the reframe.** Fix designed for toast/label + the `invoiceId` link. Real delivery is a feature → §8. |
| B70 | CONFIRMED — `send()` :232 / `decline()` :247 bare `estimate.update`; launder → `accept()` → second invoice | **ACCEPTED, widened.** The same launder exists via `voidEstimate()`'s status (`void → send → accept → convert`), and `voidEstimate()` itself is read-then-check (TOCTOU). Both are fixed here. |
| B79 | CONFIRMED — web dto drops `issueDate`; `create()` never writes it; shared type lacks it | **ACCEPTED.** Create path + shared type + read path + validation. PATCH is a feature → §8. |

---

## 2. Fix design

### B70 — `apps/api/src/estimates/estimates.service.ts` (money guard; lands first)

1. **One named set, top of file** (L-081):
   ```ts
   const TERMINAL_ESTIMATE_STATUSES = ["CONVERTED", "<VOID-STATUS>"] as const satisfies readonly EstimateStatus[];
   ```
   `<VOID-STATUS>` is the literal `voidEstimate()` writes today at `:249-255` — the enum member name is not on record; the implementer copies it, never invents one. EXPIRED (if present) is deliberately **not** in the set (§0 #1).

2. **One private helper, one place:**
   ```ts
   private async claimTransition(id: string, to: EstimateStatus, refusal: string): Promise<void>
   ```
   - `updateMany({ where: { <accept()'s where-clause keys verbatim — id plus tenant key if accept() carries one>, status: { notIn: [...TERMINAL_ESTIMATE_STATUSES] } }, data: { status: to } })`.
   - `count === 1` → return.
   - `count === 0` → `findFirst({ where: { <same keys, no status predicate> } })`; `null` → `throw new NotFoundException("Estimate not found")`; otherwise `throw new BadRequestException(refusal)`.
   - The helper **returns nothing**; it never reads includes.
   - The S4 commit body states `accept()`'s actual where-clause keys (the tenant-scoping question is answered in writing, not assumed). If `this.prisma` is the tenant-scoped extension, that is the answer.

3. **`send()` `:231-233`** → `await this.claimTransition(id, "SENT", "Converted or voided estimates cannot be re-sent")`, then a post-claim read that reproduces today's return shape exactly: the same `include`/`select` today's `estimate.update` in `send()` carries (a bare `findFirst` if it carries none). No new fields.

4. **`decline()` `:246-248`** → same, refusal `"Converted or voided estimates cannot be declined"`, same post-claim-read rule.

5. **`accept()` `:236-244`** → replace its literal `{ not: "CONVERTED" }` claim with `claimTransition(id, "ACCEPTED", <its existing message>)`; keep its existing post-claim read verbatim. **Declared semantic changes:** (a) a voided estimate can no longer be accepted (today it can); (b) a missing id → 404 (today 400 with the wrong-status message). DECLINED→ACCEPTED stays allowed.

6. **`voidEstimate()` `:249-255`** (mandatory, it is a TOCTOU) → `claimTransition(id, "<VOID-STATUS>", <its existing message>)`; keep its post-claim read/return as today. Declared change: voiding an already-voided estimate now 400s instead of re-writing.

7. **Out-of-file writer `customers.service.ts:1774`** (merge path): S4 states in the commit body whether that `estimate.update` writes `status`. If it does not (expected: it reassigns `customerId`), no change. If it does, it is a fifth mutator: route it through the helper or file it as its own registry row before F27 closes — "must not be affected" is not an answer.

**Invariant:** the first legitimate DRAFT→SENT→ACCEPTED→CONVERTED path is behaviourally unchanged; `convertToInvoice()`'s `status: "ACCEPTED"` claim is untouched by B70.

### B17 — two edits, no schema change

**(a) `estimates.service.ts` `convertToInvoice()`** — inside the existing `tenantTransaction` (`:280`), after `const inv = await tx.invoice.create(...)` (`:307-334`) and before `return inv;` (`:335`):
```ts
const linked = await tx.estimate.updateMany({
  where: { <same keys as the claim at :284-287>, status: "CONVERTED" },
  data: { invoiceId: inv.id },
});
if (linked.count !== 1) throw new ConflictException("Estimate link failed"); // rolls the tx back
```
Same client shape as the claim two hunks above (no bare `update` on a unique key). P2002 on `invoiceId @unique` is unreachable: `inv.id` is minted in this transaction, so no other row can already hold it, and a retry after a visible commit dies at the `status: "ACCEPTED"` claim before `invoice.create` runs. The count check exists so the impossible case rolls back rather than half-commits. Return shape (`inv`) unchanged.

**(b) `apps/web/app/(dashboard)/estimates/[id]/page.tsx`** — `handleSend` `onSuccess` `:121-122`: title `"Estimate marked as sent"`, description `` `${estimate.estimateNumber} is marked Sent. No email was sent.` ``; Send button label (`:244`) → `"Mark as sent"`. Mobile: reviewer checks the operator estimate screen for the same delivery claim and mirrors the wording if present (web is golden).

**Invariant:** the `status: "ACCEPTED"` claim remains the sole duplicate-conversion guard; `invoiceId` is traceability only (FK `onDelete: SetNull`).

### B79 — create path, read path, validation, shared type

1. **`packages/types/api/misc.ts` `Estimate` (`:59-74`):** `issueDate?: string | null;` — **optional**, so no fixture/e2e/mobile literal breaks. **`apps/web/lib/api/estimates.ts` `CreateEstimateDto`:** add `issueDate?: string;` (`"YYYY-MM-DD"`) **and** every other field the create form at `page.tsx:343-356` already sends and the type lacks — the `dto as any` cast at `:358` is **removed unconditionally**. If a field cannot be typed by adding it to the DTO (a genuine shape mismatch), the implementer stops and reports; the cast is never silently kept.

2. **`apps/web/app/(dashboard)/estimates/page.tsx`** dto literal `:343-356`: add `issueDate` (the `"YYYY-MM-DD"` string in state `:149`). Readers `page.tsx:921`, `[id]/page.tsx:358,501`: `est.issueDate ?? est.createdAt` without the `(as any)` cast, **formatted with a UTC-fixed date-only formatter** — the one the invoice detail page uses for `Invoice.issueDate` if one exists in `apps/web/lib`; otherwise `Intl.DateTimeFormat(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" })` added to `apps/web/lib` (one helper, not inline). Keep the `createdAt` fallback.

3. **`estimates.service.ts` `create()` `:141-158`:**
   ```ts
   let issueDate: Date | undefined;
   if (dto.issueDate != null) {
     if (typeof dto.issueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dto.issueDate))
       throw new BadRequestException("issueDate must be YYYY-MM-DD");
     issueDate = new Date(dto.issueDate);               // UTC midnight (L-047)
     if (Number.isNaN(issueDate.getTime()))
       throw new BadRequestException("issueDate must be YYYY-MM-DD");
   }
   ```
   and `issueDate` in the data literal. No second alias. Absent → stays NULL.

4. **Read-path audit:** if `findAll`/`findOne`/list in `estimates.service.ts` use explicit `select` blocks, add `issueDate` to each. Proven by the DB-lane REG below, not by inspection.

5. Controller stays `@Body() dto: any`. **No `CreateEstimateDto` class in F27** (`forbidNonWhitelisted: true`, `main.ts:145-149`, would 400 every existing field).

**Invariant:** `expiresAt` behaviour unchanged; `convertToInvoice` still mints `Invoice.issueDate` = conversion date — a backdated estimate does **not** backdate its invoice (deliberate).

### B15 — `apps/web/app/(dashboard)/estimates/[id]/page.tsx`

1. `:214` → `const canConvert = status === "ACCEPTED";` — the single render predicate. **Statement of fact from S2:** the sidebar control at `:458-470` already renders from `canConvert` (that is why S2 put it in `:214`'s radius, and why today's DRAFT count is 2). Step 4 verifies.
2. Delete the Convert `<Button>` from the DRAFT block (`:249-257`) and the SENT block (`:288-296`). Keep Send / Accept / Decline.
3. **Hoist** the Convert button out of the ACCEPTED block (`:300-309`) to a sibling of the status blocks: `{canConvert && <Button …>Convert to invoice</Button>}`. If the ACCEPTED block is then empty, delete it. The header control is now rendered from `canConvert`, not from block nesting.
4. Verify `:458-470` reads `canConvert`; if it reads anything else, gate it on `canConvert`. Zero other predicate literals for Convert remain.
5. `handleConvert` `onError` (`:184-190`): `(err) =>` description = server message (`err?.response?.data?.message`, joined if array; use the existing web API-error helper if one exists in `apps/web/lib`, else inline), fallback `"Please try again."` only when absent.

### B15-NAV — new registry id (minted by `bugs.mjs file` on the master-merged tree; do not guess the number), linked to B15

`estimates.service.spec.ts:126` pins that `convertToInvoice` returns the raw Invoice keyed `id`; the controller returns the service result; no `APP_INTERCEPTOR` remap is on record. Therefore:
- `apps/web/lib/api/estimates.ts:105`: the `useConvertEstimateToInvoice` result type becomes `{ id: string }` (or the shared `Invoice` type).
- `[id]/page.tsx:176,182` `onSuccess`: navigate on `.id`.
- **Local-lane confirmation (gate):** convert an ACCEPTED estimate in the compose stack and record the landing URL in the commit body. If it lands on `/invoices/<id>` *before* this edit, an interceptor remaps the response — the implementer stops, reports the interceptor's location, and the REG is rewritten to that contract before merge. Either way the batch does not close with the finding unresolved, because after B15 this is the only Convert path left.

### Package sequencing

Branch `fix/F27`, commits: **B70 → B17 → B79 → B15 (+B15-NAV in the same commit)** → B16 registry close-out. Hunks in `estimates.service.ts` are non-overlapping (B70: `send/decline/accept/void` + helper + constant; B17: tail of `convertToInvoice`; B79: `create()`). In `[id]/page.tsx`, B17 (toast/label) lands before B15 (controls/`onError`/`onSuccess`); anchor by text.

---

## 3. Regression tests (REG must fail on today's exact wrong value; PIN must be green today and after)

**B70 — `apps/api/src/estimates/estimates.service.spec.ts`**
- `REG-B70 send() refuses a CONVERTED estimate`: `updateMany` → `{count:0}`, `findFirst` → `{id:"est-1", status:"CONVERTED"}`. Today `send("est-1")` **resolves** `{id:"est-1", status:"SENT"}` via `estimate.update` and `updateMany` is called 0 times; expected `rejects.toThrow(BadRequestException)` `"Converted or voided estimates cannot be re-sent"` and `updateMany` called with `expect.objectContaining({ where: expect.objectContaining({ id:"est-1", status:{ notIn:["CONVERTED","<VOID-STATUS>"] } }), data:{ status:"SENT" } })`.
- `REG-B70 send() refuses a voided estimate`: same, `findFirst` → `status:"<VOID-STATUS>"`; today resolves; expected the same rejection.
- `REG-B70 decline() refuses a CONVERTED estimate`: same shape; today resolves `{status:"DECLINED"}`; expected `"Converted or voided estimates cannot be declined"`.
- `REG-B70 accept() refuses a voided estimate`: `updateMany` → `{count:0}`, `findFirst` → voided row. Today with the `{ not:"CONVERTED" }` claim the mocked `updateMany` is called **without** a `notIn` containing `<VOID-STATUS>`; expected the where carries the full set and the call rejects with accept()'s existing message.
- `REG-B70 voidEstimate() claims atomically`: `updateMany` → `{count:0}`, `findFirst` → `{status:"CONVERTED"}`. Today `voidEstimate` calls `findFirst` then `estimate.update({where:{id}})` and resolves; expected rejection with its existing message and **`estimate.update` called 0 times**.
- `REG-B70 laundered estimate cannot mint a second invoice` (stateful in-memory estimate mock, the money assertion): `convert → send → accept → convert` and `convert → void → send → accept → convert`: today `invoice.create` count **2** on the first chain; expected **1**, chain rejected at `send` (and at `void` on the second chain, since void refuses CONVERTED today too — that leg is a PIN).
- `REG-B70 missing id is 404 not 400`: `updateMany` → `{count:0}`, `findFirst` → `null`. Today `send("nope")` throws P2025 from `estimate.update`; expected `rejects.toThrow(NotFoundException)`. Same test for `decline`, `accept`, `voidEstimate`.
- `PIN-B70 send() response shape unchanged`: `updateMany` → `{count:1}`, post-claim read → `ROW` (the bare row today's `estimate.update` mock returns in the existing spec style); `await send("est-1")` `toEqual(ROW)` — with the exact key set today's `send()` returns (recorded from the existing `estimate.update` mock in the spec; no `items`/`customer` keys appear unless they do today).
- `PIN-B70 where-clause key-set parity`: call `accept`, `send`, `decline`, `voidEstimate` against the same mocks; `Object.keys(updateMany.mock.calls[n][0].where).sort()` identical across all four.
- `PIN-B70 accept() still allows DECLINED→ACCEPTED`; existing B8 tests (`:46-78`) stay green with their mocks extended to resolve `findFirst` → the wrong-status row (so the count-0 path still yields 400).
- `PIN-B70 exact set`: `TERMINAL_ESTIMATE_STATUSES` `toEqual(["CONVERTED","<VOID-STATUS>"])` (a set that silently grows or shrinks is red).

**B17 — `estimates.service.spec.ts` + web test below**
- `REG-B17 convertToInvoice links the estimate to the minted invoice`: `tx.invoice.create` → `{id:"inv-1"}`, `tx.estimate.updateMany` → `{count:1}`. Today `tx.estimate.updateMany` is called with `data.invoiceId === "inv-1"` **0** times; expected exactly **1**, with `where.status === "CONVERTED"`, and ordering asserted: `invoiceCreate.mock.invocationCallOrder[0] < linkCall.invocationCallOrder[0]`.
- `REG-B17 link count mismatch rolls back`: link `updateMany` → `{count:0}` → `rejects.toThrow(ConflictException)` (today: resolves `inv`).
- `REG-B17 send toast does not claim delivery` (web): today description `"EST-0001 has been sent to the customer."`; expected `"EST-0001 is marked Sent. No email was sent."`.
- `PIN-B17 convert still claims via updateMany status ACCEPTED and returns the invoice`: `updateMany` called with `where` containing `status:"ACCEPTED"`; result `toMatchObject({id:"inv-1"})`.

**B79 — `estimates.service.spec.ts`, new `apps/api/src/estimates/estimates.issue-date.db.spec.ts` (DB lane), new `apps/web/app/(dashboard)/estimates/page.test.tsx`, formatter test**
- `REG-B79 create() persists issueDate`: `dto.issueDate="2026-03-01"` → today `estimate.create` `data.issueDate === undefined`; expected `data.issueDate.toISOString() === "2026-03-01T00:00:00.000Z"`.
- `REG-B79 create() rejects a malformed issueDate`: `"not-a-date"` and `"2026-03-01T10:00:00-05:00"` → today `estimate.create` is called with `issueDate` absent (resolves); expected `rejects.toThrow(BadRequestException)` and `estimate.create` called 0 times.
- `REG-B79 read path returns the persisted issueDate` (**DB lane**, `local:test:db`, `test` tenant only via `assertTestTenant`): create with `issueDate:"2026-03-01"`, then `findOne` (and the list method) → today `issueDate` is `null` (never written); expected `"2026-03-01T00:00:00.000Z"`. This is the only test that also catches a `select` that drops the column.
- `REG-B79 web submit carries issueDate`: fill issue date `2026-03-01`, submit → today the mocked `useCreateEstimate` mutate arg has no `issueDate`; expected `"2026-03-01"`.
- `PIN-B79 UTC-fixed display`: in the formatter's own test, `beforeAll(() => { process.env.TZ = "America/New_York"; })` / `afterAll` restore; `formatDateOnly("2026-03-01T00:00:00.000Z")` renders day **1** March (a local formatter renders 28 Feb — the test is discriminating only under a west-of-UTC TZ, which the override guarantees on Node 20).
- `PIN-B79 create() without issueDate leaves it unset` (`undefined`, never `now()`).
- `PIN-B79 expiresAt still parsed as before`: `dto.expiresAt="2026-04-01"` → `data.expiresAt.toISOString() === "2026-04-01T00:00:00.000Z"` (exact value; if today's parse at `:150-154` yields something else, pin *that* value — the point is a concrete string).
- `PIN-B79 readers fall back to createdAt when issueDate is null`.

**B15 / B15-NAV — new `apps/web/app/(dashboard)/estimates/[id]/page.test.tsx`** (mock `apps/web/lib/api/estimates` hooks and `next/navigation`; toasts via the toast container, L-076)
- `REG-B15 convert control is absent on DRAFT and SENT`: today `getAllByRole("button",{name:/convert to invoice/i}).length === 2` for DRAFT and for SENT; expected `queryAllByRole(...)` `[]` for both.
- `REG-B15 convert failure toast surfaces the server reason`: rejection `{response:{data:{message:"Only ACCEPTED estimates can be converted"}}}` → today `"Please try again."`; expected the server message.
- `REG-B15-NAV successful convert navigates to the returned invoice`: mutation resolves `{id:"inv-1"}` → today `router.push` called with `"/invoices/undefined"`; expected `"/invoices/inv-1"`.
- `PIN-B15 ACCEPTED renders exactly 2 convert controls` (header + sidebar; `>= 1` would hide a deleted sidebar).

---

## 4. Blast radius (`radiusFiles`, deduped)

Edited:
- `apps/api/src/estimates/estimates.service.ts`, `estimates.service.spec.ts`, new `estimates.issue-date.db.spec.ts`
- `apps/web/app/(dashboard)/estimates/[id]/page.tsx`, `page.tsx`, new `[id]/page.test.tsx`, new `page.test.tsx`
- `apps/web/lib/api/estimates.ts`; `apps/web/lib/<date-only formatter>` (new or existing) + its test
- `packages/types/api/misc.ts`
- `apps/web/e2e/*.spec.ts` that match `rg -n 'sent to the customer|Convert to invoice|convert-to-invoice' apps/web/e2e` — any spec converting from DRAFT/SENT is rewritten to Accept-then-Convert (it was exercising the broken path); any asserting the old toast is updated
- conditional: `apps/api/src/customers/customers.service.ts:1774` (only if it writes `status`, §2 B70.7)
- bookkeeping: `.claude/code-map/{api,web,packages}.md`, `_meta.json`; `.claude/lessons/LESSONS.md`, `LESSONS-DIGEST.md`, `_meta.json`, `ARCHIVE.md` (three archivals); registry rows B15/B16/B17/B70/B79 + the new B15-NAV row

Review-read (unchanged, ripple check):
- `estimates.controller.ts` (both convert routes → same method; `@Body() dto: any` stays; any `APP_INTERCEPTOR`/`ClassSerializerInterceptor` that could remap `id` → `invoiceId`, per B15-NAV)
- `estimates.module.ts` (no new imports — L-113 DI boot gate)
- `apps/api/prisma/schema/finance.prisma` `:552-584`, `:215-216`; migration `20260908000000_campaign_schema_foundation`
- `apps/api/src/main.ts:145-149`; `invoices.service.ts:3633,3729`; `enum-parity.spec.ts:222-237`
- `apps/web/lib/api/estimates.ts` consumers of `useSendEstimate` / `useDeclineEstimate` cache writes (response shape pinned unchanged)
- `apps/mobile/lib/estimates-logic.ts`, `apps/mobile/app/(operator)/estimates/**` (send toast/label wording; whether a create form exists that should send `issueDate`; `issueDate?` optional means no forced edit)
- `apps/web/app/providers.tsx:48-49`

---

## 5. Sibling patterns (grep-able; fixed strings and shapes, not arity)

- **B15 (fixed-string error toasts):** `rg -n '"Please try again\.?"|Something went wrong' apps/web apps/mobile` — each hit inside an `onError`/`catch` that has a server message available is a sibling.
- **B15 (render predicate ≠ server claim):** `rg -n -e 'status (===|!==) "' -e '\]\.includes\(status\)' -e 'switch \(status\)' apps/web/app apps/web/components apps/mobile/app apps/mobile/lib` — cross-check each action control against the server's `where: { …status` for the same verb (invoices, credit-notes, vendor-bills, orders).
- **B16 residual:** `rg -n '@Query\("status"\)' apps/api/src` + `rg -nU 'if \(status\)\s*\{?\s*where\.status = status' apps/api/src` (braced/multi-line form included).
- **B17(a) migrated-but-never-written columns:** `rg -n '^\s+\w+\s+(String|DateTime|Int|Decimal|Boolean)\?' apps/api/prisma/schema` → for each column name `rg -n '\b<column>\b' apps/api/src` — zero write sites = sibling. (`@unique` is not the signal; nullability is.) Include `@@unique([...])` block form when checking FK uniqueness.
- **B17(b) delivery claims:** `rg -n 'sent to the customer|has been sent|email(ed)? to' apps/web apps/mobile` vs. whether the verb actually calls `EmailService`.
- **B70 (status mutators without a status predicate):** `rg -nU '\.update(Many)?\(\{\s*where:\s*\{[^}]*\bid\b[^}]*\},\s*data:\s*\{[^}]*\bstatus\b' apps/api/src` (matches `{ id, tenantId }` and `data: { status, … }` shorthand) plus `rg -n 'data: (data|payload|update)\b' apps/api/src` for variable-passed data; every hit whose `where` lacks a `status` predicate is compared against that module's terminal set (invoices VOID/PAID, credit-notes, vendor-bills, orders DELIVERED/CANCELLED). Read-then-check: `rg -nU 'findFirst\([^)]*\);\s*\n\s*if \(![\w.]+ \|\| [\w.]+\.status' apps/api/src`.
- **B79 (typed field missing → cast-to-read / cast-to-send):** `rg -n '\(\w+ as any\)\.\w+' apps/web apps/mobile` and `rg -n '\bas any\b' apps/web/app apps/web/lib apps/mobile/app apps/mobile/lib` — each hit names a field a shared type lacks.
- **B79 (unvalidated Date sink):** `rg -n 'new Date\(dto\.\w+\)' apps/api/src` without an adjacent `isNaN`/format check.

---

## 6. Data repair (report-first; owner decides; no backfill designed here)

- **B15 / B15-NAV / B16:** none.
- **B17:** every CONVERTED estimate in prod has `invoiceId = NULL`. **F27-DR-B17**: read-only count per tenant; owner decides on any heuristic relink. Not blocking.
- **B70:** **money-relevant** — any estimate laundered CONVERTED (or voided) → SENT/DECLINED → ACCEPTED → CONVERTED has minted a second invoice with identical lines. **F27-DR-B70**: read-only report (prod via `railway run`, dry-run only) — candidate signal: invoices sharing `customerId` + identical line set + `notes`/`estimateNumber` reference where present; owner decides credit-note/void per finding. Raised before the batch closes; the fix does not depend on it.
- **B79:** `issueDate` NULL on every existing row by design; readers fall back to `createdAt`. **F27-DR-B79**: default ruling **no backfill**.

---

## 7. Probe plan (`revertFix`: restore HEAD content; named REG must go red)

| Fixed file | Probe granularity | REG(s) that must go red |
|---|---|---|
| `estimates.service.ts` | whole-file, **plus** per hunk: helper+constant, `send()`, `decline()`, `accept()`, `voidEstimate()`, `convertToInvoice` tail, `create()` | `REG-B70 send() refuses…` (both), `REG-B70 decline()…`, `REG-B70 accept() refuses a voided…`, `REG-B70 voidEstimate() claims atomically`, `REG-B70 laundered…`, `REG-B70 missing id is 404`, `REG-B17 …links…`, `REG-B17 link count mismatch…`, `REG-B79 create() persists…`, `REG-B79 …rejects a malformed…`, `REG-B79 read path…` (DB lane) |
| `[id]/page.tsx` | whole-file, plus per hunk: controls, `onError`, `onSuccess`, toast | `REG-B15 convert control is absent…`, `REG-B15 …server reason`, `REG-B15-NAV …navigates…`, `REG-B17 send toast…` |
| `estimates/page.tsx` | whole-file | `REG-B79 web submit carries issueDate`; `npm run check-types` red (the dto literal no longer typechecks without `issueDate` in `CreateEstimateDto`? — no: reverting *this* file restores the cast; the REG is the probe) |
| `apps/web/lib/api/estimates.ts` | whole-file | `npm run check-types` red on two counts: the dto literal in `page.tsx` (cast removed) has fields the reverted `CreateEstimateDto` lacks, and `onSuccess` reads `.id` the reverted result type lacks. Green = the cast was kept or the type was not fixed → harness defect, batch does not merge. |
| `packages/types/api/misc.ts` | whole-file | `npm run check-types` red: readers access `est.issueDate` without a cast on a type that no longer declares it |
| formatter helper | whole-file (or revert readers to the local formatter) | `PIN-B79 UTC-fixed display` red under the TZ override |

Harness-integrity: every REG green after the fix and red under its probe; a REG red under no probe is a harness defect, not a pass. There is no longer any probe row conditioned on an implementer choice.

---

## 8. Surfaced to owner (not designed, not fixed in F27)

1. **B17 real delivery** — no `send-email`/PDF/customer-view verb for estimates (no `EmailModule` in `EstimatesModule`, no `sentAt`). Feature → dev-pipeline, needs a `sentAt` schema decision.
2. **B79 PATCH** — no endpoint edits an existing estimate; backdating an existing one is a feature.
3. **B16 residual** — unvalidated `status` query string, house-wide; 500-vs-400 UNDETERMINED; file with the local-lane repro; any DTO-class fix must respect `forbidNonWhitelisted`.
4. **`expiresAt` unvalidated Date sink** (`create()` `:150-154`) — same shape as the B79 sink fixed here; not swept because the web's current `expiresAt` payload format is not on record and a format check could 400 the live form. File as its own low row; fix with a runtime capture of the payload.
5. **Declared contract changes in B70** (for the owner to acknowledge, not decide): missing-id → 404 on send/decline/accept/void; voided estimates refused by accept; voiding a voided estimate → 400. Web/mobile consumers do not branch on 400 vs 404 per the record; reviewer confirms.
6. **`customers.service.ts:1774`** — S4's written finding on whether it writes `status` (§2 B70.7); a "yes" becomes a registry row or a fifth helper call site in this batch.
7. **Data-repair items F27-DR-B70 / F27-DR-B17 / F27-DR-B79** (§6) — B70's can touch money.
8. **Lessons** (register at 40/40; **archive three** fully-guarded, least-cited entries verbatim to `ARCHIVE.md` first; nextId 117; L-067 is not edited in place):
   - **L-117** (B15): *An action control's render predicate is the same status set the server's claim enforces, expressed once per surface.*
   - **L-118** (B70): *When a terminal-status guard is added to one mutator of a status column, sweep every mutator of that column — same file and every other writer in the radius — through one shared claim helper in the same fix; "optional" sweeps ship the hole one status over.*
   - **L-119** (B17/B79): *A schema field that lands ahead of its write path ships with a red test pinning the write and a read-path round-trip, or the column is NULL forever and the type lies.*
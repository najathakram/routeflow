# Refutation — F08 returns end-to-end (B53 B68 B69 B82 B20 B61 B166 B75 B128 B21)

**Tree:** `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25`, branch `fix/F08-returns-end-to-end`,
HEAD `597c72dc` (carries `151c3f70` = #636/F09 and `3bc86627` = #637). Every line number below was
re-derived by reading the file on THIS tree; the plan's and the registry's citations are stale by
roughly +9 lines from `processRefund` onward and must not be trusted verbatim.

**Method:** for each bug I assumed the suspicion was wrong and traced repro-input → wrong-output
myself. Where the suspicion survives I name the single diverging line. Where the plan's FIX no
longer applies I say exactly how it must be amended, with the disproof.

---

## B53 — refund basis is order-line, not billed

**Verdict: CONFIRMED (partially stale).** Attempted disproof: "F09 already fixed the invoice
selection, so the refund is now billed-basis." Disproved by reading the code — F09 changed only
_which invoices are visible_, never _where the money comes from_.

- Diverging line: **`apps/api/src/returns/returns.service.ts:345-346`**
  `const perUnit = lineQty > 0 ? Number(line.subtotal) / lineQty : Number(line.unitPrice);` /
  `refundAmount += Number(item.qty) * perUnit;` — `line` comes from `ret.order.lineItems`
  (selected at `:328`), never from `ret.order.invoices[].items`. `billedBasisFor` exists nowhere
  (grep: 0 hits repo-wide).
- Second diverging line: **`:381`** `invoiceId: invoices.length === 1 ? invoices[0].id : undefined`
  — 2+ live invoices ⇒ `undefined` ⇒ `credit-notes.service.ts:112` (`if (dto.invoiceId)`) is
  skipped entirely, so the cumulative cap at `credit-notes.service.ts:141-151` never runs.
- What F09 DID close (so half of B53.md's "Evidence" is now stale): `:324-327` filters
  `invoices: { where: { status: { notIn: CREDIT_SOURCE_EXCLUDED } }, select: { id: true } }`.
- The register's own suggested fix (cap `create()` at `min(orderedQty, deliveredQty)`) is
  **REFUTED** independently here: `grep deliveredQty returns.service.ts` returns 0 hits, and the
  plan's reasoning holds — `create()`'s ordered-qty cap at `:110-116` is the correct physical
  ceiling.

**Fix still valid? AMENDED — four changes, two of which are regressions if taken literally.**

1. **`status: { not: 'VOID' }` (plan Fix step 2) is WRONG — use `CREDIT_SOURCE_EXCLUDED`.**
   `apps/api/src/invoices/invoice-status-sets.ts:19-22` defines it as `[VOID, WRITTEN_OFF]`, and
   `credit-notes.service.ts:135-139` throws on BOTH. Selecting `not: VOID` would let a
   `WRITTEN_OFF` sole invoice become `invoices[0].id`, whose `create()` then throws **after** the
   `:356` claim already committed — i.e. it re-opens exactly the F09/B66 hole and turns
   `returns-refund.spec.ts:123-160` ("F09 A2") red. Keep the existing filter; only widen the
   `select` from `{ id: true }` to `{ id: true, total: true, items: { select: { productId, qty,
subtotal } } }`.
2. **The plan's fallback trigger — "fall back to the order-line math ONLY when the order has zero
   Invoice rows of any status" — is UNIMPLEMENTABLE against the current select.** After F09's
   `where` filter, an order whose only invoice is VOID and an order with no invoice at all both
   arrive as `invoices: []` — indistinguishable. Either (a) restate the rule as "fall back when
   the _live-invoice_ set is empty" (behaviourally identical for the legacy case, and it keeps
   F09 A2 minting unsourced), or (b) add a separate unfiltered `_count` on invoices. Option (a)
   is the smaller change; whichever is chosen, the plan's wording must be replaced, not carried.
3. **`findOne`'s select does not contain `invoices` at all** — the plan says "change the findOne
   select (:454-459)"; on this tree `findOne`'s order select is **`:463-469`** and holds only
   `id, orderNumber, lineItems`. The fix must **add** an invoices branch there, not amend one.
4. **The 2+-invoice headroom rule must exclude the zero-invoice case explicitly.** As written
   ("when 2+ remain, compute headroom … throw when refundAmount > headroom"), a literal reading
   applied to the same `else` branch gives headroom 0 for the zero-live-invoice case and rejects
   every F09 A2 refund — red at `returns-refund.spec.ts:123-160`. Gate the headroom check on
   `invoices.length >= 2`.

**Risks the plan missed**

- **Unsourced credits do not consume headroom.** The proposed headroom aggregate is
  `creditNote.aggregate({ where: { invoiceId: { in: ids } } })`. Every credit this same branch has
  ever minted carries `invoiceId: null` (`:381`), so it is invisible to that aggregate. Two
  successive refunds on the same 2-invoice order can each pass the headroom check and together
  over-credit. The cap needs a customer/order-keyed component, or the headroom must subtract prior
  unsourced credits linked through `Return.creditNoteId` for the same order.
- **`min(item.qty, billedQty) × perUnitBilled` over-credits once B128 lands** — see B128 below;
  this is the single most important cross-bug finding in this document.
- Fixture rewrite is larger than "~8 edits": **all 9** `processRefund` fixtures in
  `returns-refund.spec.ts` carry `invoices` without `items`, so every one of them lands on the
  legacy branch unless given invoice items.

**Tests that pin the wrong behavior (must be rewritten)**

- `apps/api/src/returns/returns-refund.spec.ts:76` — `expect(dto.amount).toBe(20)` for return
  qty 2 on order line qty 10 / subtotal 100: the ordered-basis formula asserted as correct.
- `returns-refund.spec.ts:88` — `refundAmount: 20` inside the claim `updateMany` assertion (same
  figure, second site).
- `returns-refund.spec.ts:100-121` — "omits invoiceId when the order has 2+ invoices", asserting
  `expect(dto.invoiceId).toBeUndefined()` with **no** headroom assertion: pins "skip the cap".
- `returns-refund.spec.ts:262` — `expect(dto.amount).toBe(6.67)` (rounding case, order-line basis).
- `returns-refund.spec.ts:290` — `refundAmount: 20` in the EXTERNAL_REFUND assertion.
- `returns-refund.spec.ts:123-160` — F09 A2 must stay GREEN; it is the regression tripwire for
  amendments 1, 2 and 4 above.

---

## B68 — claim-then-mint strands the return at REFUNDED

**Verdict: CONFIRMED.** Attempted disproof: "some catch or re-entry path recovers it." Disproved:
there is no `try`/`catch` anywhere in `returns.service.ts` (0 hits for `catch`).

- Diverging line: **`returns.service.ts:379`** — `const cn = await this.creditNotes.create({…})`
  sits between the committed claim at `:356-364` and the linkage write at `:385`, with no
  `try`/`catch` and no compensating write on the throw path. `:334-335` then refuses re-entry
  (`ret.status !== "RECEIVED"`) and `:407-408` refuses `cancel()` of a REFUNDED return, so the row
  is terminally stranded with `creditNoteId` null.
- The exact wrong value a repro must fail on: **zero calls to `prisma.return.updateMany` /
  `update` after `creditNotesCreate` rejects** (today there is exactly one status-changing write on
  the reject path — the claim itself).

**Fix still valid? YES** (one clarification). `Return.refundMethod String?`,
`refundAmount Decimal?`, `refundedAt DateTime?` are all nullable
(`apps/api/prisma/schema/sales.prisma:968-970`), so the four-field null-out compensation is legal.
Clarification: compensate on **any** throw from `creditNotes.create`, not on an enumerated
exception list — B53's new headroom rejection and F09's `CREDIT_SOURCE_EXCLUDED` throw are both new
rejection sources that must be covered.

**Tests that pin the wrong behavior:** none — `creditNotesCreate.mockRejectedValue` appears nowhere
in `returns-refund.spec.ts`. This is a pure coverage gap; REG-B68 is wholly new.

**Risks the plan missed:** the compensating write goes through
`this.prisma.forTenant().return.updateMany` — the SAME jest mock the claim uses. Existing fixtures
set `prisma.return.updateMany.mockResolvedValue({count:1})` (not `…Once`), so REG-B68 must assert
with `toHaveBeenNthCalledWith(2, …)`, never `toHaveBeenCalledWith`, or a false green is trivial.

---

## B69 — cancel() decides the undo from a stale pre-tx read

**Verdict: CONFIRMED.** Attempted disproof: "the in-tx `findUnique` at the end of the function
re-reads it." Disproved: that read is at **`:441`**, AFTER the undo block, and is used only as the
return value.

- Diverging line: **`returns.service.ts:423`** —
  `if (ret.status === "RECEIVED" || ret.status === "PROCESSED")`, where `ret` is the
  **outside-transaction** read from `:391-394`, while the claim at `:415-418` matches any status
  `notIn ["CANCELLED","REFUNDED"]`. Secondary staleness at `:425-426`: `ret.items[].restock` may
  have been rewritten by `receive({restock:false})`'s `tx.returnItem.updateMany` at `:258`.
- Wrong value the repro must fail on: **0 calls to `tx.product.update`,
  `tx.stockMovement.deleteMany` and `ledger.unreverseReturnEntries`** when the committed status was
  RECEIVED.
- The `|| "PROCESSED"` branch is confirmed dead: a Grep for `PROCESSED` across `apps/api/src`
  returns only `returns.service.ts:413,414,423` — no writer of that status exists in the API. The
  comment at `:413-414` therefore documents a race that cannot occur, while the real
  APPROVED→RECEIVED race is unguarded.

**Fix still valid? YES.** `tx.$executeRaw` is provided unconditionally by the default
`tenantTransaction` mock (`apps/api/src/testing/prisma-mock.ts:227`), so the FOR UPDATE idiom will
not crash any existing spec.

**Corrections doc §6 is REFUTED.** It claims `returns-ledger.spec.ts:77-89` "must gain its own
`return.findUnique`, or the test breaks/crashes once the fix lands." It will not:
`prisma-mock.ts:214-229` shows `forTenant()` returns the `models` object and `tenantTransaction`
spreads **that same object** in as `tx`, so `tx.return.findUnique` IS `prisma.return.findUnique`.
After the fix the fresh in-tx read resolves the same `APPROVED` fixture (with `items` present,
`:83`), the undo stays skipped, and the assertion still passes. The real consequence is the
opposite of §6: that fixture **cannot discriminate** stale-vs-fresh either before or after the fix,
and neither can `:61-75`. **REG-B69 must therefore override `prisma.tenantTransaction` with a tx
whose `return.findUnique` differs from the outer one** — exactly as F08.md's own Test section
specifies. Do not "fix" `returns-ledger.spec.ts` on the strength of §6; a second mock there would
be dead ceremony.

**Tests that pin the wrong behavior:** none pin it (both ledger cases are coincidentally correct
under a single shared mock). `returns-ledger.spec.ts:61-75` and `:77-89` should be left alone; they
are collateral-damage guards, not the oracle.

**Risks the plan missed:** the outer read at `:391-394` still drives the CUSTOMER ownership check
(`:398-405`) and the two early terminal-status throws (`:406-408`). Those must stay on the outer
read (they are the 404/403 path and must not run inside the tx), so after the fix the function has
two reads with different roles — a comment is owed, and a reviewer sweeping "remove the stale read"
would break authz.

---

## B82 — CANCELLED returns permanently consume the quota

**Verdict: CONFIRMED.** Attempted disproof: "some later filter or per-row branch excludes
CANCELLED." Disproved — `:94-99` sums every row the query returns with no status branch at all.

- Diverging line: **`returns.service.ts:89`** —
  `where: { orderId: dto.orderId, status: { not: "REJECTED" } }`.
- Wrong value: for order line qty 10 with one CANCELLED return of qty 10,
  `remaining = 10 − 10 = 0` at `:112`, and `:113-116` throws
  "Return qty (10) exceeds remaining returnable qty (0)". Expected `remaining` = **10**.
- The "zero effects in force" premise holds on this tree: `cancel()` `:425-439` decrements stock
  for every `restock` item, deletes the `StockMovement` rows and un-reverses the ledger; there is
  no `@Delete` on `returns.controller.ts` (read in full, 95 lines, POST/GET only); and
  `orders.service.ts:5507-5508`
  (`const returnCount = await this.prisma.forTenant().return.count({ where: { orderId: id } });`
  then refuse) blocks clearing it via order deletion. So the quota can never be released.
- `CANCELLED` is a real `ReturnStatus` enum member (`sales.prisma:104-113`), so the `notIn` form is
  type-legal.

**Fix still valid? YES**, unamended — `status: { notIn: ["REJECTED", "CANCELLED"] }` at `:89`.

**Tests that pin the wrong behavior**

- `apps/api/src/returns/returns-overreturn.spec.ts:110-113` — a literal `toHaveBeenCalledWith` on
  `{ where: { orderId: "ord-1", status: { not: "REJECTED" } }, include: {…} }`. Green today; it
  encodes the bug as correct behaviour. This is the revert-red oracle for REG-B82.

**Risks the plan missed:** none material. Note only that the plan's ordering (B82 fifth, B21 last)
is what makes REG-B21's e2e "cancel, then re-create for the same order" path work; if B82 were
dropped, that e2e step silently 400s.

---

## B20 — condition/notes dropped at create

**Verdict: CONFIRMED.** Attempted disproof: "the columns don't exist yet, so this is a schema
task." Disproved — both column and migration exist.

- Diverging line: **`returns.service.ts:134-140`** — the `items.create` map holds
  `productId / qty / reason / restock / tenantId` and no `condition` or `notes` key of any kind.
- Columns confirmed present: `apps/api/prisma/schema/sales.prisma:996-997` (`condition String?`,
  `notes String?`, preceded by the `// F01/B20` comment at `:994-995`) **and** already applied by
  `apps/api/prisma/migrations/20260908000000_campaign_schema_foundation/migration.sql:30-31`
  (`ALTER TABLE "ReturnItem" ADD COLUMN "condition" TEXT, ADD COLUMN "notes" TEXT;`).
  **No migration is needed in F08** — the plan and corrections §3 are right.
- Web send side confirmed: `apps/web/app/(dashboard)/returns/page.tsx:174-178` emits
  `{ productId, qty, notes }`. Render side confirmed: `returns/[id]/page.tsx:644-650`
  (`{item.condition && …}` … `{!item.condition && !item.notes && <span…>—</span>}`).
- Wrong value: the created `ReturnItem` row has `notes: null` / `condition: null` because the keys
  are absent from the Prisma payload — not `undefined`, absent.

**Fix still valid? AMENDED (cosmetically).** The two-line map addition is correct. But
`packages/types/api/returns.ts:7-15` (`CreateReturnItemDto`) declares
`productId, qty, notes, reason, restock` and **no `condition`** — so the plan's REG-B20 fixture
(`condition: 'DAMAGED_BOX'`) is only type-legal because the controller binds `@Body() dto: any`
(`returns.controller.ts:26`). Add `condition?: string` to the shared DTO in the same diff, or the
server accepts a field no typed client can send.

**Tests that pin the wrong behavior:** none — no existing spec asserts on
`data.items.create[…]`'s shape. REG-B20 is wholly new.

**Risks the plan missed:** low. `findAll`/`findOne` include `items` wholesale (`:196`, `:471`), so
the columns surface with no read-side change — confirmed.

---

## B61 — restock defaults to true regardless of reason

**Verdict: CONFIRMED, and BROADER than the plan states.**

- Diverging line: **`returns.service.ts:138`** — `restock: i.restock ?? true`, with no reason-aware
  logic anywhere in `create()`.
- Driver payload: `apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx:96-100` maps to
  `{ productId, qty, reason }` — no `restock` key (0 hits for `restock` in that file).
- Web payload: `apps/web/app/(dashboard)/returns/page.tsx:174-178` — no `restock` key either
  (corrections §9 confirmed).
- Downstream effect: `receive()` `:260-286` restocks every item whose persisted flag is truthy.
- Wrong value: persisted `ReturnItem.restock === true` for a `DAMAGED`-reason item.

**Fix still valid? AMENDED — the plan's coverage claim is REFUTED for the mobile operator path.**
F08.md says "Only the mobile operator new.tsx sends an explicit per-line flag", treating that
surface as already correct. It is not: `apps/mobile/lib/returns-logic.ts:71` emits
`restock: restockByProduct[li.productId] ?? true` and
`apps/mobile/app/(operator)/returns/new.tsx:268` renders the switch as `value={restock[pid] ??
true}`. Both default to an **explicit `true`**, which reaches the server as `i.restock === true`
and short-circuits `i.restock ?? defaultRestockForReason(...)`. So after the plan's fix, a mobile
operator filing a DAMAGED return still restocks damaged goods — the exact symptom B61 describes, on
the one surface the plan declares safe. The fix must either make `buildReturnItems` / `new.tsx`
reason-aware (feeding `restockForReason` as the switch's initial value), or the batch must record
that the operator surface is knowingly unfixed.

**Tests that pin the wrong behavior**

- `apps/mobile/__tests__/returns-logic.test.ts:68, 73, 80` — three `toEqual` assertions containing
  `restock: true` for `buildReturnItems` called with an empty `restockByProduct`. These pin the
  unconditional `?? true` default; any reason-aware change to `buildReturnItems` turns them red and
  their fixtures must gain a reason.
- API side: none — no spec asserts the persisted `restock` value.

**Risks the plan missed:** the plan's table maps `CUSTOMER_REFUSED → true`, but the driver screen's
`reasonForApi` (`return/index.tsx:18-30`) maps both `"Refused"` and `"Customer refused"` to
`CUSTOMER_REFUSED` and `"Partial"` to `EXCESS_ORDER`, while a driver who taps the `activeReason`
chip "Damaged" overrides both (`:99`). So the driver's _chip_ — not the mutation type — decides
restock, and a refused-goods return filed under the "Damaged" chip will now stop restocking
sellable goods. Owner-visible behaviour change; flag it alongside the web-modal one the plan
already names.

---

## B166 — returns search box is inert

**Verdict: CONFIRMED.** Attempted disproof: "the service filters by `search` under another name."
Disproved — no `OR` clause exists anywhere in `returns.service.ts`.

- Diverging lines: **`returns.controller.ts:32-40`** binds only
  `orderId/customerId/status/reason/page/limit` — no `@Query("search")`; and
  **`returns.service.ts:185-189`** builds `where` from those four fields only. `findAllForUser`
  (`:158-166`) and `findAll` (`:176-183`) have no `search` parameter.
- Client side confirmed sending it: `apps/web/lib/api/returns.ts:77-88` (`search?: string` in the
  params object, forwarded verbatim as query params) and
  `apps/web/app/(dashboard)/returns/page.tsx:390, 398`.
- Wrong value: row count after typing an existing `returnNumber` equals the full unfiltered count,
  not 1 (and not 0 for a nonsense string).

**Fix still valid? YES.** `findAllForUser` has exactly one caller (`returns.controller.ts:41`) and
`findAll` has exactly two (`returns.service.ts:171`, `:173`, both internal) — verified by Grep, no
other module calls either method — so the plan's "convert to an options object" refactor has a
closed call graph.

**Tests that pin the wrong behavior:** none. REG-B166's jest case and its T2 e2e case are both new.
`returns.security.spec.ts` exercises only `findOneForUser` (`:97-158`) and is unaffected.

**Risks the plan missed**

- **Spec numbering has moved.** `apps/web/e2e/` now contains `28-credit-note-wallet.spec.ts`
  (landed with #636) and `apps/web/playwright.config.ts:503` already carries the
  `credit-note-wallet` project. **29 is still free** (`01…09, 11…28, 30…32, 34` present), so
  corrections §4's conclusion survives but its premise ("28 is reserved for F09, currently
  unmerged") is stale. The new project entry appends after `credit-note-wallet`, not after
  `calendar-dates`.
- The `where.OR` must be ANDed with the CUSTOMER-role `customerId`. Assigning `where.OR = […]`
  alongside `where.customerId` is a Prisma AND and is safe; a refactor into a top-level `OR` array
  would leak other customers' returns. Say so in the diff.

---

## B75 — Total Return Value / row Value always $0.00

**Verdict: CONFIRMED.** Attempted disproof: "`findAll` derives a price via the item's product
relation." Disproved — that include selects `{ id, name }` only.

- Diverging line: **`returns.service.ts:193-197`** — `include: { order: { select: { id,
orderNumber } }, customer: {…}, items: { include: { product: { select: { id, name } } } } }`. No
  price field, no line items, no derivation. `refundEstimate` is computed only in `findOne`
  (`:499-507`).
- Schema proof: `ReturnItem` (`sales.prisma:987-1007`) has no price/unitPrice/subtotal column.
- Client: `apps/web/app/(dashboard)/returns/page.tsx:415`
  (`sum + r.items.reduce((s, i) => s + (i.unitPrice ?? 0) * i.qty, 0)`) and `:626` (the identical
  reduce per row).
- Wrong value: `(item.unitPrice ?? 0) * item.qty` evaluates to `0 × qty = 0` for every row, always.

**Fix still valid? AMENDED — it inherits every B53 amendment.** B75's `findAll` must call the same
`billedBasisFor` helper, which by amendment 1 above must use `CREDIT_SOURCE_EXCLUDED`, not
`not: 'VOID'`. The plan's claim "web Return type already declares it (lib/api/returns.ts:69)" is
confirmed on this tree at **`:67`** (`refundEstimate?: number`) — no type change needed.

**Tests that pin the wrong behavior:** none server-side. **Confirmed absence of any web unit-test
surface:** `apps/web/app/(dashboard)/returns/` contains only `page.tsx` and `[id]/` — no
`.test.tsx` for either page. So e2e spec 29 really is the only UI proof of record for B75 and B21,
exactly as the plan assumes (S1 flagged this as unverified; it is now verified).

**Risks the plan missed**

- **Two `useReturns` queries, one of them near-unbounded.** `page.tsx:395-401` (paged, LIMIT 20)
  and `page.tsx:404` (`useReturns({ limit: 500 })` for the KPI cards). The heavier include lands on
  BOTH, and the KPI one pulls 500 rows × (order line items + live invoice items). Compute
  `refundEstimate` server-side and do **not** return the raw `order.lineItems` / `invoices` payload
  to the client, or that query grows by an order of magnitude.
- **Loop count.** Two copies of the Σqty×(subtotal/qty) loop exist today (`:340-348` and
  `:499-507`); B75 would make three. `billedBasisFor` must absorb all three call sites in the same
  diff, or the batch ships the exact duplication L-030 exists to prevent.

---

## B128 — driver return screen posts DELIVERED qty

**Verdict: CONFIRMED.** Attempted disproof: "the mutation's `quantityDelivered` already holds the
shortfall." Disproved by `apps/mobile/lib/short-pick.ts:63-67` — `deliveryTypeForQty` returns
`REFUSED` precisely when `deliveredQty <= 0`, so a REFUSED mutation carries 0 by construction, and
`buildDeliveries` (`:91-107`) writes that clamped delivered value verbatim.

- Diverging lines: **`apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx:51`**
  (`qty: Number(m.quantityDelivered ?? 0)`), **`:53`**
  (`amount: price * Number(m.quantityDelivered ?? 0)`) and **`:98`**
  (`qty: Math.round(Number(m.quantityDelivered ?? 0))`).
- Wrong values: for a stop with a PARTIAL (ordered 10, delivered 6) and a REFUSED (ordered 5,
  delivered 0), the rendered/posted qtys are **`[6, 0]`**; expected **`[4, 5]`**. The `0` row then
  trips `returns.service.ts:103-104`
  (`if (!item.qty || item.qty <= 0) throw new BadRequestException(…)`), so the whole submit 400s;
  the PARTIAL row alone would return the 6 units the customer KEPT.
- `:53`'s `price * qty` is additionally a money-discipline violation (`price` is
  `lineItem.unitPrice`, `:47`, which is per-box on a boxed line).

**Fix still valid? AMENDED — three defects in the plan's fix text.**

1. **`lineItemSubtotal(li)` does not exist.** `packages/pricing/src/index.ts` re-exports only
   `./pricing` and `./tier-pricing`, and neither declares it (`prorateLineSubtotal` is at
   `packages/pricing/src/pricing.ts:169`; `short-pick.ts:9` imports `prorateLineSubtotal,
roundMoney` from `@routeflow/pricing`). The stored `li.subtotal` IS the agreed money for the
   full ordered qty (`short-pick.ts:18` comment), so the formula is
   `roundMoney(Number(li.subtotal ?? 0) − prorateLineSubtotal(li.subtotal, delivered, ordered,
freeUnits, freeUnitSizeFor(li)))`. `freeUnitSizeFor` does exist (`short-pick.ts:52-60`).
2. **The plan's B128 Notes claim about B53 is REFUTED, and the combination creates a NEW money
   bug.** The plan asserts "the billed-basis refund makes the credit 0 for lines already reconciled
   to the delivered basis." Under B53's own specified formula it does not: order line qty 10,
   delivered-basis invoice item `{ qty 6, subtotal 60 }`, driver returns the 4 undelivered units ⇒
   `billedQty = 6`, `perUnitBilled = 10`, `refund = min(4, 6) × 10 = **40**`. The customer is
   credited 40 for goods they never received and were never billed for. Worse, a later legitimate
   return of 2 delivered units mints another 20, totalling 60 = the entire invoice.
   `min(item.qty, billedQty)` cannot distinguish _which_ units were billed, and no qty-only rule
   can — that is precisely the distinction `deliveredQty` was reaching for, and the plan correctly
   refuted `deliveredQty` as unreliable without supplying a replacement. **This is the one place in
   F08 where two individually-correct fixes compose into an over-credit.** Options for the lead:
   (a) have the driver return post `restock`-only lines with a zero refund basis for undelivered
   qty; (b) cap `billedBasisFor` cumulatively per order at
   `billedTotal − Σ prior credits on the order`; (c) land B128's helper but keep the driver return
   out of the refund path until the basis question is settled. Do not ship this unstated.
3. **`issue()` posts a single `orderId` for mutations spanning every order at the stop.**
   `return/index.tsx:83` takes `stop.orders?.[0]?.id` while `:94-100` maps mutations from ALL of
   `stop.deliveryMutations`. On a multi-order stop, items whose product is not on order[0] hit
   `returns.service.ts:108-109` (`Product … was not in the original order`) and 400 the whole
   submit. Pre-existing, in no registry record, and the `undeliveredReturnLines` rewrite walks
   straight through it — either group by order or record it as a known limitation.

**Tests that pin the wrong behavior:** none — no jest test references `returnRowsFromStop`,
`issue()` or `undeliveredReturnLines` (the helper does not exist).
`apps/mobile/__tests__/returns-logic.test.ts` covers only `returnActionFlags`, `buildReturnItems`
and `returnPillFor`. REG-B128 is wholly new, and the screen rewire itself remains unprovable by
jest (mobile Jest is `__tests__/*.test.ts`, pure-logic only, per project CLAUDE.md).

---

## B21 — returns can't be cancelled from any screen

**Verdict: CONFIRMED (structural absence, not a wrong value).**

- Server side fully present: `returns.controller.ts:90-94` (`@Post(":id/cancel")`,
  `@Roles(UserRole.OPERATOR, UserRole.CUSTOMER)`) → `returns.service.ts:390-443`, with the CUSTOMER
  ownership check at `:398-405` and terminal guards at `:406-408`.
- Web: `apps/web/lib/api/returns.ts` (read in full, 188 lines) exports `useCreateReturn`,
  `useApproveReturn`, `useRejectReturn`, `useMarkReturnInTransit`, `useMarkReturnReceived`,
  `useProcessRefund` — **no cancel mutation**. `returns/[id]/page.tsx`'s only `Cancel` strings are
  modal dismiss buttons (`:115`, `:193`) and status labels (`:60`, `:223`, `:556`) — no cancel
  control.
- Mobile: `apps/mobile/lib/api/returns.ts:127`
  (`export const useCancelReturn = () => useReturnTransition("cancel");`) — a repo-wide Grep for
  `useCancelReturn` returns exactly two source hits: that definition and
  `.claude/skills/bug-hunt/scan-ignore.json:35`. **Zero importers.** (Plan/registry cite `:138`; on
  this tree it is **`:127`**.)
- `returnActionFlags` (`apps/mobile/lib/returns-logic.ts:33-47, 77-98`) has no `canCancel`.

**Fix still valid? YES**, unamended, plus the corrections §10 step (delete
`.claude/skills/bug-hunt/scan-ignore.json:35`) which is confirmed present verbatim.

**Tests that pin the wrong behavior:** none. Verified that adding `canCancel` is **non-breaking**:
`apps/mobile/__tests__/returns-logic.test.ts:10` uses `toMatchObject` (not `toEqual`), `:21-41`
assert individual fields, and `:43-56` ORs a fixed flag list that does not include `canCancel`.
REG-B21's supplementary case is a pure addition.

**Risks the plan missed:** the web `ReturnStatus` union (`apps/web/lib/api/returns.ts:8-16`)
includes `PROCESSED`, which the server's `cancel()` claim (`:416`, `notIn ["CANCELLED",
"REFUNDED"]`) would accept but which the plan's UI status set
`{PENDING, APPROVED, IN_TRANSIT, RECEIVED}` excludes. Harmless today (no writer of PROCESSED
exists), but state it rather than leaving a silent divergence between guard and button.

---

## Overall verdict

All ten suspicions survive refutation on `597c72dc`: each names a real line where behaviour
diverges from intent, and none is closed by F09 (#636) — F09 changed only _which invoices
`processRefund` can see_ (`returns.service.ts:324-327`) and _what `credit-notes.service.ts create()`
refuses_ (`:135-139`), leaving the refund basis, the 2+-invoice cap gap, the missing compensation,
the stale cancel read, the quota filter, the two dropped columns, the restock default, the absent
search binding, the priceless list query, the delivered-side driver qty and the missing cancel UI
all intact. What does **not** survive is a set of the plan's fix instructions:
`status: { not: 'VOID' }` would re-open F09/B66 and must become `CREDIT_SOURCE_EXCLUDED`; the "zero
Invoice rows of any status" fallback trigger is unimplementable against the now-filtered select;
`findOne` has no invoices to re-filter (they must be added); the headroom check must be gated on
`>= 2` invoices or it breaks the F09 A2 case, and its aggregate cannot see the unsourced credits
this very branch mints; corrections §6's claim about `returns-ledger.spec.ts:77-89` is disproved by
`prisma-mock.ts:214-229`; B61's fix does not in fact cover the mobile operator screen, whose
`?? true` defaults defeat the server default; and `lineItemSubtotal` does not exist. The single
finding that should reach the lead before any code is written is the **B53 × B128 composition**:
with the billed basis as specified, a driver return for undelivered goods on a delivered-basis
invoice mints `min(4,6) × 10 = 40` of credit for goods the customer neither received nor paid for —
the plan asserts this case yields 0, and it does not.

## Exact wrong values per REG test

| REG              | Wrong value the repro must fail on (today, `597c72dc`)                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REG-B53 (a)      | `creditNotesCreate` `dto.amount` / claim `refundAmount` = **100** (order line qty 10, subtotal 100, return qty 10) where the billed basis (invoice item qty 6, subtotal 60) is **60**. Existing pin: `returns-refund.spec.ts:76` asserts **20** for the qty-2 variant.            |
| REG-B53 (b)      | `dto.invoiceId` = **undefined** for an order with two live invoices; expected the applicable id. Existing pin: `returns-refund.spec.ts:120`. Fixture must be pre-filtered (VOID rows never reach the service after `:324-327`).                                                   |
| REG-B53 (c)      | credit minted with **no cap check at all** (`credit-notes.service.ts:112` skipped) when 2 live invoices total 100, 90 already credited, refund 20; expected `BadRequestException` and `creditNotesCreate` not called.                                                             |
| REG-B68          | **0** compensating `return.updateMany`/`update` calls after `creditNotesCreate` rejects; return left `status REFUNDED, refundMethod CREDIT_NOTE, refundAmount > 0, creditNoteId null`. Assert with `toHaveBeenNthCalledWith(2, …)`.                                               |
| REG-B69          | **0** calls to `tx.product.update`, `tx.stockMovement.deleteMany` and `ledger.unreverseReturnEntries` when the outer read says APPROVED but the in-tx read says RECEIVED.                                                                                                         |
| REG-B82          | `txReturn.findMany` called with `status: { not: "REJECTED" }` (pinned at `returns-overreturn.spec.ts:111`), yielding `remaining = 0` for a fully-CANCELLED qty-10 return; expected `notIn: ["REJECTED","CANCELLED"]` and `remaining = 10`.                                        |
| REG-B20          | `txReturn.create` `data.items.create[0]` has **no `notes` and no `condition` key** (`returns.service.ts:134-140`); expected `notes: "dented case"`, `condition: "DAMAGED_BOX"`.                                                                                                   |
| REG-B61 (api)    | `data.items.create[0].restock === **true**` for `reason: "DAMAGED"` with no explicit flag; expected `false`.                                                                                                                                                                      |
| REG-B61 (mobile) | `restockForReason` does not exist; and `buildReturnItems(lines, {a:"1"}, {})` returns `restock: **true**` regardless of reason (pinned at `returns-logic.test.ts:68, 73, 80`).                                                                                                    |
| REG-B166         | `prisma.return.findMany` called with a `where` containing **no `OR`** when `search: "RET-1"` is supplied; e2e: row count after typing an existing returnNumber = **the full unfiltered count**, not 1.                                                                            |
| REG-B75          | every `findAll` row carries `refundEstimate === **undefined**`; the web KPI and row Value both evaluate `(unitPrice ?? 0) * qty` to **0** → rendered **"$0.00"** for a return of 2 units on a $5.00 line (expected "$10.00").                                                     |
| REG-B128         | `undeliveredReturnLines(stop)` does not exist; today's rows/payload read qty **`[6, 0]`** and amounts **`[90, 0]`** (decoy unitPrice 15 × delivered) for the PARTIAL(10→6)/REFUSED(5→0) fixture; expected qty `[4, 5]`, amounts `[40, 50]`, DELIVERED skipped, no zero-qty entry. |
| REG-B21          | `returnActionFlags("RECEIVED").canCancel === **undefined**` (the field does not exist); web `[id]/page.tsx` has **zero** cancel controls (`getByRole('button', { name: /cancel return/i })` finds nothing).                                                                       |

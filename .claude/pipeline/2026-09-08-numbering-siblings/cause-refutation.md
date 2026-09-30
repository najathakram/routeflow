# Cause refutation — B267 · B268 · B269 · B270 · B271 · B272 · B277 — numbering siblings

> S2 (Opus @ high, read-only). Method: **assume each suspicion is wrong and try to disprove it.**
> Every claim re-opened independently against the worktree
> `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`, branch `fix/numbering-siblings` @
> `eb2b815e`. No file edited, no test run, no install, no database touched, no server started.
> Binding prior art: F16b/B100 `cause-ruling.md` §2, `cause-refutation.md` §7,
> `fix-round-2.md` D1/D2, `fix-round-2b.md` D7/D8 — quoted where they constrain a fix.

---

## 0. Verdict table

| Row      | Sev filed | Verdict                                         | The diverging line / the disproof                                                                                                                                                                                     |
| -------- | --------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B267** | HIGH      | **confirmed** (+2 corrections)                  | `credit-notes.service.ts:39` TEXT `orderBy` (permanent wall) · `:37-38` unscoped `where` on the raw tx from `prisma.service.ts:60`. Corrections: the create tx is **SERIALIZABLE** (`:269`); no P2002 catch anywhere. |
| **B268** | MEDIUM    | **REFUTED as filed — confirmed worse**          | No P2002 is ever thrown. `import.service.ts:744-757` finds the colliding invoice FIRST and **UPDATES the tenant's existing invoice** (`status`/`dueDate`/`paidAt`), counts `updated++`, drops the imported row.       |
| **B269** | MEDIUM    | **confirmed — severity understated**            | `invoices.service.ts:5352` omits `tenantShort`; `InvoicePayment.paymentNumber` is `String? @unique` **globally** (`finance.prisma:315`). Live cross-tenant P2002 → 500, and a **permanent** Stripe-webhook stall.     |
| **B270** | LOW       | **confirmed — its own "no leak" claim refuted** | `vendor-bills.service.ts:177` TEXT sort **and** `forTenant()` returns the UNSCOPED client on a null tenant (`prisma.service.ts:298`). Everyday failure is the mint/create race (`:238` vs `:249`), not the wall.      |
| **B271** | LOW       | **confirmed — same claim refuted**              | `inventory.service.ts:1022` TEXT sort; `forTenant()` unscoped on null tenant; mint+create in ONE expression (`:1057-1066`), no transaction at all.                                                                    |
| **B272** | LOW       | **confirmed**                                   | `commission-statements.service.ts:73` TEXT sort; raw-tx exposure identical to B267; tx is **SERIALIZABLE** (`:220`). Enum member genuinely absent (`platform.prisma:473-482`).                                        |
| **B277** | LOW       | **REFUTED as filed / undetermined as value**    | The stated trigger ("a collision with an imported number") cannot occur: `estimates.service.ts:139` is the **only** writer of `estimateNumber` in the repo, and F16b made the mint collision-guarded and monotonic.   |

**Overall: `confirmed`** for the batch — six of seven rows reproduce from the code at the lines they
name. Two rows' stated _mechanisms_ are wrong (B268 worse than filed, B277 not reachable), and two
rows' "tenant-scoped, so no cross-tenant leak" self-assessments (B270/B271) are wrong.

---

## 1. The shared primitive: what `reserveNext` can and cannot do TODAY

### 1.1 REFUTED: "the format is the blocker" — the fast path already emits the year segment

The brief (§1.5, §9) implies a non-year-scoped docType is stuck on a year-agnostic series. It is not.
`reserveNext` (`numbering.service.ts:238-277`) gates only the **guarded** path on `isYearScoped`:

```ts
if (year > 0 && isYearScoped(docType)) { …mintForYear… }          // :248
const db = callerTx ?? this.prisma.forTenant();                    // :265
const seq = await db.numberingSequence.upsert({ where: key, create: { tenantId, docType, year, … } });
…
return this.format(seq.prefix, reserved, seq.padding, year);       // :276
```

`key` is `{ tenantId_docType_year: { tenantId, docType, year } }` (`:245`) and `format` inserts the
segment whenever `year > 0` (`:77`). So **`reserveNext("CREDIT_NOTE", { year: 2026 })` returns
`CN-2026-0001` today**, keyed per tenant-year, with no schema change and no `isYearScoped` edit —
byte-identical to `nextCnNumber`'s output. The same holds for a `BILL-`/`PO-`/`CST-` prefix once
those docTypes exist. Every one of these series has a year segment, so **year 0 is never an option**
for them (it would emit `CN-0001`), and the fast path with `year > 0` is not a fallback — it is the
correct format.

### 1.2 CONFIRMED, and decisive: the blocker is the missing **seed**, not the format

Nothing writes a `(tenantId, <docType>, year > 0)` row except `mintForYear` (`:308-316`), and
`getSettings`/`updateSettings` are hard-scoped to `year: 0` (`:100`, `:127`). Therefore **no
`(tenant, CREDIT_NOTE, 2026)` row exists anywhere today.** Routing credit notes onto the fast path
creates it at `nextNumber: 1` and mints `CN-2026-0001` — a number every established tenant already
holds — violating `@@unique([tenantId, creditNoteNumber])` (`finance.prisma:499`) on the **first**
credit note after deploy, for every tenant, permanently. That is strictly worse than the bug.

**So the fast path is unusable for all five migrating series. `mintForYear`'s lazy seed is the whole
job**, exactly as F16b reasoned for ESTIMATE — whose docblock rationale (`:29-34`, "pre-B100
estimates minted by the retired inline max+1 scan … share their number namespace") transfers verbatim
to CN/BILL/PO/CST. The collision-guard half is cheap insurance here: unlike invoices, **none** of
these four namespaces has an out-of-band writer (§4).

### 1.3 What widening `isYearScoped`/`findTaken`/`scanMaxForYear` actually costs (item e)

Three edits per docType, all literal:

| docType                  | `YearScopedDocType`        | `findTaken` branch (`:379-381`)                                   | `scanMaxForYear` branch (`:407-418`)                     | pattern (`:406`)                |
| ------------------------ | -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| INVOICE (today)          | ✓                          | `db.invoice.findFirst({ tenantId, invoiceNumber: candidate })`    | `MAX(regexp_match("invoiceNumber", …))` FROM `"Invoice"` | `^INV-<y>-(\d{1,9})(?:-R\d+)?$` |
| ESTIMATE (today)         | ✓                          | `db.estimate.findFirst({ …, estimateNumber })`                    | `"estimateNumber"` FROM `"Estimate"`                     | `^EST-<y>-(\d{1,9})(?:-R\d+)?$` |
| **CREDIT_NOTE**          | `+ "CREDIT_NOTE"`          | `db.creditNote.findFirst({ tenantId, creditNoteNumber })`         | `"creditNoteNumber"` FROM `"CreditNote"`                 | `^CN-<y>-(\d{1,9})(?:-R\d+)?$`  |
| **BILL** (new enum)      | `+ "BILL"`                 | `db.vendorBill.findFirst({ tenantId, billNumber })`               | `"billNumber"` FROM `"VendorBill"`                       | `^BILL-<y>-(\d{1,9})…$`         |
| **PURCHASE_ORDER**       | `+ "PURCHASE_ORDER"`       | `db.purchaseOrder.findFirst({ tenantId, poNumber })`              | `"poNumber"` FROM `"PurchaseOrder"`                      | `^PO-<y>-(\d{1,9})…$`           |
| **COMMISSION_STATEMENT** | `+ "COMMISSION_STATEMENT"` | `db.commissionStatement.findFirst({ tenantId, statementNumber })` | `"statementNumber"` FROM `"CommissionStatement"`         | `^CST-<y>-(\d{1,9})…$`          |

The `(?:-R\d+)?` group is an invoice-only convention; it simply never fires elsewhere (`:388-391`
already says this about ESTIMATE), so the single shared pattern string stays as written.

**Do NOT convert this to a data-driven table.** `$queryRaw` cannot parameterise identifiers — a
`Record<docType, {table, column}>` map forces `Prisma.raw`/`$queryRawUnsafe`, contradicting the
docblock at `:396-397` ("nothing about the SQL shape is dynamic") and reversing **`fix-round-2b.md`
finding (2), which Fable explicitly ACCEPTED**. The correct widening is more _literal_ branches — a
`switch (docType)` returning a literal tagged template per case. The map above is the specification
for those branches, not a runtime structure.

### 1.4 The two null-tenant leak routes are the SAME defect wearing two coats

- `tenantTransaction` (`prisma.service.ts:48-63`): `:60` `if (!tenantId) return fn(rawTx)` — the
  callback gets the **unwrapped** client. (B267, B272.)
- `forTenant()` (`:296-300`): `:298` `if (!tenantId) return this;` — **also the unwrapped client**.
  (B270, B271, and `import.service.ts` throughout.)

**This refutes B270's and B271's own claim** that `forTenant()` makes them "correctly tenant-scoped,
so no cross-tenant leak". They leak on exactly the same condition as B267 and B272.

**Reachability, confirmed:** `RolesGuard`'s `ROLE_SATISFIES` (`auth/guards/roles.guard.ts:13-19`)
lets `SUPER_ADMIN` satisfy `OPERATOR`; `TenantStatusGuard`'s docblock says "SUPER_ADMIN users
(tenantId === null) always pass"; `TenantInterceptor:18` sets `tenantId = user?.tenantId ?? null` and
`auth.service.ts` signs `tenantId: user.tenantId ?? null`. All four mint routes are
`@Roles(UserRole.OPERATOR)`. So a super-admin token reaches every one of them with a null tenant.
**Corroboration (not proof):** `docs/IMPROVEMENTS.md:510-512` records one prod NULL-tenant
`CreditNote` that is "a duplicate-numbered orphan — writing its Customer-derived tenant would
violate `@@unique([tenantId, creditNoteNumber])`". That is this mechanism's exact fingerprint,
though the row is classed as an April-2026 legacy orphan, so it does not date the code path.

`reserveNext`'s `requireTenant` (`:422-426`) **throws `BadRequestException`** on a null tenant —
never a sentinel. Routing any of these four onto it converts a silent cross-tenant mint into a 400.
That is a behaviour change (a super-admin credit-note create starts failing) and must be ruled, not
assumed. It is the same trade F16b already took for invoices.

---

## 2. Per-row refutation

### 2.1 B267 — credit notes · **confirmed**

**Wrong value today (wall).** Tenant holds `CN-2026-9999` and `CN-2026-10000`. `POST /credit-notes` →
`:37-40` `orderBy { creditNoteNumber: "desc" }` on TEXT: `"CN-2026-9999" > "CN-2026-10000"` (index 8,
`'9' > '1'`) ⇒ `last = CN-2026-9999` ⇒ `:41` `seq = 10000` ⇒ mints **`CN-2026-10000`** ⇒
`tx.creditNote.create` (`:245`) violates `@@unique([tenantId, creditNoteNumber])` ⇒ raw P2002 escapes
(`grep -n P2002 credit-notes.service.ts` → no match) ⇒ **HTTP 500, permanently**, every attempt.
Expected: `CN-2026-10001`.

**Wrong value today (cross-tenant).** Super-admin token; tenant B holds `CN-2026-0042`; mint returns
**`CN-2026-0043`** on a `tenantId: null` row (the `create` at `:245-256` sets no `tenantId` and the
raw client injects none; `CreditNote.tenantId` is `String?`, and NULLs are distinct in a Postgres
unique index, so the constraint is no backstop). Expected: refuse.

**CORRECTION 1 — the create transaction is SERIALIZABLE** (`:102` … `:269`
`{ isolationLevel: "Serializable" }`). This is not cosmetic. Under `REPEATABLE READ`/`SERIALIZABLE`,
a transaction that tries to UPDATE a row a concurrent transaction already updated and committed does
**not** re-read and proceed — it aborts with SQLSTATE 40001 (Prisma `P2034`). So passing
`{ tx }` into `reserveNext` (the D7 in-transaction shape) makes two concurrent credit notes in one
tenant fail with an unhandled `P2034` 500 instead of waiting. **A REG-B100-C-style "10 parallel mints
all succeed" oracle would go RED after such a fix.** The F16b boundary rule therefore resolves
differently here than for the delivery path.

**CORRECTION 2 — B267's own fix suggestion ("CREDIT_NOTE is already a member, so it can move today")
is only half right.** The enum member and `DEFAULTS` entry do exist (`:19`), and the format is right
on the fast path (§1.1) — but the fast path renumbers from 0001 (§1.2). B267 cannot land without the
`isYearScoped` widening.

**Boundary options for Fable (item h):**

- **(a) hoist the mint above the tx** — move `nextCnNumber` from `:244` to before `:102` and call
  `reserveNext("CREDIT_NOTE", { year })` standalone. Matches the invoice "office path" exactly
  (`fix-round-2.md` D1); nothing else is locked at that point, so `fix-round-2b.md` D7's "never hoist
  above a caller tx that ALREADY holds other row locks" is satisfied; concurrency becomes safe
  (autocommitted atomic increment, no SERIALIZABLE abort). **Cost:** a number is burned whenever the
  serializable body later throws — and this body throws often and legitimately (invoice not found,
  wrong customer, `CREDIT_SOURCE_EXCLUDED` status, the invoice-total cap, the per-line cap, the
  line-sum check: `:113-241`). Gaps in a credit-note series are visible to accountants.
- **(b) pass `{ tx }`** — one-line, no gaps, but inherits SERIALIZABLE's abort-on-conflict (P2034)
  and holds the counter row lock for the whole serializable body.

Neither is free. This is a design decision over evidence, not missing evidence.

### 2.2 B268 — import fallback · **REFUTED as filed, CONFIRMED worse**

The row states the synthesized number "throws P2002 on the first synthesized number; caught and
swallowed as a per-row import error at `:807`". **Disproof:** the write at `:764` is preceded, inside
the same `try`, by

```ts
const existing = await this.prisma.forTenant().invoice.findFirst({ where: { invoiceNumber } }); // :744-746
if (existing) {
  const needsUpdate = existing.status !== status || …dueDate… || …paidAt…;                       // :748-751
  if (needsUpdate) { await …invoice.update({ where: { id: existing.id },
                                            data: { status, dueDate, paidAt } }); updated++; }   // :752-757
  else { skipped++; }
  continue;                                                                                       // :761
}
```

**No P2002 is ever thrown.** The colliding number resolves to the tenant's real, live invoice and the
importer **mutates its `status`, `dueDate` and `paidAt`** to the imported row's values, reports it as
`updated`, and silently discards the imported invoice. `errors` stays empty; the import looks
successful. That is a silent cross-document data corruption on a money object, not a swallowed error.

**Wrong value today.** Tenant holds live `INV-2026-0001` (SENT, no `paidAt`). Import a CSV with an
`Invoice ID` column and **no** `Invoice Number` column (the only way the fallback fires — JS
short-circuits `first["Invoice Number"] || …seq++…` at `:631-632`, so `seq` counts only synthesized
numbers). Result: `INV-2026-0001` flips to the imported row's status (e.g. `PAID` with a `paidAt`),
`updated = 1`, `imported = 0`, `errors = []`. Expected: the imported invoice created under a fresh
number continuing the tenant's series, and `INV-2026-0001` untouched.

**What the importer must do instead (item f).** `reserveNext("INVOICE", { year })` per synthesized
row, standalone (no transaction is open at `:631`; the write at `:764` is a bare
`forTenant().invoice.create`, so the F16b office-path shape applies). INVOICE is already year-scoped,
so **this needs no `numbering.service.ts` behaviour change** — `mintForYear`'s lazy seed reads the
tenant's true max and the collision guard proves the candidate free, which makes the `existing`
branch structurally unreachable for synthesized numbers. Seeding the sequence from the imported max
as a separate step is redundant (the lazy seed already does it) and reserving _and_ seeding is
double work. `ImportModule` already imports `NumberingModule` (`import.module.ts:41`); the gap is one
constructor parameter (`import.service.ts:35-39`).

**What it must NOT do.** Renumber a row that carries `first["Invoice Number"]` — those keep their
originals, per `numbering.service.ts:59-60` (verbatim, current lines; the brief's `:44-51` citation
is stale): _"Imported documents keep their ORIGINAL numbers and must NOT call `reserveNext`."_ The
`existing` update branch exists **for** those rows (re-importing the same CSV repairs status drift)
and must stay. The class docblock needs one amending clause — a row with no source number is a live
mint, not a preserved import — or the fix contradicts the rule it lands beside.

Optional and separable: gate the `existing` branch on `numberFromSource`, so a synthesized collision
can never take it even if the guard is ever bypassed. Recommended as belt-and-braces, not required.

### 2.3 B269 — `PAY-####` without the tenant segment · **confirmed, severity understated**

`InvoicePayment.paymentNumber String? @unique` (`finance.prisma:315`) — a **global** unique; it is the
only unique on the model besides the PK, so any P2002 on that create is necessarily the number. Sites
1 (`invoices.service.ts:4746-4753`) and 2 (`:5041-5050`) embed `tenantShort` precisely because of it
(comment `:4743-4745`). Site 3 (`:5340-5352`) does not.

**Is it a live cross-tenant collision? YES.** All three sites key the _same_ counter row
(`getTenantId() ?? "singleton"`), so each tenant has an independent sequence — which is exactly the
problem under a global unique. Tenants A and B, fresh counters, each call `recordStandalonePayment`
with one allocation: the upsert's `create` branch sets `next: allocations.length + 1 = 2`, so
`PAY-${String(2 - 1 + 0).padStart(4,"0")}` = **`PAY-0001`** for both. B's `tx.invoicePayment.create`
(`:5382-5391`) hits the global unique → P2002 → **no catch** (`recordStandalonePayment` `:5320-5441`
has no try/catch; the four P2002→409 catches at `:567`, `:1326`, `:2782`, `:4498` are all
invoice-number mints) → **HTTP 500 for tenant B**. Generally: any two tenants whose counters sit at
the same value collide on their next site-3 payment.

**The aggravating path the row does not mention.** `payment-requests.service.ts:853`
(`writeSettlement`, reached from `settleByPaymentIntent` `:639`, which _does_ establish a tenant
context via `tenantContext.run` at `:650`, so `"singleton"` is not involved) calls
`recordStandalonePayment` to book a **Stripe card/ACH settlement**. On the P2002 the whole
transaction rolls back — **so the counter never advances** — the `BuyerPaymentRequest` stays
`SETTLING` (by design, `:862-866`), and Stripe's redelivery re-mints the _same_ colliding number.
**The stall is permanent** until an operator advances that tenant's counter by some other route
(site 1 or 2), while the buyer's card is already charged. This is a money-path defect, not a
cosmetic format drift.

**Refuted fix direction: do NOT route PAYMENT through `reserveNext`.** `DEFAULTS.PAYMENT` is
`{ prefix: "PAY-", padding: 4 }` (`:20`), so `reserveNext` yields per-tenant `PAY-0001` — i.e. it
would put sites 1 and 2 onto the _colliding_ format and generalise the bug. `reserveNext` is only
safe here **after** `paymentNumber`'s unique becomes `@@unique([tenantId, paymentNumber])`, which is
an index migration and its own diff. The minimal correct fix is one shared formatter emitting
`PAY-${tenantShort}-${padded}` used by all three sites (site 3 keeps its single block-increment;
`counter.next - dto.allocations.length + i` is arithmetically correct). Its own future output
changes on purpose — that is the point of the row — while every existing row keeps its number.

### 2.4 B270 — vendor bills · **confirmed; its own "no cross-tenant leak" claim refuted**

Wall: identical arithmetic to §2.1 on `BILL-<year>-####`; permanent 500 past 10000 (no P2002 catch in
the file). Cross-tenant: `forTenant()` is unscoped on a null tenant (§1.4) — the row's exculpation is
wrong.

**The everyday failure the row misses.** `nextBillNumber()` runs at `:238`, **outside** the
transaction opened at `:249`; two concurrent `POST /vendor-bills` (a double-click, or two AP scans)
read the same `last`, mint the same `BILL-2026-000N`, and the loser's `tx.vendorBill.create` (`:252`)
violates `@@unique([tenantId, billNumber])` (`finance.prisma:652`) → unhandled **500**. Below 9999
this is _transient_ (a retry succeeds); above it, permanent. At real volumes the race is the
observable defect and the wall is theoretical — the LOW severity is defensible only on the wall.

**Boundary: clean.** The mint at `:238` is standalone and nothing is locked, so
`reserveNext(..., no tx)` — its own short transaction, `fix-round-2.md` D1 — drops straight in.

**Extra constraint the ruling must respect:** `billNumber` is a **de-facto foreign key**, not just a
label — `reverseBillLots` looks up `tx.stockLot.findMany({ where: { reference: billNumber } })`
(`:1030-1031`), and bookkeeping writes `reference: bill.billNumber` (`:849`, `:862`, `:972`, `:1102`).
A format change would orphan historical lot reversals.

### 2.5 B271 — purchase orders · **confirmed; same claim refuted**

Identical wall, identical `forTenant()` null-tenant leak. `@@unique([tenantId, poNumber])`
(`catalog.prisma:258`); no P2002 catch. **Tighter race than B270:** the mint is inline in the create's
own `data` literal (`:1057-1066`, mint at `:1059`) with **no transaction at all** — two concurrent
`POST /inventory/purchase-orders` are the plain read-then-write race. Boundary: standalone, clean.
`poNumber` is likewise used as `reference` on stock movements (`:1208`, `:1221`).

### 2.6 B272 — commission statements · **confirmed**

Wall + raw-tx exposure as filed (mint at `:182` on the `tx` from `:94`). Two corrections:

- The generate transaction is **SERIALIZABLE** (`:220`) — §2.1's CORRECTION 1 applies identically.
- Concurrency is _partly_ gated already: the `existingPending` check (`:86-92`) blocks a second
  PENDING statement **per agent**, so the race needs two _different_ agents in one tenant.
  Hoisting the mint above the tx would burn a number on the common
  `"Nothing to generate — no unclaimed commission"` `BadRequestException` (`:176-180`), which fires
  after the accrual reads.

The enum gap is real and exhaustively confirmed: `platform.prisma:473-482` has exactly
`INVOICE, ESTIMATE, CREDIT_NOTE, PAYMENT, RETURN, ORDER` — no `BILL`, no `PURCHASE_ORDER`/`PO`, no
`COMMISSION_STATEMENT`.

### 2.7 B277 — estimate `create()` P2002 · **REFUTED as filed**

The row's trigger is _"a collision — most plausibly an imported estimate number, since imported
documents keep their original numbers"_. **Disproof:**
`grep -rn estimateNumber apps/api/src apps/api/scripts scripts packages` returns exactly one writer,
`estimates.service.ts:139`. There is no estimate importer, no seed script, no backfill — nothing
writes `estimateNumber` out of band anywhere in the repo. The asymmetry with `convertToInvoice`
(REG-B100-F) is precisely this: **invoices** share their namespace with `import.service.ts:631` and
`scripts/import-zoho.js:397`; **estimates** share theirs with nobody.

And after F16b the mint itself cannot produce a taken number: `mintForYear` increments atomically
(distinct candidates for concurrent callers), `findTaken` (`:379-380`) proves the candidate free
against `Estimate` inside the reservation, the `GREATEST` jump is monotonic (`:358-364`), and
exhaustion raises `ConflictException` (`:367-369`) — already a 409, not a P2002. A null tenant now
throws `BadRequestException` at `requireTenant` before any write.

**Verdict: `refuted` for the stated cause; the requested change is still defensible** as a
consistency/defence-in-depth pin matching the four sites in `invoices.service.ts` and
`convertToInvoice` in the same file. It cannot carry a red test that fails on a _live_ wrong value —
only on a mocked one (§8). Fable should decide whether a LOW row with no reachable trigger earns a
place in this batch; it is a 4-line diff with zero risk, so bundling it is cheap, but it must not be
sold as a repro.

---

## 3. Format inventory — what must survive byte-for-byte (item b)

| Row  | Series today                               | Source                                               | Prefix  | Year segment | Padding      | Suffix                            | `DEFAULTS` match?                             |
| ---- | ------------------------------------------ | ---------------------------------------------------- | ------- | ------------ | ------------ | --------------------------------- | --------------------------------------------- |
| B267 | `CN-<year>-0001`                           | `credit-notes.service.ts:36,42`                      | `CN-`   | yes          | `padStart 4` | none                              | ✓ `CREDIT_NOTE {"CN-",4}` (`:19`)             |
| B268 | `INV-<year>-0001`                          | `import.service.ts:632`                              | `INV-`  | yes          | `padStart 4` | none (`-R{i}` on the live series) | ✓ `INVOICE {"INV-",4}` (`:17`)                |
| B269 | `PAY-<TENANT>-0001` (1,2) / `PAY-0001` (3) | `invoices.service.ts:4753,5049 / 5352`               | `PAY-`  | **no**       | `padStart 4` | none                              | ✗ — `PAY-` + pad 4 is site 3's _broken_ shape |
| B270 | `BILL-<year>-0001`                         | `vendor-bills.service.ts:174,180`                    | `BILL-` | yes          | `padStart 4` | none                              | n/a (no enum member)                          |
| B271 | `PO-<year>-0001`                           | `inventory.service.ts:1019,1025`                     | `PO-`   | yes          | `padStart 4` | none                              | n/a                                           |
| B272 | `CST-<year>-0001`                          | `commission-statements.service.ts:71,76`             | `CST-`  | yes          | `padStart 4` | none                              | n/a                                           |
| B277 | `EST-<year>-0001`                          | already `reserveNext` (`estimates.service.ts:34-40`) | `EST-`  | yes          | `padStart 4` | none                              | ✓ (shipped)                                   |

Every non-payment series is `format(prefix, n, 4, year)` verbatim, so `DEFAULTS` entries for the
three new docTypes are `{ prefix: "BILL-"|"PO-"|"CST-", padding: 4 }`. `padStart` **widens** past
9999 (never truncates) in both the old generators and `format` (`:74-78`) — identical.

Two format notes: `demo-seed.js:1591` writes `CN-0001` (no year segment) on the demo tenant — it
matches neither `startsWith("CN-<year>-")` nor `scanMaxForYear`'s anchor, so it is invisible to both
old and new logic. And no client parses any of these: a repo-wide grep of `apps/web/src` and
`apps/mobile` for these literals finds only one mobile **test fixture**
(`__tests__/vendor-bill-scan-helpers.test.ts:272`). No web/mobile blast radius.

---

## 4. Unique constraints, out-of-band writers, and P2002 handling (item c)

| Model                 | Constraint                                                    | Scope      | Out-of-band writer of the number?                       | P2002 handling at the mint site                       |
| --------------------- | ------------------------------------------------------------- | ---------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `CreditNote`          | `@@unique([tenantId, creditNoteNumber])` `finance.prisma:499` | tenant     | none (demo/DANGER scripts only)                         | **none** anywhere in the file                         |
| `Invoice`             | `@@unique([tenantId, invoiceNumber])` `:218`                  | tenant     | **yes** — `import.service.ts:631`, `import-zoho.js:397` | 4 catches, none in the importer                       |
| `InvoicePayment`      | `paymentNumber String? @unique` `:315`                        | **GLOBAL** | none                                                    | **none** at any of the 3 sites                        |
| `VendorBill`          | `@@unique([tenantId, billNumber])` `:652`                     | tenant     | none                                                    | **none**                                              |
| `PurchaseOrder`       | `@@unique([tenantId, poNumber])` `catalog.prisma:258`         | tenant     | none                                                    | **none**                                              |
| `CommissionStatement` | `@@unique([tenantId, statementNumber])` `sales.prisma:1306`   | tenant     | none                                                    | **none**                                              |
| `Estimate`            | `@@unique([tenantId, estimateNumber])` `:580`                 | tenant     | none (single writer, §2.7)                              | **none** in `create()`; present in `convertToInvoice` |

Every one of these `tenantId` columns is `String?`. Postgres treats NULLs as **distinct** in a unique
index, so for a NULL-tenant row none of these constraints is a backstop (F16b fact #11, generalised).

---

## 5. Callers, transactions, and the F16b boundary per mint (item h)

| Mint                         | Caller(s)                                                                                                                                                    | Transaction state at the mint                   | F16b boundary                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `nextCnNumber` `:244`        | `CreditNotesService.create` (only) ← `credit-notes.controller.ts:20`, `returns.service.ts:639` (explicitly "Sequential, NOT nested", `:632-637`)             | **inside** a SERIALIZABLE tx (`:102`,`:269`)    | `{ tx }` (D7) **or** hoist above `:102` (D1) — see §2.1; not free either way |
| `nextBillNumber` `:238`      | `VendorBillsService.create` (only)                                                                                                                           | none (tx opens later at `:249`)                 | standalone (D1) — clean                                                      |
| `nextPoNumber` `:1059`       | `InventoryService.createPurchaseOrder` (only)                                                                                                                | none at all                                     | standalone (D1) — clean                                                      |
| `nextStatementNumber` `:182` | `CommissionStatementsService.generate` (only)                                                                                                                | **inside** a SERIALIZABLE tx (`:94`,`:220`)     | same choice as credit notes                                                  |
| import fallback `:632`       | `ImportService.importInvoices`                                                                                                                               | none (`forTenant().invoice.create` at `:764`)   | standalone (D1) — clean                                                      |
| PAY sites 1/2/3              | `recordPayment`; `recordPayment`'s advance branch (`:4946`); `recordStandalonePayment` ← `invoices.controller.ts:105`, `payment-requests.service.ts:564,853` | all inside `tenantTransaction`                  | **N/A** — no `reserveNext` (§2.3)                                            |
| `estimate.create` `:137`     | `EstimatesService.create` (only)                                                                                                                             | none (`reserveNext` already commits standalone) | unchanged                                                                    |

`$executeRaw`/`$queryRaw` reach through `_wrapTxWithTenant`'s proxy unchanged (`prisma.service.ts:117-124`
passes `$`-prefixed members bound and untouched), so `mintForYear` works on a wrapped tx — already
proven by the invoice delivery path.

---

## 6. Read paths that sort or search these numbers as TEXT (item i)

Grepped `orderBy|sort|contains|startsWith` against all four sibling fields across `apps/api/src`:

- `creditNoteNumber` — only `credit-notes.service.ts:38-39` (**the generator itself**) and a
  `contains` search at `:302`.
- `billNumber` — only `vendor-bills.service.ts:176-177` (the generator) and `contains` at `:1171`.
- `poNumber` — only `inventory.service.ts:1021-1022` (the generator).
- `statementNumber` — only `commission-statements.service.ts:72-73` (the generator).

**Not one downstream ordering exists on any of the four.** The six-site ordering constraint that made
B100's fix delicate (F16b §5, one of them money-affecting) **has no analogue here** — a substantial
de-risking. `paymentNumber` is the exception: two user-facing list sorts
(`invoices.service.ts:4564`, `:5702`), two `contains` searches (`:4550`, `:5689`) and a CSV export
(`:5737`). Those are cosmetic, but they are why today's two coexisting `PAY-` formats sort into two
blocks — and why converging site 3 improves, not worsens, them.

---

## 7. Enum-value migration mechanics (item d)

`DocumentNumberType` has 6 members (`platform.prisma:473-482`); `DEFAULTS` has all 6 because
`Record<DocumentNumberType, …>` (`numbering.service.ts:16`) structurally forces it. **CREDIT_NOTE and
PAYMENT already exist; BILL, PURCHASE_ORDER and COMMISSION_STATEMENT do not and cannot have a
`DEFAULTS` entry until they do.**

Adding one member is **not** only a schema change. It is five coordinated edits:

1. `apps/api/prisma/schema/platform.prisma` — the enum block.
2. A migration containing exactly `ALTER TYPE "DocumentNumberType" ADD VALUE '<X>';` — the verbatim
   shape Prisma emitted for RETURN/ORDER in
   `apps/api/prisma/migrations/20260908000000_campaign_schema_foundation/migration.sql:9-10`, with
   the 6-line "adds more than one value to an enum" banner when >1 value is added. No `IF NOT
EXISTS`, no positional clause. **The directory name must sort after `20260910000000_order_idempotency`**,
   the newest migration on disk.
3. `packages/types/api/enums.ts` — `DOCUMENT_NUMBER_TYPE_VALUES` (`:130-137`). Missed, this turns
   `apps/api/src/common/enum-parity.spec.ts:63` red, since that table pins the shared array
   set-equal to `Object.values(PrismaEnums.DocumentNumberType)`.
4. `numbering.service.ts` `DEFAULTS` — otherwise a TS compile error, not a test failure.
5. `npx prisma generate` locally (CI does it: `apps/api` `postinstall` and `ci.yml:258`).

**Do NOT add the new members to `DOCUMENT_NUMBER_TYPES`** (`:8-13`). It feeds only
`getSettings`/`updateSettings` and `numbering.controller.ts:34`'s path-param validation; adding them
would surface new configurable series in the tenant UI (a feature) and turn
`numbering.service.spec.ts:48-57` red. RETURN and ORDER are the precedent: in the enum and in
`DEFAULTS`, out of `DOCUMENT_NUMBER_TYPES`.

**Gates:** none of Squawk's 9 kept rules targets `ADD VALUE`, and `require-enum-value-ordering` is in
`excluded_rules` (`apps/api/.squawk.toml:48`), so `npm run lint:migrations` does not block it.
`split-prisma-schema.mjs --check`'s `MODEL_DOMAIN` map covers _models_; the enum stays in
`platform.prisma`, which still references it via `NumberingSequence.docType` — unaffected.
CLAUDE.md's deploy flow makes this step 1: fresh backup, then
`railway run --service postgres node apps/api/scripts/prod-migrate.mjs`, **before** the merge, then
`db:drift` at exit 0. **That is the owner ack this batch's Group B needs and Group A does not.**

---

## 8. Test oracle feasibility (item j) and the harness blockers

**DB lane.** Copy `apps/api/src/invoices/invoice-numbering.db.spec.ts` (632 lines): `describeDb` +
`requireLocalDatabaseUrl` from `common/testing/db-spec.ts` (an unset `RUN_DB_SPECS` is a hard error,
never a skip); `freshTenantSlug` via `assertTestTenant("qa-<bug>-<runsuffix>-<n>-<label>", …)` from
`scripts/lib/test-tenants.cjs`; real `PrismaService` + real `TenantContextService` + real
`NumberingService`, every other collaborator mocked at the module boundary; per-test self-contained
oracles with a decoy second tenant; `afterAll` best-effort `cleanupTenant` in FK order. Feasible
oracles, each failing on a **value**:

- `REG-B267-A` cross-tenant: tenant B holds `CN-<y>-0042`, tenant A (null request tenant) mints →
  expect a refusal / A's own `…-0001`; **today `CN-<y>-0043`**.
- `REG-B267-B` wall: tenant holds `…-9999` and `…-10000` → expect `CN-<y>-10001`;
  **today `<threw P2002 …>`** (use the file's `mintError ? "<threw …>" : value` collapse so the red
  run reports a wrong VALUE, not merely "it threw").
- `REG-B267-C` seed: tenant holds `CN-<y>-0412`, no sequence row → first mint `CN-<y>-0413` **and**
  `NumberingSequence(tenant, CREDIT_NOTE, y).nextNumber === 414`. This is the test that would catch
  the §1.2 renumber-to-0001 regression.
- Same three shapes for BILL/PO/CST (Group B).
- `REG-B268`: seed live `INV-<y>-0001` (SENT), run `importInvoices` on a fallback CSV → expect the
  new invoice at `INV-<y>-0002` and the seeded invoice's `status` **still SENT**; today it is the
  imported status and `imported === 0`.
- `REG-B269`: two tenants each mint via `recordStandalonePayment` → expect two distinct numbers;
  today the second throws P2002.

**Cleanup gotchas the test author must not miss:** `VendorBillItem.tenantId` and
`PurchaseOrderItem.tenantId` are NULL on every nested-create row (prod census,
`docs/IMPROVEMENTS.md:517-519`), so a `deleteMany({ where: { tenantId } })` on them deletes nothing —
both relations are `onDelete: Cascade` (`finance.prisma:794`, `catalog.prisma:275`), so deleting the
parent is the correct and sufficient move. A `CommissionStatement` needs a `SalesAgent`
(`agentId` required); `SalesAgent` needs only `name` + `tenantId`. For CST, driving
`generate()` end-to-end needs accruals — prefer a direct `reserveNext("COMMISSION_STATEMENT", …)`
DB oracle for the seed/wall plus a unit pin that `generate()` delegates.

**CI gating:** `apps/api/src/**/*.db.spec.ts` is already in `db-migrations.yml`'s `paths` (`:41`), so
a new DB spec triggers the lane. The **service** files are not — following D4's precedent, add
`credit-notes.service.ts`, `import.service.ts` (Group A) and `vendor-bills.service.ts`,
`inventory.service.ts`, `commission-statements.service.ts` (Group B) to that list.

**Unit oracles.** B277 and B269 are unit-only and both copy an existing shape:
`estimates.service.spec.ts:145-164` mocks `prisma.invoice.create.mockRejectedValue({ code: "P2002" })`
and asserts `.rejects.toBeInstanceOf(ConflictException)` — the same construction with
`prisma.estimate.create` is B277's oracle (expected `ConflictException`, received `{ code: "P2002" }`).
B269's is a value oracle: assert the string site 3 produces.

**HARNESS BLOCKER — the biggest mechanical cost in the batch.** Adding a `NumberingService`
constructor parameter makes Nest fail to resolve at every hand-listed `providers` array. Exact sites
(from `grep -rn "^\s*<Service>,$" --include=*.spec.ts`), each needing
`{ provide: NumberingService, useValue: { reserveNext: jest.fn().mockResolvedValue("…") } }`:

- `CreditNotesService` ×10 — `credit-notes.security.spec.ts:37`; `credit-notes.service.spec.ts:22,265,607`;
  `credit-notes.wallet-integrity.pins.spec.ts:80,293,373`; `credit-notes.wallet-integrity.spec.ts:108,289,555`
- `ImportService` ×3 — `import-customer-cap.spec.ts:29`, `import-robustness.spec.ts:64`, `import.security.spec.ts:29`
- `VendorBillsService` ×7 — `supplier-payment.spec.ts:79`, `vendor-bills-variant-hint.spec.ts:28`,
  `vendor-bills.receive-units.spec.ts:87`, `vendor-bills.security.spec.ts:55,190`, `vendor-bills.service.spec.ts:128,1190`
- `InventoryService` ×2 — `inventory.service.spec.ts:33`, `variant-assign.spec.ts:63`
- `CommissionStatementsService` ×1 — `commission-statements.service.spec.ts:62`

23 sites. Additionally the "mint from empty" defaults become dead and must go:
`credit-notes.service.spec.ts:37`, `vendor-bills.service.spec.ts:567,680`,
`commission-statements.service.spec.ts:67`. `commissionStatement`, `salesAgent` etc. are **not** in
`testing/prisma-mock.ts` — that spec builds them via `extendWithSalesAgentModels` (`:32-51`).
`createMockPrisma`'s `tenantTransaction` spreads the same `models` object, so a `prisma.X.findFirst`
stub also reaches the tx client.

---

## 9. Recommended SPLIT

### Group A — lands with **NO schema change**, no owner migration ack

**Rows: B269, B277, B267, B268** (in ascending risk order; B267+B268 must land together — both touch
`numbering.service.ts`).

| Row  | Minimal files                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B269 | `apps/api/src/invoices/invoices.service.ts` (one shared `PAY-` formatter for `:4753`, `:5049`, `:5352`) · `apps/api/src/invoices/invoices.service.spec.ts`                                                                                                                                                                                                                    |
| B277 | `apps/api/src/estimates/estimates.service.ts` (`try/catch` around `:137-156`) · `apps/api/src/estimates/estimates.service.spec.ts`                                                                                                                                                                                                                                            |
| B267 | `apps/api/src/import/numbering.service.ts` (`YearScopedDocType` + `findTaken` + `scanMaxForYear` branches) · `apps/api/src/credit-notes/credit-notes.service.ts` · `credit-notes.module.ts` · 4 credit-note spec files (10 provider sites) · `apps/api/src/import/numbering.service.spec.ts` · new `credit-note-numbering.db.spec.ts` · `.github/workflows/db-migrations.yml` |
| B268 | `apps/api/src/import/import.service.ts` (+1 ctor param; `:631-632` → `reserveNext`) · `apps/api/src/import/numbering.service.ts` (docblock `:59-60` amendment only) · 3 import spec files · a DB-lane import case · `db-migrations.yml`                                                                                                                                       |

### Group B — needs an **enum-value migration**, therefore the owner's prod-migrate ack and a window

**Rows: B270, B271, B272.** They share one migration and one `numbering.service.ts` edit, so they are
one diff, not three.

`apps/api/prisma/schema/platform.prisma` · `apps/api/prisma/migrations/<ts > 20260910000000>_numbering_doctypes/migration.sql`
· `packages/types/api/enums.ts` · `apps/api/src/import/numbering.service.ts` (DEFAULTS ×3 +
`YearScopedDocType` ×3 + `findTaken` ×3 + `scanMaxForYear` ×3) ·
`vendor-bills/{vendor-bills.service.ts,vendor-bills.module.ts}` ·
`inventory/{inventory.service.ts,inventory.module.ts}` ·
`sales-agents/commission-statements.service.ts` + `commissions.module.ts` · 10 spec provider sites ·
new DB-lane spec(s) · `db-migrations.yml`.

**Fallback if the window is unavailable:** B270/B271/B272 can be fixed _in place_ without any enum —
require a tenant explicitly (no `forTenant()` null fall-through) and replace the TEXT `orderBy` with
the same bounded-regex numeric `MAX` scan. That closes both observable defects with zero schema
change, but leaves three more hand-copies of the max+1 pattern (against L-081/L-072 and against the
rows' own stated fix) and does **not** close the mint/create race, because there is no counter.
Record it as the documented fallback, not the plan.

**Ordering note.** Nothing forces Group A before Group B, but Group A pays for the
`YearScopedDocType` widening once, so Group B's numbering edit is then additive.

---

## 10. Facts the ruling must not get wrong

1. **The fast path already emits the year segment for any docType.** `reserveNext("CREDIT_NOTE",
{ year })` returns `CN-2026-0001` today (`numbering.service.ts:245`, `:248`, `:276`, `:77`). The
   format is not the obstacle for any row in this batch.
2. **The obstacle is the seed.** No `(tenant, docType, year > 0)` row exists for anything but
   INVOICE/ESTIMATE, so the fast path starts at 1 and collides with every existing document on the
   first mint. `mintForYear`'s lazy seed is mandatory for CN/BILL/PO/CST — that is what
   `isYearScoped` widening buys.
3. **Widen with literal branches, never a table-driven map.** `$queryRaw` cannot parameterise
   identifiers; a map forces `Prisma.raw`/`$queryRawUnsafe` and reverses `fix-round-2b.md` finding
   (2), which Fable ACCEPTED (`:396-397` "nothing about the SQL shape is dynamic").
4. **`forTenant()` is NOT a tenant guarantee.** `prisma.service.ts:298` `if (!tenantId) return this;`
   — B270's and B271's "tenant-scoped, so no cross-tenant leak" is **false**. Same defect as
   `tenantTransaction`'s `:60 return fn(rawTx)`.
5. **B267's and B272's create transactions are SERIALIZABLE** (`credit-notes.service.ts:269`,
   `commission-statements.service.ts:220`). Under SERIALIZABLE a blocked UPDATE **aborts** (40001 /
   Prisma `P2034`), it does not wait-and-reread. So an in-tx `{ tx }` reservation does not deliver
   the "a wait, not a failure" property `fix-round-2b.md` D7 promises for READ COMMITTED, and a
   REG-B100-C-style parallel-mint oracle would go red after such a fix.
6. **Hoisting the mint above those transactions burns numbers on validation failures** — credit-note
   create throws on six validation paths after `:102`, and `generate()` throws
   `"Nothing to generate"` after `:94`. Gaps vs. serialization aborts is a real trade, not a
   formality.
7. **B268 throws no P2002.** `import.service.ts:744-757` finds the colliding invoice first and
   **UPDATES the tenant's existing invoice's `status`/`dueDate`/`paidAt`**, counts `updated++`, and
   drops the imported row with an empty `errors` array. The registry row's described symptom is
   wrong; the real one is worse.
8. **The importer must reserve only for rows with NO source number.** `numbering.service.ts:59-60`
   (current lines; the brief's `:44-51` is stale): _"Imported documents keep their ORIGINAL numbers
   and must NOT call `reserveNext`."_ Seeding from the imported max is redundant — `mintForYear`'s
   lazy seed already does it. The docblock needs the clause that a synthesized-because-missing number
   is a live mint.
9. **`InvoicePayment.paymentNumber` is GLOBALLY unique** (`finance.prisma:315`) and is the model's
   only non-PK unique. B269 is therefore a live cross-tenant P2002 (two tenants both mint `PAY-0001`
   from site 3), not a cosmetic drift.
10. **Do NOT route PAYMENT through `reserveNext`** while that unique is global — `DEFAULTS.PAYMENT`
    is `{"PAY-", 4}`, so it would put sites 1 and 2 onto the colliding format too. The safe fix is
    one shared `PAY-${tenantShort}-####` formatter across all three sites.
11. **B269 can permanently stall a Stripe settlement.** `payment-requests.service.ts:853`
    (`writeSettlement`) books through site 3; the P2002 rolls the tx back, so the counter never
    advances and each redelivery re-mints the same colliding number while the card stays charged and
    the request stays `SETTLING`.
12. **The everyday defect in B270/B271 is the mint/create race, not the 9999 wall.** `:238` mints
    outside the tx that writes at `:252`; `:1059` mints inline with no tx at all. Below 9999 the
    resulting P2002 is transient (a retry succeeds); above it, permanent. Neither file has a P2002
    catch.
13. **B277's stated trigger cannot occur.** `estimates.service.ts:139` is the only writer of
    `estimateNumber` in the entire repo, and F16b's mint is monotonic and collision-guarded. The
    change is a defensive mapping copying `convertToInvoice`'s REG-B100-F, not a repro.
14. **These four series have NO downstream text sort** — the only `orderBy` on `creditNoteNumber`,
    `billNumber`, `poNumber` and `statementNumber` is inside each generator itself. F16b's six-site
    ordering constraint has no analogue here. But `billNumber` and `poNumber` ARE used as
    `StockLot.reference` / movement `reference` join keys (`vendor-bills.service.ts:1030-1031`,
    `inventory.service.ts:1208`), so the format still must not change.
15. **An enum member is five edits, not one:** schema, migration
    (`ALTER TYPE "DocumentNumberType" ADD VALUE '<X>';`, directory sorting after
    `20260910000000_order_idempotency`), `packages/types/api/enums.ts:130-137` (or
    `enum-parity.spec.ts:63` goes red), `DEFAULTS` (or TS fails to compile), and `prisma generate`.
    Squawk does not block it. **Do not** add the members to `DOCUMENT_NUMBER_TYPES` — RETURN/ORDER
    are the precedent, and `numbering.service.spec.ts:48-57` pins that array at four.
16. **23 TestingModule provider sites break** the moment any of these services gains a
    `NumberingService` parameter (list in §8). Fix them in the same edit as the tests — a stale
    provider array in a neighbouring suite is the classic bug-batch blocker.

---

## 11. Verdict

**`confirmed`** for the batch, with two per-row exceptions and no question back to S2 — every open
point below is a design choice over complete evidence, not missing evidence.

**Sub-verdicts:** B267 `confirmed` (SERIALIZABLE + seed corrections) · B268 **`refuted` as filed,
`confirmed` as a worse defect** · B269 `confirmed`, severity understated (recommend raising to HIGH:
live cross-tenant 500 on a money path with a permanent webhook stall) · B270 `confirmed`, self-claim
of "no cross-tenant leak" **refuted** · B271 same · B272 `confirmed` · B277 **`refuted`** as a
reachable defect, `undetermined` as a value judgement — Fable rules whether a zero-risk consistency
pin belongs in this batch.

**Two decisions for Fable, both design-over-evidence:**

1. **Boundary for the two SERIALIZABLE minters (B267, B272):** hoist above the transaction (gaps on
   every validation failure, concurrency-safe) or pass `{ tx }` (no gaps, P2034 under concurrency).
   §2.1 lays out both costs; nothing further can be learned by reading more code.
2. **Whether Group B's enum migration is worth an owner window now**, or whether B270/B271/B272 take
   the in-place fallback in §9 and defer the primitive.

# Cause brief — B267 · B268 · B269 · B270 · B271 · B272 · B277 — numbering siblings

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every
> claim carries a file:line, a command output, or a quoted source. Suspected causes are recorded
> AS CLAIMS (the registry rows' own words). No fix proposals, no judgment.
>
> Branch `fix/numbering-siblings`, off `origin/master` at `eb2b815e` (HEAD of origin/master at
> fetch time — satisfies "eb2b815e or newer"). Batch subsystem: document numbering through
> `NumberingService`, which commit `85b7d53c` ("fix(api): tenant-scoped per-year invoice
> numbering through NumberingService (#671)", F16b/B100) just wired for invoices and estimates.
> All seven rows below are `state: uncampaigned`, filed directly via `bugs.mjs file` on
> 2026-09-08 off the same F16b/B100 refutation pass, and all seven already name their own
> suspected cause with a file:line claim — reproduced verbatim in §0, independently re-verified
> against current master in §§1-3 below.

---

## §0 — The bugs as stated (registry rows, verbatim)

### B267 · HIGH · `apps/api/src/credit-notes/credit-notes.service.ts`, `apps/api/src/prisma/prisma.service.ts`

> Credit-note numbering (nextCnNumber) is cross-tenant on a raw tx, same 9999 wall B100 fixed for invoices

**Reported evidence** (verbatim): "F16b/B100 cause refutation + engine final pass, 2026-09-08:
nextCnNumber (credit-notes.service.ts:34-43) is a hand-copied max+1 generator in B100's diagnosed
shape - db.creditNote.findFirst({ where: { creditNoteNumber: { startsWith: prefix } }, orderBy: {
creditNoteNumber: "desc" } }), no tenantId filter of its own, relying entirely on db being
tenant-scoped. Its caller passes tx from this.prisma.tenantTransaction(...) (credit-notes.service.ts:102
into :244). prisma.service.ts tenantTransaction (:48-62): when getTenantId() is falsy, it returns
fn(rawTx) - the UNWRAPPED client, skipping _wrapTxWithTenant (:60 if (!tenantId) return
fn(rawTx)). On that path nextCnNumber scans creditNoteNumber across every tenant, and the same
padStart(4) + lexicographic desc sort B100 diagnosed pins the series at CN-<year>-9999. Fix: route
through NumberingService.reserveNext(docType: CREDIT_NOTE) (numbering.service.ts - CREDIT_NOTE is
already a DOCUMENT_NUMBER_TYPES member) like F16b is wiring invoices/estimates, rather than patch
nextCnNumber in place."

### B268 · MEDIUM · `apps/api/src/import/import.service.ts`

> Fallback CSV importer mints INV-<year>-#### from a local seq=1; collision is swallowed as a per-row import error

**Reported evidence** (verbatim): "F16b/B100 cause refutation + engine final pass, 2026-09-08: the
fallback importer's invoice-number mint (import.service.ts:541 let seq = 1; :631
invoiceNumber = first["Invoice Number"] || `INV-${year}-${String(seq++).padStart(4,"0")}`) never
reads the tenant's existing max INV-<year>-* the way the real mint sites do - every run starts
counting from 0001. A fallback import (rows with no "Invoice Number" column) into a tenant that
already holds INV-<year>-0001 throws P2002 on the first synthesized number; caught and swallowed
as a per-row import error at :807 (this.pushRowError(errors, invoiceNumber, e)) rather than
surfaced as a numbering problem - the row fails with no signal that renumbering, not bad data, was
the cause."

### B269 · MEDIUM · `apps/api/src/invoices/invoices.service.ts`

> Third PaymentCounter mint site emits PAY-#### with no tenant segment; the other two emit PAY-<tenantShort>-####

**Reported evidence** (verbatim): "F16b/B100 cause refutation + engine final pass, 2026-09-08:
invoices.service.ts has three PaymentCounter-backed mint sites sharing one counter
(tx.paymentCounter.upsert) but formatting it differently. :4683 and :4979 (the latter commented
"mirrors recordPayment's counter") both emit PAY-${tenantShort}-${String(counter.next-1).padStart(4,"0")}.
:5282, inside the batch-allocation payment path, emits PAY-${String(counter.next-dto.allocations.length+i).padStart(4,"0")}

- no tenantShort segment. Two payment-number formats coexist inside one tenant depending on which
  recording path was used (single vs batch allocation) - the same hand-copied-mirror-drift
  mechanism L-072 names for enums, here applied to a number format instead of one shared formatter."

### B270 · LOW · `apps/api/src/vendor-bills/vendor-bills.service.ts`

> Vendor-bill numbering (nextBillNumber) copies B100's max+1 pattern - tenant-scoped, but same 9999 wall

**Reported evidence** (verbatim): "F16b/B100 cause refutation + engine final pass, 2026-09-08:
nextBillNumber (vendor-bills.service.ts:172-181, called at :238) is
this.prisma.forTenant().vendorBill.findFirst({ where: { billNumber: { startsWith: prefix } },
orderBy: { billNumber: "desc" } }) then parseInt(...)+1 padStart(4) - correctly tenant-scoped via
forTenant(), so no cross-tenant leak, but the same lexicographic-string-sort class B100 diagnosed:
BILL-<year>-9999 sorts after BILL-<year>-10000 as text, so findFirst desc never advances past 9999
once the series crosses it. Same fix as B100: route through NumberingService.reserveNext once a
BILL docType exists, or at minimum sort/parse numerically."

### B271 · LOW · `apps/api/src/inventory/inventory.service.ts`

> Purchase-order numbering (nextPoNumber) copies B100's max+1 pattern - tenant-scoped, but same 9999 wall

**Reported evidence** (verbatim): "F16b/B100 cause refutation + engine final pass, 2026-09-08:
nextPoNumber (inventory.service.ts:1017-1026, called by createPurchaseOrder) is
this.prisma.forTenant().purchaseOrder.findFirst({ where: { poNumber: { startsWith: prefix } },
orderBy: { poNumber: "desc" } }) then parseInt(...)+1 padStart(4). Tenant-scoped via forTenant() -
no cross-tenant leak - but the same lexicographic-string-sort wall B100 diagnosed:
PO-<year>-9999 sorts after PO-<year>-10000 as text, so the series jams at 9999 once volume crosses
it. Same fix as B100: route through NumberingService.reserveNext once a PO docType exists, or
sort/parse numerically."

### B272 · LOW · `apps/api/src/sales-agents/commission-statements.service.ts`, `apps/api/src/import/numbering.service.ts`

> Commission-statement numbering (nextStatementNumber) copies B100's pattern; needs a DocumentNumberType before routing

**Reported evidence** (verbatim): "F16b/B100 cause refutation + engine final pass, 2026-09-08:
nextStatementNumber (commission-statements.service.ts:68-77, its own comment says "Copies
generateInvoiceNumber's max+1 scan pattern") is db.commissionStatement.findFirst({ where: {
statementNumber: { startsWith: prefix } }, orderBy: { statementNumber: "desc" } }) then
parseInt(...)+1 padStart(4), same 9999 lexicographic wall as B100. db is the tx passed in from its
caller (generate(), :182), so it carries the same raw-tx cross-tenant exposure as nextCnNumber
(filed alongside this row) if ever invoked without a request tenant. numbering.service.ts's
DOCUMENT_NUMBER_TYPES (:7-12) covers INVOICE/ESTIMATE/CREDIT_NOTE/PAYMENT only - routing this
generator through NumberingService.reserveNext needs a new DocumentNumberType member (e.g.
COMMISSION_STATEMENT) plus its DEFAULTS entry before the swap, unlike credit notes which can move
today."

### B277 · LOW · `apps/api/src/estimates/estimates.service.ts`

> Estimate create() has no P2002-to-409 catch on the number mint - a collision with an imported number surfaces as a 500

**Reported evidence** (verbatim): "F16b/B100 cause refutation + engine final pass, 2026-09-08:
nextEstNumber (estimates.service.ts:15-24) is the same findFirst+orderBy-desc+parseInt generator
B100 diagnosed (siblings verified in B100's own evidence: "estimates.service.ts:16-25
tenant-scoped but same pad-4 string-sort wall"). Unlike invoices.service.ts's create path, which
B100's evidence explicitly notes has a P2002-to-409 "please retry" catch (:2700-2701), create()
here (estimates.service.ts:26 onward) has no equivalent try/catch around the estimate.create
write: a collision - most plausibly an imported estimate number, since imported documents keep
their original numbers per numbering.service.ts's own doc comment - throws Prisma's raw
unique-constraint P2002 straight out of the handler as an unhandled 500 instead of the same
409-retry UX invoices already get."

**NOTE on B277's own citation vs current master**: B277's row cites `nextEstNumber` at
estimates.service.ts:15-24/estimates.service.ts:26-onward as the still-broken inline scan. That is
now STALE — see §3.7 below: at current master (`85b7d53c`), `nextEstNumber` (now at :34-40) has
already been rewired to `this.numbering.reserveNext("ESTIMATE", { year, tenantId })` by the same
F16b commit. B277's actual defect (`create()` at :42-157 has no P2002 catch around the
`estimate.create()` write at :137-156) is unaffected by that rewrite and is independently
confirmed at current line numbers in §3.7.

---

## §1 — `numbering.service.ts` as landed by F16b (`85b7d53c`)

Full file: `apps/api/src/import/numbering.service.ts` (427 lines). Injectable, constructor takes
only `PrismaService`.

### 1.1 `DOCUMENT_NUMBER_TYPES` (:8-13) — only 4 of the enum's 6 members

```ts
/** The four document types that carry a tenant-configurable numbering sequence. */
export const DOCUMENT_NUMBER_TYPES: DocumentNumberType[] = [
  "INVOICE",
  "ESTIMATE",
  "CREDIT_NOTE",
  "PAYMENT",
];
```

This feeds `getSettings()`/`updateSettings()` (the tenant-facing numbering-settings card) only.
RETURN and ORDER (added to the Prisma enum by migration `20260908000000_campaign_schema_foundation`,
see §5) are NOT in this array — they exist in the enum and in `DEFAULTS` (below) but nothing calls
`getSettings`/`updateSettings`/`reserveNext` for them yet (schema comment: "F01/G6: the two
remaining findFirst-max minters the register names get routed through NumberingService by F16 —
their series need a docType", referring to `returns.service.ts`/`orders.service.ts`, both OUTSIDE
this batch).

### 1.2 `DEFAULTS` (:16-26) — all 6 enum members, `Record<DocumentNumberType, …>`

```ts
/** Fallback prefix/padding when a tenant has never configured a sequence. */
const DEFAULTS: Record<DocumentNumberType, { prefix: string; padding: number }> = {
  INVOICE: { prefix: "INV-", padding: 4 },
  ESTIMATE: { prefix: "EST-", padding: 4 },
  CREDIT_NOTE: { prefix: "CN-", padding: 4 },
  PAYMENT: { prefix: "PAY-", padding: 4 },
  // F01/G6: match the series the ad-hoc minters emit today (returns.service.ts
  // `RET-<year>-…` pad-4, orders.service.ts `ORD-…` pad-5) so F16 can route
  // them through reserveNext without renumbering anything.
  RETURN: { prefix: "RET-", padding: 4 },
  ORDER: { prefix: "ORD-", padding: 5 },
};
```

`Record<DocumentNumberType, …>` is a TS mapped type — every enum member MUST have an entry, which
is why RETURN/ORDER are present here despite being absent from `DOCUMENT_NUMBER_TYPES`. There is
NO entry for BILL, PO/PURCHASE_ORDER, or COMMISSION_STATEMENT — those are not enum members at all
(§2.1) — a `DEFAULTS` entry cannot exist for a docType the enum doesn't have.

### 1.3 `YearScopedDocType` / `isYearScoped()` (:28-39) — hard-limited to INVOICE/ESTIMATE

```ts
/**
 * The doc types whose LIVE series is keyed per tenant-year (B100/F16b): the
 * `INV-<year>-####` invoices and the `EST-<year>-####` estimates. Both share
 * their number namespace with rows written out of band (imports for invoices;
 * pre-B100 estimates minted by the retired inline max+1 scan), so both get the
 * lazy seed and the collision guard rather than the bare fast path. Every other
 * doc type keeps the year-0 series untouched.
 */
type YearScopedDocType = Extract<DocumentNumberType, "INVOICE" | "ESTIMATE">;

const isYearScoped = (docType: DocumentNumberType): docType is YearScopedDocType =>
  docType === "INVOICE" || docType === "ESTIMATE";
```

`findTaken` and `scanMaxForYear` (below) are both typed to take `docType: YearScopedDocType`, so
today NEITHER can be called with `"CREDIT_NOTE"` or `"PAYMENT"` without first widening this type
and their ternaries — see §9 (Facts the ruling needs).

### 1.4 `format()` (:74-78)

```ts
format(prefix: string, n: number, padding: number, year = 0): string {
  const digits = String(Math.max(0, Math.trunc(n)));
  const padded = padding > 0 ? digits.padStart(padding, "0") : digits;
  return year > 0 ? `${prefix}${year}-${padded}` : `${prefix}${padded}`;
}
```

### 1.5 `reserveNext()` (:238-277) — the public contract

```ts
async reserveNext(
  docType: DocumentNumberType,
  opts?: { year?: number; tenantId?: string; tx?: Prisma.TransactionClient },
): Promise<string> {
  const tenantId = this.requireTenant(opts);
  const year = opts?.year ?? 0;
  const d = DEFAULTS[docType];
  const key = { tenantId_docType_year: { tenantId, docType, year } };
  const callerTx = opts?.tx;

  if (year > 0 && isYearScoped(docType)) {
    return callerTx
      ? this.mintForYear(callerTx, docType, tenantId, year, key, d)
      : this.prisma.tenantTransaction((tx: Prisma.TransactionClient) =>
          this.mintForYear(tx, docType, tenantId, year, key, d),
        );
  }

  // Fast path (unchanged): ensure a row exists, then atomically increment it.
  const db = callerTx ?? this.prisma.forTenant();
  const seq = await db.numberingSequence.upsert({
    where: key,
    create: { tenantId, docType, year, prefix: d.prefix, padding: d.padding, nextNumber: 1 },
    update: {},
  });
  const updated = await db.numberingSequence.update({
    where: key,
    data: { nextNumber: { increment: 1 } },
  });
  const reserved = updated.nextNumber - 1;
  return this.format(seq.prefix, reserved, seq.padding, year);
}
```

`requireTenant(opts)` (:422-426) THROWS `BadRequestException` on a null tenant (never a sentinel
tenant) — `this.prisma.getTenantId() ?? opts?.tenantId`, so a caller can supply `tenantId`
explicitly for a context with no request tenant (the fire-and-forget delivery path), but a truly
absent tenant always throws rather than falling through unscoped — this is the exact behavior
`nextCnNumber`/`nextStatementNumber` do NOT have today (§3.1, §3.6).

For any docType that is NOT year-scoped (or called with `year` omitted/0) — which today is EVERY
docType except INVOICE/ESTIMATE when `opts.year` is passed — `reserveNext` takes the "Fast path":
a single atomic upsert+increment, no collision check, no lazy seed, no per-year semantics. This is
the path CREDIT_NOTE/PAYMENT would use today if called with no `year` (matching their current
`CN-<year>-` / `PAY-` prefixes, which embed the year INSIDE the stored prefix text rather than as
a `format()`-inserted segment — see §9).

### 1.6 `mintForYear()` (:287-370) — lazy seed, `scanMaxForYear`, `findTaken`, the GREATEST jump

```ts
private async mintForYear(
  db: Prisma.TransactionClient,
  docType: YearScopedDocType,
  tenantId: string,
  year: number,
  key: { tenantId_docType_year: { tenantId: string; docType: DocumentNumberType; year: number } },
  d: { prefix: string; padding: number },
): Promise<string> {
  let current = await db.numberingSequence.findUnique({ where: key });

  if (!current) {
    const max = await this.scanMaxForYear(db, docType, tenantId, year, d.prefix);
    this.logger.log(
      `Seeded ${docType} numbering for tenant ${tenantId} year ${year}: max ${max}, next ${max + 1}.`,
    );
    await db.$executeRaw`
      INSERT INTO "NumberingSequence"
        ("id", "tenantId", "docType", "year", "prefix", "padding", "nextNumber", "updatedAt")
      VALUES (
        ${randomUUID()}, ${tenantId}, ${docType}::"DocumentNumberType", ${year},
        ${d.prefix}, ${d.padding}, ${max + 1}, NOW()
      )
      ON CONFLICT ("tenantId", "docType", "year") DO NOTHING
    `;
    current = await db.numberingSequence.findUniqueOrThrow({ where: key });
  }

  const prefix = current.prefix ?? d.prefix;
  const padding = current.padding ?? d.padding;

  const MINT_MAX_ATTEMPTS = 5;
  let skipped = 0;
  for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
    const updated = await db.numberingSequence.update({
      where: key,
      data: { nextNumber: { increment: 1 } },
    });
    const reserved = updated.nextNumber - 1;
    const candidate = this.format(prefix, reserved, padding, year);

    const clash = await this.findTaken(db, docType, tenantId, candidate);
    if (!clash) {
      if (skipped) { this.logger.warn(/* … advanced past N existing number(s) … */); }
      return candidate;
    }

    const max = await this.scanMaxForYear(db, docType, tenantId, year, prefix);
    const target = Math.max(max + 1, updated.nextNumber);
    skipped += target - reserved;
    await db.$executeRaw`
      UPDATE "NumberingSequence"
      SET "nextNumber" = GREATEST("nextNumber", ${target}), "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId}
        AND "docType" = ${docType}::"DocumentNumberType"
        AND "year" = ${year}
    `;
  }

  throw new ConflictException(
    `Could not find a free ${docType} number for tenant ${tenantId} year ${year} after ${MINT_MAX_ATTEMPTS} attempts.`,
  );
}
```

`findTaken` (:373-382) — hard-coded to only the two known tables:

```ts
private async findTaken(
  db: Prisma.TransactionClient,
  docType: YearScopedDocType,
  tenantId: string,
  candidate: string,
): Promise<{ id: string } | null> {
  return docType === "ESTIMATE"
    ? db.estimate.findFirst({ where: { tenantId, estimateNumber: candidate } })
    : db.invoice.findFirst({ where: { tenantId, invoiceNumber: candidate } });
}
```

`scanMaxForYear` (:399-420) — the true numeric max via a bounded regex capture, also hard-coded to
the same two tables (raw SQL, literal table/column names, "nothing about the SQL shape is
dynamic" per its own docblock):

```ts
private async scanMaxForYear(
  db: Prisma.TransactionClient,
  docType: YearScopedDocType,
  tenantId: string,
  year: number,
  prefix: string,
): Promise<number> {
  const pattern = `^${prefix}${year}-(\\d{1,9})(?:-R\\d+)?$`;
  const rows =
    docType === "ESTIMATE"
      ? await db.$queryRaw<Array<{ max: number | null }>>`
          SELECT COALESCE(MAX((regexp_match("estimateNumber", ${pattern}))[1]::int), 0)::int AS max
          FROM "Estimate" WHERE "tenantId" = ${tenantId}`
      : await db.$queryRaw<Array<{ max: number | null }>>`
          SELECT COALESCE(MAX((regexp_match("invoiceNumber", ${pattern}))[1]::int), 0)::int AS max
          FROM "Invoice" WHERE "tenantId" = ${tenantId}`;
  return Number(rows?.[0]?.max ?? 0);
}
```

The capture is bounded to 9 digits "ON PURPOSE" (docblock, :392-397): a longer segment would
overflow the `::int` cast and abort the whole statement (SQLSTATE 22003), so a foreign/oversize
shape (an imported number) is ignored rather than crashing the seed.

### 1.7 The docblock's boundary rule (:52-61, class-level; reproduced verbatim)

```
/**
 * Owns per-tenant, per-document-type numbering continuity (spec §1). Set during
 * migration from the source's last number ("INV-08841" → next "INV-08842") and
 * editable afterwards. `reserveNext(docType, opts?)` is the collision-guarded
 * contract LIVE minting (invoices/estimates, B100/F16b) consumes for the
 * per-tenant-year `INV-<year>-####` / `EST-<year>-####` series — in its own short
 * transaction for a standalone caller, or on the caller's own client when it is
 * already inside one (`opts.tx`, the delivery path). Imported documents keep their
 * ORIGINAL numbers and must NOT call `reserveNext`.
 */
```

This bears directly on B268: the fallback importer's synthesized `INV-<year>-####` number (when a
source row has no "Invoice Number" column) is not preserving an original imported number, but it
is also not an ordinary "live mint" the way `InvoicesService.create()` is — it is generated
in-band during an import run. The class docblock's blanket rule ("Imported documents … must NOT
call reserveNext") does not by itself resolve which category a synthesized-because-missing
fallback number falls into.

---

## §2 — Prisma schema: `DocumentNumberType` enum and `NumberingSequence` model

`apps/api/prisma/schema/platform.prisma`:

### 2.1 The enum (:473-482), all 6 members

```prisma
enum DocumentNumberType {
  INVOICE
  ESTIMATE
  CREDIT_NOTE
  PAYMENT
  // F01/G6: the two remaining findFirst-max minters the register names get
  // routed through NumberingService by F16 — their series need a docType.
  RETURN
  ORDER
}
```

No `BILL`, `PURCHASE_ORDER`/`PO`, or `COMMISSION_STATEMENT` member exists. B270 (vendor bills),
B271 (purchase orders) and B272 (commission statements) each name their target docType as
not-yet-existing; this enum block confirms none of the three are present today.

### 2.2 `NumberingSequence` model (:455-471)

```prisma
model NumberingSequence {
  id         String             @id @default(uuid())
  tenantId   String
  docType    DocumentNumberType
  prefix     String             @default("")
  nextNumber Int                @default(1)
  padding    Int                @default(4)
  // F01/B100: per-year series (INV-2026-0001 restarts each January). 0 = the
  // year-agnostic series, which is what every pre-existing row means — so the
  // default keeps them valid and the widened unique key cannot collide them.
  year       Int                @default(0)
  createdAt  DateTime           @default(now())
  updatedAt  DateTime           @updatedAt

  @@unique([tenantId, docType, year])
  @@index([tenantId])
}
```

### 2.3 Which docTypes have a `DEFAULTS` entry (numbering.service.ts)

All 6 enum members (§1.2) — `Record<DocumentNumberType, …>` structurally forces it. Of those:

- **CREDIT_NOTE, PAYMENT**: also in `DOCUMENT_NUMBER_TYPES` (§1.1) — reachable via `getSettings`/
  `updateSettings` today; `reserveNext("CREDIT_NOTE" | "PAYMENT", …)` is callable today with no
  enum/migration change, but see §9 on `isYearScoped` for what year-scoping would additionally need.
- **RETURN, ORDER**: in `DEFAULTS` but not in `DOCUMENT_NUMBER_TYPES`; not part of this batch.
- **INVOICE, ESTIMATE**: fully wired (year-scoped, `findTaken`/`scanMaxForYear` aware) by F16b.
- No entry exists or can exist for BILL/PO/COMMISSION_STATEMENT until each gets an enum member.

---

## §3 — Each sibling generator (verbatim, current master)

### 3.1 B267 — `nextCnNumber` (`apps/api/src/credit-notes/credit-notes.service.ts:34-43`)

```ts
private async nextCnNumber(db: any) {
  const year = new Date().getFullYear();
  const prefix = `CN-${year}-`;
  const last = await db.creditNote.findFirst({
    where: { creditNoteNumber: { startsWith: prefix } },
    orderBy: { creditNoteNumber: "desc" },
  });
  const seq = last ? parseInt(last.creditNoteNumber.split("-")[2], 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
```

Caller (:96-104, :244): `tenantId` is read once (`this.prisma.getTenantId()`) purely to be passed
to `computeLineSubtotal`-adjacent logic; the actual write path is
`const cn = await this.prisma.tenantTransaction(async (tx: any) => { … const creditNoteNumber =
await this.nextCnNumber(tx); const created = await tx.creditNote.create({ data: { creditNoteNumber,
… } }); … })`. `db`'s type is `any` — no compile-time signal that it must be tenant-scoped.

- **Key/scoping**: whatever `tx` `tenantTransaction` hands the callback — tenant-scoped ONLY when
  `getTenantId()` was truthy when the transaction opened (see §3.1a, `prisma.service.ts`).
- **Visible format**: `CN-<year>-####` (pad 4), year baked into the literal `prefix` string, not a
  `format()`-inserted segment.
- **Unique constraint on target model**: `CreditNote` — `@@unique([tenantId, creditNoteNumber])`
  (`apps/api/prisma/schema/finance.prisma:499`).
- **P2002 handling**: none. `grep -n P2002 credit-notes.service.ts` — no matches anywhere in the
  file. The `tenantTransaction(...)` call at :102 has no surrounding `try`/`catch`.
- **Callers**: `CreditNotesService.create(dto)` (:65-…), the only mint site for `creditNoteNumber`.
- **Module wiring**: `credit-notes.module.ts` does not import `NumberingModule` — `grep -n
"NumberingService\|numbering"` on it returns no match. `credit-notes.service.ts`'s import block
  (:1-20) has no `NumberingService` import either.

#### 3.1a `prisma.service.ts` `tenantTransaction` (:48-63) — the raw-tx fallback B267 names

```ts
async tenantTransaction<T>(
  fn: (tx: any) => Promise<T>,
  options?: Parameters<PrismaClient["$transaction"]>[1],
): Promise<T> {
  const tenantId = this.getTenantId();
  return this.$transaction(async (rawTx: any) => {
    if (tenantId) {
      await rawTx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    } else {
      await rawTx.$executeRaw`SELECT set_config('app.current_tenant_id', '', true)`;
    }
    if (!tenantId) return fn(rawTx);
    return fn(this._wrapTxWithTenant(rawTx, tenantId));
  }, options as any);
}
```

Confirms B267's claim exactly: `if (!tenantId) return fn(rawTx)` hands the callback the UNWRAPPED
client — `_wrapTxWithTenant`'s auto-injection (the thing that would otherwise scope `findFirst`)
is skipped entirely on a falsy `getTenantId()`.

### 3.2 B270 — `nextBillNumber` (`apps/api/src/vendor-bills/vendor-bills.service.ts:172-181`)

```ts
private async nextBillNumber() {
  const year = new Date().getFullYear();
  const prefix = `BILL-${year}-`;
  const last = await this.prisma.forTenant().vendorBill.findFirst({
    where: { billNumber: { startsWith: prefix } },
    orderBy: { billNumber: "desc" },
  });
  const seq = last ? parseInt(last.billNumber.split("-")[2], 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
```

Called at :238 (`const billNumber = await this.nextBillNumber();`), OUTSIDE the transaction: the
actual write, `tx.vendorBill.create({ data: { billNumber, … } })`, happens inside
`this.prisma.tenantTransaction(async (tx) => { … })` opened at :249. The mint (a separate
`forTenant()` call) and the create (inside a later, separate transaction) are two different DB
round trips with no shared lock between them — a second concurrent `create()` call could mint the
same `billNumber` before the first's transaction commits.

- **Key/scoping**: `this.prisma.forTenant()` — tenant-scoped correctly (row's own claim).
- **Visible format**: `BILL-<year>-####` (pad 4).
- **Unique constraint**: `VendorBill` — `@@unique([tenantId, billNumber])` (`finance.prisma:652`).
- **P2002 handling**: none — `grep -n P2002 vendor-bills.service.ts` returns no match anywhere in
  the file; `create()` (:183-299) has no `try`/`catch` around the `tenantTransaction` call at :249.
- **Callers**: `VendorBillsService.create(dto)`, the only call site (:238).
- **Module wiring**: `vendor-bills.module.ts` — no `NumberingService`/`numbering` reference.

### 3.3 B271 — `nextPoNumber` (`apps/api/src/inventory/inventory.service.ts:1017-1026`)

```ts
private async nextPoNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const last = await this.prisma.forTenant().purchaseOrder.findFirst({
    where: { poNumber: { startsWith: prefix } },
    orderBy: { poNumber: "desc" },
  });
  const seq = last ? parseInt(last.poNumber.split("-")[2], 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
```

Called inline at :1059, as part of the `data:` object literal passed straight to
`this.prisma.forTenant().purchaseOrder.create({ data: { poNumber: await this.nextPoNumber(), … }
})` (:1057-1066) — no transaction wraps mint+create at all (not even the two-call pattern B270
has); the mint and the create are sequential awaits inside one expression with no row lock held
across them either.

- **Key/scoping**: `this.prisma.forTenant()` — tenant-scoped.
- **Visible format**: `PO-<year>-####` (pad 4).
- **Unique constraint**: `PurchaseOrder` — `@@unique([tenantId, poNumber])`
  (`apps/api/prisma/schema/catalog.prisma:258`).
- **P2002 handling**: none — `grep -n P2002 inventory.service.ts` (2,700+ line file) returns no
  match.
- **Callers**: `InventoryService.createPurchaseOrder(dto, userId)` (:1028-1074), the only site.
- **Module wiring**: `inventory.module.ts` — no `NumberingService`/`numbering` reference.

### 3.4 B272 — `nextStatementNumber` (`apps/api/src/sales-agents/commission-statements.service.ts:68-77`)

```ts
/** Same max+1 scan class as B100 (fixed for invoices in #F16b); statement numbering is tracked as its own registry row. */
private async nextStatementNumber(db: any): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CST-${year}-`;
  const last = await db.commissionStatement.findFirst({
    where: { statementNumber: { startsWith: prefix } },
    orderBy: { statementNumber: "desc" },
  });
  const seq = last ? parseInt(last.statementNumber.split("-")[2], 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
```

Caller: `generate(dto)` (:79-…), `return this.prisma.tenantTransaction(async (tx) => { … const
statementNumber = await this.nextStatementNumber(tx); const statement = await
tx.commissionStatement.create({ data: { statementNumber, … } }); … }, )` — `tenantTransaction`
opened at :94-95, mint at :182. Same `tenantTransaction`-supplied `tx` shape as B267 (§3.1a): on a
falsy `getTenantId()`, `tx` is the raw unwrapped client.

- **Key/scoping**: same raw-tx exposure class as `nextCnNumber` (§3.1a) — `db: any`, no type-level
  scoping signal.
- **Visible format**: `CST-<year>-####` (pad 4).
- **Unique constraint**: `CommissionStatement` — `@@unique([tenantId, statementNumber])`
  (`apps/api/prisma/schema/sales.prisma:1306`).
- **P2002 handling**: none — `grep -n P2002 commission-statements.service.ts` returns no match.
- **Callers**: `CommissionStatementsService.generate(dto)` (:79-…), the only mint site.
- **Module wiring**: `commissions.module.ts` `imports:` is `[PrismaModule, EntitlementsModule]`
  (:24) — no `NumberingModule`.
- **Enum gap**: confirmed in §2.1 — no `COMMISSION_STATEMENT` member exists in `DocumentNumberType`
  today.

### 3.5 B269 — the three `PaymentCounter` mint sites (`apps/api/src/invoices/invoices.service.ts`)

Model (`finance.prisma:349-357`):

```prisma
model PaymentCounter {
  id       String  @id @default("singleton")
  next     Int     @default(1)
  tenantId String?

  tenant Tenant? @relation(fields: [tenantId], references: [id])

  @@index([tenantId])
}
```

Consuming field, `InvoicePayment.paymentNumber` (`finance.prisma:315`):

```prisma
paymentNumber    String?       @unique
```

This is a **GLOBAL** unique constraint — not `@@unique([tenantId, paymentNumber])` — which is
exactly why site 1 and 2 embed a tenant hash: comment at :4743-4745, "Include a short tenant hash
in the payment number to avoid global @unique collisions across tenants." Site 3
(`recordStandalonePayment`) omits that hash, so its output format is not merely cosmetically
different — a `paymentNumber` collision on the GLOBAL unique index across two different tenants
is structurally possible from that site in a way it is not from sites 1/2.

Current line numbers (B269's row cites :4683/:4979/:5282; current master has moved to :4753/:5049/:5352
— noted as a discrepancy, not a defect):

**Site 1** — inside `recordPayment(id, dto)` (:4709-…), :4743-4753:

```ts
// Auto-generate payment number — use tenantId as the counter row key so
// each tenant has its own independent sequence. Include a short tenant hash
// in the payment number to avoid global @unique collisions across tenants.
const counterKey = this.prisma.getTenantId() ?? "singleton";
const tenantShort = counterKey.slice(0, 6).toUpperCase();
const counter = await tx.paymentCounter.upsert({
  where: { id: counterKey },
  update: { next: { increment: 1 } },
  create: { id: counterKey, next: 2 },
});
const paymentNumber = `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;
```

**Site 2** — private helper, called from inside `recordPayment`'s multi-invoice
advance-application branch (call site :4946; helper :5040-5050):

```ts
/** Tenant-scoped `PAY-XXXX-####` sequence — mirrors recordPayment's counter. */
private async nextPaymentNumberInTx(tx: any): Promise<string> {
  const counterKey = this.prisma.getTenantId() ?? "singleton";
  const tenantShort = counterKey.slice(0, 6).toUpperCase();
  const counter = await tx.paymentCounter.upsert({
    where: { id: counterKey },
    update: { next: { increment: 1 } },
    create: { id: counterKey, next: 2 },
  });
  return `PAY-${tenantShort}-${String(counter.next - 1).padStart(4, "0")}`;
}
```

**Site 3** — inside `recordStandalonePayment(dto, opts?)` (:5320-…), the batch-allocation path,
:5340-5352:

```ts
return this.prisma.tenantTransaction(async (tx) => {
  // Generate a block of sequential payment numbers (tenant-scoped counter)
  const counterKey = this.prisma.getTenantId() ?? "singleton";
  const counter = await tx.paymentCounter.upsert({
    where: { id: counterKey },
    update: { next: { increment: dto.allocations.length } },
    create: { id: counterKey, next: dto.allocations.length + 1 },
  });

  const payments: any[] = [];
  for (let i = 0; i < dto.allocations.length; i++) {
    const alloc = dto.allocations[i];
    const paymentNumber = `PAY-${String(counter.next - dto.allocations.length + i).padStart(4, "0")}`;
    …
```

All three sites key `PaymentCounter` by the SAME `counterKey = this.prisma.getTenantId() ??
"singleton"` — i.e. all three read/increment the SAME row for a given tenant, so the counter
itself is shared and consistent; only the FORMATTED output differs (sites 1/2 include
`tenantShort`, site 3 does not).

- **P2002 handling**: none of the three sites has a `try`/`catch` immediately around its
  `paymentNumber`/`invoicePayment.create` — `grep -n P2002 invoices.service.ts` DOES find 4 catch
  sites elsewhere in the file (§4.3), none of them wrapping these three payment-number mints.
- **Callers**: site 1 ← `recordPayment` (single-invoice payment recording); site 2 ← the
  multi-invoice advance-application branch inside `recordPayment`; site 3 ← `recordStandalonePayment`
  (bulk allocation across several invoices in one call).

### 3.6 B268 — the fallback importer (`apps/api/src/import/import.service.ts`)

`importInvoices(buffer, userId)` (:516-…). `ImportService`'s constructor (:35-39) injects only
`PrismaService`, `VendorBillsService`, `CustomersService` — no `NumberingService`.

```ts
const year = new Date().getFullYear();
let seq = 1;                                                              // :540-541

for (const [, invoiceRows] of Object.entries(groups)) {
  …
  const invoiceNumber =
    first["Invoice Number"] || `INV-${year}-${String(seq++).padStart(4, "0")}`;   // :631-632
  …
  try {
    …
    const newInvoice = await this.prisma.forTenant().invoice.create({    // :764-781
      data: { invoiceNumber, customerId: customer.id, status, subtotal, taxAmount: 0,
        discount, shippingFee, total, issueDate, dueDate, paidAt, notes, terms,
        items: { create: itemsData } },
    });
    …
    imported++;
  } catch (e: any) {
    this.pushRowError(errors, invoiceNumber, e);                          // :807
    skipped++;
  }
}
```

`pushRowError` (:71-75):

```ts
private pushRowError(errors: string[], label: string, e: unknown): void {
  const detail = e instanceof Error ? e.message : String(e);
  this.logger.warn(`Import row failed [${label}]: ${detail}`);
  errors.push(`${label}: import failed`);
}
```

`seq` is a per-CSV-run local counter, reset to `1` on every call to `importInvoices` — it never
reads any existing `INV-<year>-*` row before minting, and never touches `NumberingSequence`.

- **Key/scoping**: `this.prisma.forTenant()` on the `.create()` call — tenant-scoped for the
  WRITE, but the mint itself (`seq`) has no DB read/scoping step at all.
- **Visible format**: `INV-<year>-####` (pad 4) — identical shape to the live series
  `generateInvoiceNumber` mints (§4.1), sharing the same namespace on the same `Invoice` model.
- **Unique constraint**: `Invoice` — `@@unique([tenantId, invoiceNumber])` (`finance.prisma:218`).
- **P2002 handling**: catches everything (`catch (e: any)`), not P2002-specific — a numbering
  collision (P2002) and any other row-level failure (bad data, FK violation, etc.) produce the
  identical logged/returned message shape: `"${label}: import failed"`. Nothing in the catch
  branches on `e.code === "P2002"` to say "this was a numbering collision."
- **Module wiring**: `ImportModule` (`apps/api/src/import/import.module.ts`) DOES import
  `NumberingModule` already (:39-40 comment: "NumberingService now lives in its own module
  (numbering.module.ts) so InvoicesModule/EstimatesModule can consume it without importing
  ImportModule" — `ImportModule` importing it too is called out explicitly in `numbering.module.ts`'s
  own docblock: "Still one service, one store — `ImportModule` imports this module too rather than
  keeping its own provider"). `NumberingService` is therefore already reachable at the MODULE
  level inside `ImportModule` — but `ImportService`'s own constructor (:35-39) does not inject it.

### 3.7 B277 — `estimates.service.ts` `create()` (:42-157), no P2002 catch on the ESTIMATE-number mint

`nextEstNumber` — ALREADY rewired by F16b (`85b7d53c`), no longer the inline scan B277's own row
cites (see the STALE-citation note in §0):

```ts
/**
 * The next `EST-<year>-####` number, from the SAME per-tenant-year primitive the
 * invoice series uses (fix-round-2.md D2). … Reserved in reserveNext's own
 * short transaction: a rollback after this call leaves a gap in the series.
 */
private async nextEstNumber() {                                          // :34-40
  const year = new Date().getFullYear();
  return this.numbering.reserveNext("ESTIMATE", {
    year,
    tenantId: this.prisma.getTenantId() ?? undefined,
  });
}
```

`create(dto)` (:42-157) — the write this row is actually about, still unguarded:

```ts
return this.prisma.forTenant().estimate.create({                         // :137-156
  data: {
    estimateNumber: await this.nextEstNumber(),
    customerId: dto.customerId,
    status: "DRAFT",
    …
    items: { create: itemsData },
  },
  include: { customer: { select: { id: true, businessName: true } }, items: true },
});
```

No `try`/`catch` anywhere in `create()` — confirmed by a full read of :42-157 and by
`grep -n P2002 estimates.service.ts` (see next paragraph: the only P2002 hits in the file belong
to a DIFFERENT method).

**Directly relevant sibling precedent, same file, same commit series**: `convertToInvoice(id)`
(:234-322) mints an INVOICE number (not an ESTIMATE number) via
`this.numbering.reserveNext("INVOICE", { year })` (:256) and DOES catch P2002 around its
`tx.invoice.create` (:283-320):

```ts
try {
  const inv = await tx.invoice.create({ data: { invoiceNumber, … } });
  return inv;
} catch (err: any) {
  // B100/F16b (REG-B100-F): had no P2002 catch — a concurrent convert's
  // unique-constraint hit propagated as a raw 500 (same message as the
  // sibling catches in invoices.service.ts).
  if (err?.code === "P2002")
    throw new ConflictException("Invoice number conflict — please retry.");
  throw err;
}
```

The comment tag `REG-B100-F` and the `estimates.service.spec.ts` test that pins it (§7.7) confirm
this exact defect class — "no P2002 catch on a mint site in this file" — was found and fixed ONCE
already in this file (on `convertToInvoice`) by the same F16b/B100 pass that filed B277 against
the OTHER mint site (`create()`) in the same file, one function away.

- **Unique constraint**: `Estimate` — `@@unique([tenantId, estimateNumber])` (`finance.prisma:580`).
- **`EstimatesService` DI**: already imports/injects `NumberingService` (:12, :19) — unlike every
  other sibling in this batch, no module-wiring change would be needed for a `create()` fix.
- **Other write methods in the file** (`findAll`, `findOne`, `send`, `accept`, `decline`,
  `voidEstimate`) do not mint a NEW `estimateNumber` — `grep -n
"nextEstNumber|estimate\.create|estimateNumber"` on the whole file shows exactly one call to
  `nextEstNumber()` (:139, inside `create()`) and one `estimate.create` call (:137) — B277's scope
  as filed (`create()` only) matches the file's actual mint-site count exactly.

---

## §4 — How F16b wired invoices/estimates; the DB-lane spec structure

### 4.1 `generateInvoiceNumber(tenantId?, tx?)` (`invoices.service.ts:2807-2835`)

```ts
/**
 * Generate the next invoice number via `NumberingService.reserveNext` — replaces
 * the former unscoped `prisma.invoice.findFirst` scan (B100/F16b, cause-ruling.md
 * §2 D2: that scan was both cross-tenant, :2778 `where` carried no `tenantId`, and
 * lexicographically wrong past 9999, :2779 `orderBy` sorted TEXT).
 *
 * `tx` is threaded in ONLY by a caller that is already inside a transaction (the
 * delivery path — routes stop completion → `recordDeliveryPaymentInTx` →
 * `createInvoiceFromOrder(orderId, tx)`): `reserveNext` then reserves on THAT
 * client, opening nothing, because a nested `$transaction` would need a second
 * pooled connection while this one is held and starves the pool under concurrent
 * mints (REG-B100-C). Such a caller holds the counter row lock until its own
 * commit — safe, since the office paths below reserve standalone and never hold
 * another row lock while holding the counter, so no lock-order cycle exists
 * (fix-round-2b.md D7).
 *
 * Omitted (every office path), `reserveNext` reserves in its OWN short transaction
 * and commits it before returning, so the caller's later transaction never holds
 * the `NumberingSequence` row lock (fix-round-2.md D1). The trade is explicit: a
 * rollback after this call leaves a gap in the series.
 *
 * `tenantId` is passed explicitly only on the fire-and-forget path that has no
 * request-context tenant (`createInvoiceFromOrderWithTenant`) — every other caller
 * relies on `NumberingService` resolving it from the request context as before.
 */
private async generateInvoiceNumber(tenantId?: string, tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return this.numbering.reserveNext("INVOICE", { year, tenantId, ...(tx ? { tx } : {}) });
}
```

Five call sites in `invoices.service.ts`: :274 (no args, standalone), :1258/:1262
(`generateInvoiceNumber(tenantId ?? undefined)` and `…(tenantId ?? undefined, tx)`), :2746
(standalone), and the docblock at :4462 references a fifth (`generateInvoiceNumber(tenantId, tx)`
per fix-round-2b.md D7 — the delivery path). `invoices.service.spec.ts:297-…` titles its own
coverage "REG-B100 pin P5 — generateInvoiceNumber delegates to NumberingService" and comments
"every one of the five mint sites (P5, …) — TODAY generateInvoiceNumber never touches
NumberingService at all" (pre-fix framing preserved in the spec's own history comment).

### 4.2 `EstimatesModule` wiring (reference pattern; contrast with §3's four un-wired modules)

```ts
// apps/api/src/estimates/estimates.module.ts
@Module({
  imports: [
    PrismaModule,
    EntitlementsModule,
    // B100/F16b: reserveNext("INVOICE", …) mints invoice numbers through the
    // shared NumberingService (used by convertToInvoice).
    NumberingModule,
  ],
  controllers: [EstimatesController],
  providers: [EstimatesService],
  exports: [EstimatesService],
})
export class EstimatesModule {}
```

`NumberingModule` itself (`apps/api/src/import/numbering.module.ts`):

```ts
/**
 * Extracted from `ImportModule` (B100/F16b, cause-ruling.md §2 D4) so
 * `InvoicesModule` and `EstimatesModule` can consume `NumberingService` without
 * importing `ImportModule` itself (which would risk a module cycle). Still one
 * service, one store — `ImportModule` imports this module too rather than
 * keeping its own provider.
 */
@Module({
  imports: [PrismaModule],
  providers: [NumberingService],
  exports: [NumberingService],
})
export class NumberingModule {}
```

### 4.3 The four existing P2002-to-409 sites in `invoices.service.ts` (the convention B277's row

points at)

All four use the identical message:

- :557-568 (inside `create()`'s catch, comment "RF-050: duplicate invoiceNumber under concurrent
  requests")
- :1321-1328
- :2774-2784 (comment references RF-026: "Previously, concurrent invoice creates both read the
  same last invoice number and one crashed with Prisma P2002 → HTTP 500. Now catches P2002 and
  returns 409 Conflict instead.")
- :4487-4501 (comment: "B100/F16b (REG-B100-E): duplicate() had no P2002 catch — a concurrent
  duplicate's unique-constraint hit propagated as a raw 500 instead of the 409 every other mint
  site already returns")

Pattern, identical at all four sites and at `estimates.service.ts`'s `convertToInvoice` (§3.7):

```ts
} catch (err: any) {
  if (err?.code === "P2002")
    throw new ConflictException("Invoice number conflict — please retry.");
  throw err;
}
```

The :4487-4501 comment shows this exact defect class (a mint site with no P2002 catch) was found
and fixed by B100/F16b at least twice already inside `invoices.service.ts` alone (`create()`
originally, then `duplicate()` as REG-B100-E) before this batch's B277 names the same class in
`estimates.service.ts`.

### 4.4 `invoice-numbering.db.spec.ts` — DB-lane structure (`apps/api/src/invoices/invoice-numbering.db.spec.ts`, 632 lines)

Header identifies it as "T1 — DB-lane repro for B100 (F16b invoice-number counter)," collected
only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`
(`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`), gated by
`requireLocalDatabaseUrl()` (refuses any non-local host).

Structure to copy:

- **Tenant seeding**: `freshTenantSlug(label)` → `assertTestTenant(\`qa-b100-${RUN_SUFFIX}-${tenantSeq}-${label}\`,
  "invoice-numbering.db.spec.ts")` (`RUN_SUFFIX = randomUUID().slice(0, 8)`, a per-file run
suffix); `seedTenant(label)`creates the`Tenant`row and pushes its id onto`createdTenantIds`.
- **Cleanup**: `afterAll` loops `createdTenantIds` and calls `cleanupTenant(tenantId)`
  (best-effort, `.catch(() => {})` per tenant so one failure doesn't mask the test's own
  pass/fail), which deletes in FK order: `Estimate → Invoice → OrderItem → Order →
NumberingSequence → Customer → User → Tenant` (comment in the code map's own version says
  "Estimate → Invoice → NumberingSequence → Customer → User → Tenant"; the actual function body
  also deletes `OrderItem`/`Order` between Invoice and NumberingSequence).
- **Helpers**: `seedCustomer`, `seedInvoice(tenantId, customerId, invoiceNumber)`,
  `seedNumberingSequence(tenantId, year, nextNumber)`, `numberingSequenceRow(tenantId, year)`,
  `mintInvoice(tenantId, customerId)` (drives the REAL public path,
  `tenantCtx.run(tenantId, () => invoicesService.create({...}))`); mirrored 1:1 for estimates:
  `seedEstimate`, `seedEstimateNumberingSequence`, `estimateNumberingSequenceRow`, `mintEstimate`.
- **Module setup**: real `PrismaService` bound to the compose DB, real `TenantContextService`,
  real `NumberingService`; every OTHER collaborator (`RouteFlowGateway`, `EmailService`,
  `InvoicePdfService`, `SystemConfigService`, `RegulatedLedgerService`,
  `AuthorizationGuardService`, `CreditNotesService`, `MessagingService`, `StorageService`,
  `EntitlementsService`, `CommissionEngineService`) mocked at the module boundary.
- **Self-contained-oracle discipline** (header, "the failure the RED-gate audit caught"): every
  test seeds every row its own expectation depends on, so its color never depends on a sibling
  test having run first or on what else lives in the compose DB; several tests (T1a, T1d, T1e)
  deliberately seed a SECOND, unrelated tenant with a much larger volume as a decoy so a
  cross-tenant leak can't accidentally produce the "right" number.
- **The one value-oracle-vs-throw discipline** (T1b, T1l): "a red run reports the wrong VALUE
  rather than only 'it threw'" — `mintError ? \`<threw ${ctor}: ${message}>\` : result.xNumber`collapses both outcomes into one string comparison rather than asserting only`.rejects`.

**T1l is the DB-lane test that already reproduces B277's exact failure mode** (comment,
verbatim): "Today nextEstNumber()'s `orderBy: { estimateNumber: "desc" }` is a TEXT sort, under
which "…-9999" sorts AFTER "…-10000" … so `last` is "…-9999", seq becomes 10000, and create()
tries to insert the ALREADY-TAKEN "…-10000" — colliding on the tenant-scoped
`@@unique([tenantId, estimateNumber])`. **create() has no P2002 catch (unlike convertToInvoice's),
so the raw Prisma error propagates.**" — this comment predates B277's filing and independently
names the identical gap. (Note: this comment was written when `nextEstNumber` was still the
inline TEXT-sort scan; per §3.7, `nextEstNumber` itself has since been rewired to
`reserveNext`, so T1l's premise about WHY a collision occurs has partly changed — but its
conclusion, "create() has no P2002 catch," is the part B277 is about and remains true today.)

### 4.5 `numbering.service.spec.ts` (`apps/api/src/import/numbering.service.spec.ts`) — unit-level, mocked Prisma

`describe` blocks: `format`, `parseDocumentNumber`, `getSettings`, `updateSettings`,
`seedFromSource`, `reserveNext — B100/F16b pins`. `getSettings`'s own test asserts
`settings.map(s => s.docType)` equals exactly `["INVOICE", "ESTIMATE", "CREDIT_NOTE", "PAYMENT"]`
(4 entries) — consistent with `DOCUMENT_NUMBER_TYPES` (§1.1) as it stands today, not stale.
`reserveNext` pins (P1/P2) cover: year-scoped padding/widening format, `year`-omitted fast path
(byte-identical to pre-B100), and (via a `withTx` helper that stubs `tenantTransaction`) the lazy
seed logging a specific tenant/year/max/next.

---

## §5 — Enum-value migration mechanics, Squawk, and CLAUDE.md's prod-migration flow

### 5.1 Is adding a `DocumentNumberType` member a migration? Yes — `ALTER TYPE … ADD VALUE`

The most recent migration touching this enum, `apps/api/prisma/migrations/20260908000000_campaign_schema_foundation/migration.sql`
(full statement block relevant here, verbatim, :1-13):

```sql
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentNumberType" ADD VALUE 'RETURN';
ALTER TYPE "DocumentNumberType" ADD VALUE 'ORDER';

-- DropIndex
DROP INDEX "NumberingSequence_tenantId_docType_key";
```

(The same migration file also carries the `NumberingSequence.year` column add and the new
`NumberingSequence_tenantId_docType_year_key` unique index — i.e., the RETURN/ORDER enum
additions and the year-scoping schema change landed together in ONE migration, not two.) This
migration is the newest one in the repo touching `DocumentNumberType`; the migration directly
after it chronologically, `20260910000000_order_idempotency/migration.sql`, does NOT reference
`DocumentNumberType` (`grep -n DocumentNumberType` on it: no match) — confirmed via
`ls apps/api/prisma/migrations` (last 4 non-lock entries: `20260905000000_customer_deposit_default`,
`20260907000000_route_planning_options`, `20260908000000_campaign_schema_foundation`,
`20260910000000_order_idempotency`).

No `IF NOT EXISTS`, no `BEFORE`/`AFTER` positional clause — a bare append.

### 5.2 Squawk's rules on `ALTER TYPE … ADD VALUE` (`apps/api/.squawk.toml`)

`pg_version = "17.0"`. The 9 rules KEPT active (the destructive gate — file header, :13-15):
`ban-drop-table, ban-drop-column, ban-drop-database, changing-column-type, adding-required-field,
renaming-column, renaming-table, ban-truncate-cascade, syntax-error`. None of the 9 targets an
enum `ADD VALUE` statement (it is not a drop, not a column-type change on an existing column, not
a new required field, not a rename). `require-enum-value-ordering` IS a Squawk rule that exists
for enum-value additions specifically, but it is in the `excluded_rules` list (:48) — i.e., not
enforced in this repo. `node apps/api/scripts/split-prisma-schema.mjs --check`'s structural
invariants (per CLAUDE.md, quoted below) auto-place an enum by which file "actually references
it" — there is no `MODEL_DOMAIN`-style manual map entry required for an enum member addition
(the map is for MODELS); `DocumentNumberType` already lives in `platform.prisma` and gains no new
member's home to resolve, since it isn't moving files.

### 5.3 CLAUDE.md's prod-migration flow (quoted verbatim, this worktree's `CLAUDE.md`)

> "Schema changes apply to prod **only** via `railway run --service postgres node
apps/api/scripts/prod-migrate.mjs` (a bare `prisma migrate deploy` only resolves the schema
> folder + `prisma.config.ts` when run from `apps/api` — cwd-relative — so this script `cd`s
> there internally instead of relying on the caller's cwd); locally `npx prisma migrate dev`
> against docker-compose."
>
> "**Never** `--force-reset`; **never** run the destructive scripts listed in
> `CLAUDE_SESSION_PREAMBLE.md`; seed additively."
>
> "Destructive migrations are blocked in CI by Squawk (`npm run lint:migrations`); whitelist a
> statement with `-- reason:` + `-- squawk-ignore <rule>`."

And on the schema-folder structure itself:

> "**The Prisma schema is a FOLDER, not a file** (item 10a):
> `apps/api/prisma/schema/{_base,tenancy,catalog,sales,finance,platform,compliance}.prisma`,
> pointed at by `prisma.config.ts` (`schema: prisma/schema`, explicit `migrations.path:
prisma/migrations`). Add a model to the domain file it belongs to **and** to the
> `MODEL_DOMAIN` map in `apps/api/scripts/split-prisma-schema.mjs` — an unmapped model fails
> `node apps/api/scripts/split-prisma-schema.mjs --check` (there is no "misc" bucket). `--check`
> ALWAYS enforces the structural invariants (file set, `_base` holds only datasource+generator,
> unique names, every model where the map says, **every enum in a file that actually references
> it**) with **no original file needed**."

And the canonical deploy flow's schema-change step (step 1 of 5):

> "1. **(schema change only)** apply the prod migration first — fresh backup, then `railway run
--service postgres node apps/api/scripts/prod-migrate.mjs`."

`npm run db:drift -w apps/api` (`apps/api/scripts/schema-drift.mjs`) is CLAUDE.md's stated
post-migration drift gate ("Any schema PR runs it against prod after deploy … and requires exit
0").

---

## §6 — `git log -3` per sibling file (current master)

```
credit-notes.service.ts:
  151c3f70 2026-09-06 fix(api,web,mobile): credit-note wallet integrity (f09 b66 b67 b18 b19) (#636)
  22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  ea8a7479 2026-08-25 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)

import.service.ts:
  22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  b82ec14f 2026-08-31 fix(import): comma money, payment dedupe, BOM, connector gate (F17) (#566)
  de557140 2026-08-22 feat(payments): add Zelle, share method constants, surface customer price tier (#408)

invoices.service.ts:
  85b7d53c 2026-09-08 fix(api): tenant-scoped per-year invoice numbering through NumberingService (#671)
  4d977168 2026-09-07 fix(api,web): kpi awaiting-confirmation basis; spec 37 token (#659)
  e02851af 2026-09-07 fix(api,web,mobile): list caps, pagination and date windows (f16) (#656)

vendor-bills.service.ts:
  22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  5cb71545 2026-08-29 feat(api): wire AI usage metering; unify Anthropic key resolution (#475)
  ea8a7479 2026-08-25 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)

inventory.service.ts:
  22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  ea8a7479 2026-08-25 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)
  5e6de142 2026-08-25 fix(inventory): coerce page/limit on purchase-orders list query (#441)

commission-statements.service.ts:
  85b7d53c 2026-09-08 fix(api): tenant-scoped per-year invoice numbering through NumberingService (#671)
  22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  e460b3f8 2026-08-23 feat(sales-agents): agent records, commission ledger, statements engine (#421)

estimates.service.ts:
  85b7d53c 2026-09-08 fix(api): tenant-scoped per-year invoice numbering through NumberingService (#671)
  22372911 2026-09-04 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
  7e49b993 2026-08-23 feat(invoices): MSRP on invoices — display-only suggested retail, flag-gated (#411)

numbering.service.ts:
  85b7d53c 2026-09-08 fix(api): tenant-scoped per-year invoice numbering through NumberingService (#671)
  e7eb1627 2026-08-31 feat(db): campaign schema foundation F01 (migration 20260908) (#548)
  dba30e06 2026-07-08 feat(import): numbering-sequence continuity + service (phase 1) (#135)
```

`85b7d53c` (2026-09-08, #671, "fix(api): tenant-scoped per-year invoice numbering through
NumberingService") is the F16b/B100 commit itself — it touched `invoices.service.ts`,
`commission-statements.service.ts` (comment-only: the "Same max+1 scan class as B100" doc comment
at nextStatementNumber, §3.4), `estimates.service.ts` (the `nextEstNumber`→`reserveNext` rewrite

- the `convertToInvoice` P2002 catch), and `numbering.service.ts` itself. It did NOT touch
  `credit-notes.service.ts`, `vendor-bills.service.ts`, or `inventory.service.ts` — none of B267/
  B270/B271's files were part of the F16b commit; the commission-statements.service.ts touch was
  annotation-only (the generator itself, :68-77, is unchanged code, only the doc comment was added).

---

## §7 — Existing tests around each generator

### 7.1 `credit-notes.service.spec.ts` (B267)

`prisma.creditNote.findFirst.mockResolvedValue(null); // nextCnNumber → CN-…-0001` (:37) — the
ONLY place the mock is set for this method; every other reference (`:291,341,383,400,411,484,495`
and the `releaseInvoiceCreditsInTx`-adjacent block `:637-816`) is a hardcoded fixture
`creditNoteNumber: "CN-2026-00NN"` used as pre-existing data for unrelated assertions (wallet/
release logic), not a test of the mint path itself. No test drives the 9999-wall / lexicographic
sort, and no test drives a cross-tenant / null-tenant scenario for `nextCnNumber`.

### 7.2 `vendor-bills.service.spec.ts` (B270)

Same shape: `prisma.vendorBill.findFirst.mockResolvedValue(null); // nextBillNumber` at :567 and
:680 (mint-from-empty only); every other `billNumber` reference is a hardcoded fixture
(`"BILL-2026-0001"`, `"BILL-2026-0009"`, `"BILL-2026-0003"`) used for downstream assertions. No
9999-wall test.

### 7.3 `inventory.service.spec.ts` (B271)

Exactly one `poNumber` reference in the whole file: `poNumber: "PO-1001"` (:220), a fixture for an
unrelated assertion — no test at all exercises `nextPoNumber()`'s own mint behavior, wall or
otherwise.

### 7.4 `commission-statements.service.spec.ts` (B272)

Comment at :65: "Default: no PENDING statement, no prior CST-#### number, nothing to sweep" — the
mint-from-empty default; every other `statementNumber` reference (`:77,160,190,333,347,363,400`)
is the same hardcoded `"CST-2026-0001"` fixture reused across unrelated assertions. No wall test,
no cross-tenant test.

### 7.5 `import.service.ts` fallback mint (B268) — zero coverage

`Glob **/import*.spec.ts` under `apps/api/src` returns three files:
`import-customer-cap.spec.ts`, `import-robustness.spec.ts`, `import.security.spec.ts`. A
targeted grep for the mint pattern (`seq\+\+|INV-\$\{year\}|padStart\(4, ?"0"\)|fallback.*invoiceNumber`)
across `apps/api/src/import/` matches only `numbering.service.ts` (the source file itself,
coincidental `padStart` usage inside `format()`) and `numbering.service.spec.ts` (same,
`format()`'s own unit tests) — NOT any of the three import spec files. `import-robustness.spec.ts`'s
`describe`/`it` list (grepped in full) is entirely REG-B98 (money parsing), REG-B99 (payment
dedupe), and REG-B112 (BOM) — none exercise `importInvoices`'s fallback `invoiceNumber` synthesis
at all, whether via the happy path or the collision path.

### 7.6 `numbering.service.spec.ts` — the shared primitive's own unit coverage

Covers `format`, `parseDocumentNumber`, `getSettings`, `updateSettings`, `seedFromSource`, and
`reserveNext` (P1/P2 pins: year-scoped format/widening, year-omitted fast path, lazy-seed
logging) against a mocked `PrismaService` (`createMockPrisma()`). Does not exercise `reserveNext`
for any docType other than `"INVOICE"` in the visible P1/P2 block (§4.5) — no test here drives
`reserveNext("CREDIT_NOTE" | "PAYMENT", …)`.

### 7.7 `estimates.service.spec.ts` (B277)

Line 141-163, `describe` block containing `convertToInvoice`'s tests: a test titled "REG-B100-F:
maps a concurrent convert's P2002 into ConflictException (409), not a raw 500" with the comment
"TODAY this rejects with the plain `{ code: "P2002" }` object, not a ConflictException" — this
pins `convertToInvoice`'s P2002 handling (§3.7), a DIFFERENT method/mint site than `create()`.
No test in this file drives `create()`'s `estimate.create()` call into a P2002 at all — a targeted
read of the file found no `it(...)` block whose setup calls `service.create(...)` with
`prisma.estimate.create` (or `forTenant().estimate.create`) mocked to reject.

### 7.8 DB lane (`invoice-numbering.db.spec.ts`) — see §4.4 for full structure

T1l is titled "REG-B100-EST-B the 9999 wall for estimates" and asserts
`estimate?.estimateNumber` equals `EST-<year>-10001` after seeding `…-9999` and `…-10000` — its
comment explicitly states create() has no P2002 catch (quoted in full in §4.4). This is a repro
for the WALL (via `nextEstNumber`, now `reserveNext`), and its comment separately NAMES the
missing-catch gap, but the test's own value oracle is the wall behavior, not a standalone
P2002-catch pin — it does not, by itself, assert on exception TYPE the way T1a2/REG-B100-F-style
tests elsewhere in this batch do.

---

## §8 — Lessons register entries cited by this batch, plus a migration/enum scan

`.claude/lessons/LESSONS.md` (this worktree), quoted in full:

### L-072 · 2026-09-03 · domain · wave E `imp-10b`

> - **Symptom:** 4 hand-typed client mirrors of Prisma enums drifted from the schema (invented,
>   renamed, or omitted values); one hid a real action and broke a list filter.
> - **Root cause:** each mirror was an independently hand-typed string union — TS never compares
>   two such unions to each other, so the drift compiled clean and stayed invisible.
> - **Lesson:** **Never hand-declare a client mirror of a server (Prisma) enum — derive one
>   const-array union per enum from a shared package and pin it set-equal to `Object.values()` of
>   the real enum in a spec, never against a second hand-typed "expected" list.**
> - **Guard:** `apps/api/src/common/enum-parity.spec.ts` — a generic table (40 enums) against
>   `packages/types/api/enums.ts`, plus a regression layer pinning the drifted files and the
>   mobile [mirror].

(B269's row cites this lesson by analogy — "the same hand-copied-mirror-drift mechanism L-072
names for enums, here applied to a number format instead of one shared formatter" — L-072 itself
is about `packages/types/api/enums.ts` client mirrors, a different mechanism than B269's three
inline `PAY-` format strings; both share the "hand-copied instead of one shared source" shape.)

### L-081 · 2026-09-06 · domain · F09

> - **Symptom:** wallet credit kept being consumed by WRITTEN_OFF (forgiven) invoices after the
>   settle query had excluded VOID, and a fix at that query would still have missed the second
>   door — the auto-apply path `send()`/`sendEmail()` reach — while a test whose mock injects the
>   query result could not even see a `where`-only fix.
> - **Root cause:** the guard lived at one call site's query instead of at the money write; four
>   hand-rolled status lists (manual apply, settle, delivery payments, the advance wallet) had
>   drifted apart, and PAID had to stay in the settle set because the same loop shrinks excess
>   credit.
> - **Lesson:** **gate a money write inside the primitive that performs it, on the row it just
>   read (an exclude-list, so a fixture without the field still writes) — sibling primitives and
>   result-injecting mocks bypass a where-only fix; and keep every status set in one named module
>   with the reason each differs written beside it.**
> - **Guard:** REG-B67 T1/T2/T5 (apply-side, incl. the auto-apply door) and REG-B66 T6/T7/T9–T11
>   [...]

(Cited by `invoice-numbering.db.spec.ts`'s own header as "L-081, 'all five mint sites move
together'" — the design principle that every mint site sharing one namespace/primitive must move
onto the shared primitive together, not one at a time, which is this whole batch's organizing
premise.)

### L-096 · 2026-09-08 · domain · #671

> - **Symptom:** F16's design of record specified a new `InvoiceCounter` table; S2 found the
>   per-tenant, per-year `NumberingSequence` + `NumberingService` already shipped (a code comment
>   naming B100), so building the table would have created a second numbering store.
> - **Root cause:** the design was written from the bug report, not from the schema.
> - **Lesson:** **Before designing any new store/counter/registry, grep the schema folder and the
>   modules for the dimension you need — an existing primitive with a gap (here, an unused `year`
>   column) beats a new table every time.**
> - **Guard:** the bug-pipeline S2 refutation step now asks "does the primitive already exist?"
>   explicitly.

### L-097 · 2026-09-08 · process · #671

> - **Symptom:** B245 was discharged with proof `REG-B245` while its pin tests were titled plain
>   `B245: …` — the token lived in the registry but not in the test file.
> - **Root cause:** `prove`'s `--proof` regex checks the claim text only; nothing cross-checks a
>   discharge token against the titles of the file it claims to pin.
> - **Lesson:** **A discharge proof token must match its test titles byte-for-byte — run
>   `node scripts/campaign-check.mjs`, not just `bugs.mjs sync --check`, before merging a docs
>   follow-up by rule.**
> - **Guard:** campaign-check's exact-prefix rule (already enforced) + this step in the follow-up
>   checklist.

### Migration/enum scan beyond the four cited lessons

`grep -in "migration|enum|ADD VALUE|Squawk|squawk"` across the full `LESSONS.md` returns matches
only inside L-072 (quoted above in full) and one unrelated line (:407, "`local:test:db` runs on
`apps/api/src/prisma/**` PRs (`db-migrations.yml` paths)", inside a different lesson about a
Prisma client-extension composition bug, L-059-adjacent — not about authoring an enum-value
migration). No lesson in the register specifically addresses `ALTER TYPE … ADD VALUE` mechanics,
Squawk's enum rules, or the prod-migration script beyond what CLAUDE.md itself states (§5.3).

---

## Facts the ruling needs

- B267/B272 both route through `this.prisma.tenantTransaction(...)`, whose `tenantTransaction`
  (`prisma.service.ts:48-63`) returns the RAW unwrapped client (`fn(rawTx)`) whenever
  `getTenantId()` is falsy — confirmed by reading the method; this is the exact mechanism both
  rows' cause claims name.
- `isYearScoped()`/`YearScopedDocType` (`numbering.service.ts:36-39`) and the type signatures of
  `findTaken`/`scanMaxForYear` (:373-382, :399-420) are hard-limited to `"INVOICE"|"ESTIMATE"` —
  routing CREDIT_NOTE (or any other docType) through the SAME year-scoped/collision-guarded path
  invoices/estimates use is not just a call-site change; it needs `YearScopedDocType` widened and
  `findTaken`/`scanMaxForYear` taught the `CreditNote` table/column, or CREDIT_NOTE stays on the
  un-guarded "Fast path" (no lazy seed, no collision check against existing `CN-<year>-*` rows).
- `InvoicePayment.paymentNumber` is `String? @unique` — a GLOBAL (not tenant-scoped) constraint
  (`finance.prisma:315`); B269's third site omitting `tenantShort` is a same-value-across-tenants
  COLLISION risk on that global index, not only a cosmetic format mismatch — the code comment at
  `invoices.service.ts:4744-4745` states this is exactly why the hash exists on the other two sites.
- None of `DocumentNumberType`'s 6 members is `BILL`, `PO`/`PURCHASE_ORDER`, or
  `COMMISSION_STATEMENT` (`platform.prisma:473-482`, confirmed exhaustively) — B270, B271, and
  B272 each need a NEW enum member (a migration, §5.1) before any `reserveNext` call is possible,
  unlike B267/B269 (CREDIT_NOTE/PAYMENT already exist in the enum and in `DEFAULTS`).
- Adding an enum member is `ALTER TYPE "DocumentNumberType" ADD VALUE '<X>';` — confirmed exact
  syntax from the most recent such migration (§5.1); none of Squawk's 9 actively-kept rules
  targets it, and its own `require-enum-value-ordering` rule is excluded/unenforced (§5.2) — so
  authoring one is not blocked by CI's destructive-migration gate.
- `credit-notes.module.ts`, `vendor-bills.module.ts`, `inventory.module.ts`, and
  `commissions.module.ts` do not import `NumberingModule` today (confirmed by grep on all four);
  `estimates.module.ts` already does (reference pattern, §4.2); `ImportModule` already imports
  `NumberingModule` transitively but `ImportService`'s constructor does not inject
  `NumberingService` (§3.6) — so B268's DI gap is one constructor param, not a module-graph change.
- `estimates.service.ts`'s OWN `convertToInvoice` (§3.7) already carries the exact P2002→409
  pattern B277 asks for on its ESTIMATE-mint sibling `create()` — same file, same commit series
  (`85b7d53c`), tagged `REG-B100-F`, with an existing spec pin (`estimates.service.spec.ts:141-163`)
  — the most directly copyable precedent in the batch.
- `invoices.service.ts` has FOUR existing P2002→409 sites (§4.3) using byte-identical
  `ConflictException("Invoice number conflict — please retry.")` phrasing — the established
  house convention this batch's several missing-catch generators (§3.1, §3.2, §3.3, §3.4 all
  independently confirmed to have ZERO P2002 handling, not only the one B277 names) could match.
- B277's own registry-row citation (`nextEstNumber` at :15-24 as still-broken) is STALE against
  current master: `nextEstNumber` was already rewired to `numbering.reserveNext("ESTIMATE", …)`
  by `85b7d53c` (§0 note, §3.7) — B277's actual defect (`create()`'s missing P2002 catch, now at
  :137-156) is unaffected by that rewrite and independently reconfirmed at current line numbers.
- B269's row cites line numbers (:4683/:4979/:5282) that do not match current master
  (:4753/:5049/:5352 respectively) — the code and defect shape both independently reconfirm, only
  the line numbers have drifted (file grew between when the row was filed and this brief).
- `invoice-numbering.db.spec.ts`'s T1l (§4.4/§7.8) already comments "create() has no P2002 catch
  (unlike convertToInvoice's)" for estimates — written before B277 was filed, independently
  naming the same gap; it is a wall-value oracle, not a standalone exception-type pin, so it does
  not currently fail specifically ON the missing catch (it fails on the wrong VALUE regardless).
- Zero existing test (unit or DB-lane) exercises `import.service.ts`'s fallback `seq`-based
  invoiceNumber mint (B268) at all, in any spec file under `apps/api/src/import/` — confirmed by
  targeted grep and by reading `import-robustness.spec.ts`'s full `describe`/`it` list (entirely
  REG-B98/B99/B112, unrelated bug classes).
- Every one of B267/B270/B271/B272's mint helpers (`nextCnNumber`, `nextBillNumber`,
  `nextPoNumber`, `nextStatementNumber`) is a near-identical hand-copy of the same three-line
  shape (`findFirst` + `orderBy desc` on the formatted string + `parseInt(...split("-")[2])+1` +
  `padStart(4,"0")`) — each spec file's coverage of it is limited to a single `mockResolvedValue(null)`
  "mint from empty" case (§7.1-7.4); none has a 9999-wall or cross-tenant test today.

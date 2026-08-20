# Plan: PR-F — AI supplier-statement reconciliation, one review screen

> Authored by Fable 5 on 2026-08-20. Status: APPROVED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

A supplier sends a monthly statement — a list of invoices, payments and credits
with a closing balance. Reconciling it by hand against our own bills is slow and
error-prone, and the usual outcome is that old bills quietly stay "unpaid" in our
books forever. Let the operator upload (or photograph) the statement, have a model
read it, match its lines against our vendor bills **deterministically in code**,
and land everything on **one review screen** where a single explicit Apply commits
the result.

**Carries migration #3** (additive only). Builds on PR-E's payment allocation.

**The system never silently guesses about money: the model proposes, the operator
disposes.** Nothing is applied without an explicit confirmation, and bulk-marking
old bills paid always gets its own second confirmation listing every bill.

## Constraints & conventions

- **Stack**: NestJS 11 + Prisma 7 (`apps/api`), Next.js 14 App Router (`apps/web`),
  Expo/RN (`apps/mobile`). Jest for api/mobile; mobile tests pure-logic only.
- **Prettier**: semicolons, double quotes, `printWidth` 100, trailing commas.
- **Money**: `roundMoney` (2dp), epsilon `0.001`. Never a second rounding path.
- **Tenancy**: `forTenant()`; nested creates bypass tenant injection.
- **Migration**: additive only; generate SQL with
  `npx prisma migrate diff --from-schema <old> --to-schema <new> --script`
  (no local Postgres available). CI replays the history against a fresh Postgres —
  that is the gate. Never `migrate dev` against production.
- **No new dependencies.** The `@anthropic-ai/sdk` is already a dependency and
  already used by the invoice scanner.
- **This PR is web-first.** A dense reconciliation table earns a desktop; mobile
  reads the result and can upload/capture, but does not host the review grid.

### What to reuse (recon-verified — copy these, do not reinvent)

The invoice scanner is the architectural template. Mirror it closely.

- **Model call** (`vendor-bills.service.ts` ~1335-1386):
  `new Anthropic({ apiKey, maxRetries: 0 })` — **`maxRetries: 0` is required** so the
  `{ timeout: 110_000 }` second argument is a real ceiling; SDK default retries would
  each get a fresh 110s window and blow past the web client's 120s axios timeout.
  Single user turn, no system prompt, no streaming, `max_tokens: 4096`.
- **API key**: `await this.systemConfig.get("anthropic.apiKey")` (tenant-scoped via
  `forTenant()`, AES-256-GCM encrypted at rest — `"anthropic.apiKey"` is in
  `SECRET_KEYS`) with an `ANTHROPIC_API_KEY` env fallback. Missing key ⇒ plain
  `BadRequestException` with **no** `code`.
- **Typed error contract** (`vendor-bills.service.ts` ~1387-1440) — reproduce exactly:
  | condition | exception | `code` |
  |---|---|---|
  | 401/403 from Anthropic | `BadRequestException` | `AI_KEY_INVALID` |
  | non-retryable 4xx except 429 | `BadRequestException` | `AI_SCAN_REJECTED` |
  | 429 / 5xx / network | `ServiceUnavailableException` (503) | `AI_UNAVAILABLE` |
  | non-text block, or `JSON.parse` throws | `UnprocessableEntityException` (422) | `AI_PARSE_FAILED` |
  ⚠️ **The web client only special-cases `AI_KEY_INVALID` today**
  (`ScanInvoiceModal.tsx` ~703-728) — the other three fall through to a raw message.
  The new review screen must branch on all four (notably: offer **Retry** only for
  `AI_UNAVAILABLE`).
- **File attachment** (~1282-1323): PDFs as
  `{type:"document", source:{type:"base64", media_type:"application/pdf", data}}`;
  HEIC/HEIF converted server-side via `sharp(buf).rotate().jpeg({quality:85})` **before**
  attaching, with a per-page conversion failure pushed to `skippedPages` and disclosed
  in `notes` rather than failing the whole upload; jpeg/png/gif/webp attached as-is.
  (`RENDERABLE_INLINE_MIMES` in `uploads.controller.ts` is about `Content-Disposition`
  on the serving endpoint — **unrelated**, do not confuse them.)
- **Dedup + fingerprints**: `hashFile(buffers)` (sha256 over concatenated bytes in
  upload order) from `apps/api/src/vendor-bills/invoice-scan.fingerprint.ts`.
- **Matching**: `DuplicateMatchService` (`apps/api/src/import/duplicate-match.service.ts`)
  exports `normalizeNumber(raw)` and layered matchers; `findVendorBillDuplicate`
  (~177-219) is the exact layering to mirror. Wire it in by importing
  **`DuplicateMatchModule`** directly — it exists as a standalone module specifically
  to avoid the `ImportModule ↔ VendorBillsModule` cycle. Do not import either of those.
- **`VendorBill.supplierInvoiceNumber`** is stored **normalized** (uppercase,
  whitespace stripped, via `normalizeNumber`), is **not** unique, and is indexed as
  `@@index([tenantId, supplierInvoiceNumber])`. Exact-match lookups must filter
  `{ tenantId, supplierInvoiceNumber: normalizeNumber(x), status: { not: "VOID" } }`
  to hit that index — mirror the query shape at ~191-200.
- **Eligibility/arithmetic**: a bill's outstanding amount is `totalOwed − totalPaid`.
  **Never** derive it from `VendorBillStatus`, which is overloaded (`PARTIAL` means
  either short-received or part-paid).
- **UI conventions**: `ScanInvoiceModal.tsx` is a 3-step wizard
  (`"upload" | "processing" | "review"`) with a concurrency-limited worker pool,
  per-item `AbortController`, and per-item retry that doesn't disturb siblings.
  `BatchItemReviewModal.tsx` enforces explicit per-line resolution before allowing
  apply — that gate is the pattern to copy. Multi-row modals hand-roll a
  `max-w-2xl`+ overlay because the shared `Modal` is capped at `max-w-lg`.

## Work packages

File lists are DISJOINT.

### WP1 — Migration #3 + `SupplierStatementScan` model

- **files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260822000000_add_supplier_statement_scan/migration.sql`
- **brief:** One additive model + one enum, mirroring `InvoiceScan`'s shape
  (`schema.prisma` ~2310) so the two pipelines read alike:

  ```prisma
  enum SupplierStatementScanStatus {
    SCANNED
    APPLIED
    DISCARDED
  }

  /// A parsed supplier statement awaiting reconciliation. Mirrors InvoiceScan:
  /// fileHash dedups a re-upload without re-calling the model, extractedPayload
  /// keeps the model's verbatim output for audit, and status records whether the
  /// operator applied it.
  model SupplierStatementScan {
    id               String   @id @default(uuid())
    tenantId         String?
    fileKey          String?
    fileName         String?
    mimeType         String?
    byteSize         Int?
    pageCount        Int?
    fileHash         String
    extractedPayload Json
    model            String?
    scanDurationMs   Int?
    supplierNameRaw  String?
    supplierId       String?
    periodStart      DateTime?
    periodEnd        DateTime?
    openingBalance   Decimal? @db.Decimal(12, 2)
    closingBalance   Decimal? @db.Decimal(12, 2)
    lineCount        Int?
    status           SupplierStatementScanStatus @default(SCANNED)
    /// Set once applied — the paymentGroupId of the payments this scan wrote,
    /// so the whole apply can be traced (and undone by voiding that group).
    appliedPaymentGroupId String?
    appliedAt        DateTime?
    appliedById      String?
    scannedById      String?
    createdAt        DateTime @default(now())
    updatedAt        DateTime @updatedAt

    tenant   Tenant?   @relation(fields: [tenantId], references: [id])
    supplier Supplier? @relation(fields: [supplierId], references: [id])

    @@index([tenantId, fileHash])
    @@index([tenantId, supplierId])
    @@index([tenantId, status])
  }
  ```

  Add back-relations on `Tenant` and `Supplier`. Confirm the generated SQL has no
  `DROP` and no data migration.

### WP2 — API: parse (model call) + deterministic matcher

- **files:** `apps/api/src/supplier-statements/supplier-statements.service.ts`, `apps/api/src/supplier-statements/supplier-statements.controller.ts`, `apps/api/src/supplier-statements/supplier-statements.module.ts`, `apps/api/src/supplier-statements/statement-matcher.ts`, `apps/api/src/supplier-statements/dto/statement.dto.ts`, `apps/api/src/supplier-statements/statement-matcher.spec.ts`, `apps/api/src/supplier-statements/supplier-statements.service.spec.ts`
- **brief:** A new module (imports `PrismaModule`, `SystemConfigModule`,
  **`DuplicateMatchModule`**, and `VendorBillsModule` only if genuinely needed for
  payment writing — prefer duplicating the tiny payment call over creating a cycle).

  **Parsing** (`scanStatement(files, scannedById)`), mirroring `scanInvoice`:
  1. `hashFile(buffers)` → if a non-DISCARDED `SupplierStatementScan` with that hash
     exists, **return it without calling the model** (same short-circuit as the
     invoice scanner).
  2. Resolve the API key and build content blocks exactly as the invoice scanner
     does (including the HEIC→JPEG conversion and `skippedPages` disclosure).
  3. Use a **dedicated model constant**:
     ```ts
     // Statements are far more variable than invoices — many suppliers, many
     // layouts, and a misread here moves money. Worth a more capable model than
     // the invoice scanner's; kept as its own constant so the two can diverge.
     const STATEMENT_MODEL = "claude-sonnet-5";
     ```
     Persist it onto the row's `model` field. Keep `maxRetries: 0` and the 110s
     timeout.
  4. Requested JSON contract (instruct "return JSON only", handle multi-page
     combination like the invoice prompt does):
     ```
     { supplier, periodStart: "YYYY-MM-DD", periodEnd: "YYYY-MM-DD",
       openingBalance, closingBalance,
       lines: [{ date: "YYYY-MM-DD", kind: "INVOICE"|"PAYMENT"|"CREDIT"|"ADJUSTMENT",
                 refNumber, amount, runningBalance }],
       notes }
     ```
     Strip ```json fences and fall back to a `{...}`regex extraction before`JSON.parse`, exactly as the invoice parser does.
  5. Reproduce the four typed error codes verbatim (table above).

  **Matching** (`statement-matcher.ts`) — **pure, deterministic, no model
  involvement**, so it is auditable and testable:

  ```ts
  export type MatchTier = "EXACT_REF" | "FUZZY" | "UNMATCHED";
  export interface StatementLineMatch {
    line: ParsedStatementLine;
    tier: MatchTier;
    billId: string | null;
    candidates: { billId: string; billNumber: string; total: number; date: string | null }[];
    /** Only an EXACT_REF match whose amount also agrees is pre-checked. */
    preChecked: boolean;
  }
  ```

  Tiers, in order:
  1. **`EXACT_REF`** — `normalizeNumber(line.refNumber)` equals a bill's
     `supplierInvoiceNumber` (scoped to the supplier, `status: { not: "VOID" }`).
     `preChecked` is true **only if** the amount also matches within `0.005`;
     an exact ref with a differing amount is `EXACT_REF` but **not** pre-checked.
  2. **`FUZZY`** — amount within `0.005` AND date within ±1 day, borrowing
     `findVendorBillDuplicate`'s layering. Never pre-checked; always needs a look.
  3. **`UNMATCHED`** — everything else.
     A bill may be a candidate for at most one line: resolve collisions by preferring
     the higher tier, then the closer amount, then the closer date, deterministically.

  **Sanity guard** (money-critical):

  ```ts
  // If the parsed lines don't reconcile to the statement's own closing balance,
  // the read is suspect — demote EVERYTHING to "needs a look" rather than
  // pre-checking rows we can't trust. The model proposes; it never auto-applies.
  const linesAgree =
    closingBalance == null ||
    Math.abs(roundMoney(openingBalance ?? 0) + sumSigned(lines) - roundMoney(closingBalance)) <=
      0.01;
  if (!linesAgree) matches.forEach((m) => (m.preChecked = false));
  ```

- **specs:** `statement-matcher.spec.ts` (pure, thorough): exact-ref match
  pre-checks; exact ref with a mismatched amount matches but does NOT pre-check;
  fuzzy within window matches un-pre-checked; outside window is unmatched; a VOID
  bill is never a candidate; two lines cannot claim the same bill; the
  closing-balance mismatch demotes every pre-check.
  `supplier-statements.service.spec.ts`: fileHash short-circuit skips the model
  call; each of the four error codes is produced for its condition.

### WP3 — API: the apply transaction

- **files:** `apps/api/src/supplier-statements/statement-apply.service.ts`, `apps/api/src/supplier-statements/statement-apply.spec.ts`
- **brief:** `applyStatement(scanId, dto, user)` — ONE `tenantTransaction`,
  idempotent, that writes payments for the confirmed matches using **PR-E's supplier
  payment mechanics** (one `BillPayment` per bill, all sharing one `paymentGroupId`,
  statuses recomputed, surplus → `SupplierCredit`).
  - **Idempotency**: if the scan is already `APPLIED`, return its stored
    `appliedPaymentGroupId` and change nothing (mirrors the stock-count reference
    guard).
  - `dto` carries only what the operator confirmed:
    `{ confirmed: { billId, amount }[], impliedPaid?: { billIds: string[] }, notes? }`.
  - **A statement can never create payments above its own stated amounts** — validate
    each confirmed amount against both the matched statement line and the bill's
    outstanding balance, and reject the whole apply on violation.
  - Never pay a VOID bill.
  - Record `appliedPaymentGroupId`, `appliedAt`, `appliedById`, and flip status to
    `APPLIED`. Everything the apply did must be reconstructable from the scan row +
    that payment group (undo = void the group).
  - **`impliedPaid` is a SEPARATE input** and must be validated separately (see the
    review screen's separate panel) — it is not folded into `confirmed`.
- **specs:** applying twice writes once (idempotent); a confirmed amount exceeding
  the statement line or the bill balance rejects the whole transaction and writes
  nothing; surplus becomes `SupplierCredit`; the payment group ties every written row
  together.

### WP4 — web: the one review screen

- **files:** `apps/web/app/(dashboard)/finance/statements/page.tsx`, `apps/web/components/StatementReviewGrid.tsx`, `apps/web/lib/api/supplier-statements.ts`
- **brief:** Upload/capture → processing → **one review screen** with four sections
  plus a separate panel, following `ScanInvoiceModal`'s 3-step wizard shape and
  `BatchItemReviewModal`'s "resolve everything before apply" gate:
  1. **Matched** (exact ref + amount) — pre-checked rows, statement line ↔ our bill
     side by side with both amounts.
  2. **Needs a look** (fuzzy, or exact-ref-with-amount-mismatch) — flagged, with a
     candidate picker per line.
  3. **Unmatched statement lines** — we have no bill; offers "create bill from line".
  4. **Unmatched local bills** — the statement doesn't mention them (read-only
     awareness; no action).
  5. **Implied-paid proposal — its own panel, its own checkbox, its own second
     confirmation.** When the statement's opening balance accounts for recent bills
     while older local bills predate the period and are still unpaid, list every such
     bill with a summed total: _"This statement implies these 23 older bills
     (Jan–Jun, $18,240.90) were settled. Mark them paid?"_ **Never bundle this into
     the main Apply**, and always show the full list of affected bills in the second
     confirmation.
  - **Error handling**: branch on all four typed codes; show **Retry** only for
    `AI_UNAVAILABLE`; for `AI_KEY_INVALID` link to the Anthropic settings page
    (`/settings` → Anthropic section) as `ScanInvoiceModal` does.
  - After apply, the scan's detail view lists everything the apply did, with a link
    to the payment group.

### WP5 — mobile: capture + read the result

- **files:** `apps/mobile/app/(operator)/statements/index.tsx`, `apps/mobile/lib/api/supplier-statements.ts`
- **brief:** Mobile can **upload or photograph** a statement (reuse the existing
  camera/file pickers used by the invoice scanner) and can **read** a scan's status
  and applied result. It does **not** host the review grid — a dense reconciliation
  table earns a desktop, and the plan's design stance is explicit about that. After
  capture, show "Ready to review on the web dashboard" with the scan's summary.
  Keep it small; no pure-logic module is needed unless you add real logic, in which
  case test it.

## Acceptance criteria

1. Migration #3 is additive only; CI's migrate-deploy replays the history clean.
2. Re-uploading the same file (same `fileHash`) returns the prior scan **without**
   calling the model.
3. All four AI error codes are produced for their exact conditions, and the review
   screen branches on all four (Retry offered only for `AI_UNAVAILABLE`).
4. Matching is **deterministic and model-free**: exact-ref pre-checks only when the
   amount also agrees; fuzzy never pre-checks; VOID bills are never candidates; no
   bill is claimed by two lines.
5. When the parsed lines don't reconcile to the stated closing balance, **every** row
   is demoted to "needs a look".
6. Apply is idempotent, writes one `BillPayment` per confirmed bill under one shared
   `paymentGroupId`, turns surplus into `SupplierCredit`, and can never pay more than
   both the statement line and the bill's outstanding balance allow.
7. The implied-paid proposal is a separate panel with its own checkbox and its own
   second confirmation listing every affected bill; it is never part of the main
   Apply.
8. Outstanding amounts are computed as `totalOwed − totalPaid`, never from
   `VendorBillStatus`.
9. Everything an apply did is reconstructable from the scan row plus its payment
   group.
10. No new dependencies; OPERATOR-only, tenant-scoped throughout.

## Verification commands

From the repo root:

- `npm run verify` — Turbo `check-types`, `lint`, `test`.

Lint must report **0 errors**; all suites pass.

## Risks & rollback

- **Biggest risk is a confident wrong match moving money.** Mitigations, in order:
  matching is deterministic code (not the model), only exact-ref-plus-amount
  pre-checks, the closing-balance sanity guard demotes everything on disagreement,
  and apply validates every amount against both the statement and the bill.
- **Implied-paid is the most dangerous affordance in the batch** — it can mark
  dozens of bills paid at once. Keep it isolated, explicitly listed, and
  double-confirmed. If in doubt, make it harder, not easier.
- **Do not create a module cycle**: import `DuplicateMatchModule` directly; it was
  split out for exactly this reason.
- **`maxRetries: 0`** must be preserved on the Anthropic client or the timeout
  ceiling silently stops working.
- **Rollback**: the migration is additive; removing the module, the route and the UI
  leaves an unused table. Any apply that already happened is undone by voiding its
  payment group, which is why `appliedPaymentGroupId` is persisted.

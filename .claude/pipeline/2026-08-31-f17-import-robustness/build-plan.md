# F17 · Import robustness — build plan (with inline discovery/spec preamble)

**Status: APPROVED for execution** · worktree `.claude/worktrees/rf-F17`, branch
`fix/F17-import-robustness` (rebased onto current master via merge `5e82f2bd`) · scale **major**
(money parsing) but lean: three production files, no lane conflicts, freely parallel.
Discovery 2026-08-31: **all four bug IDs CONFIRMED at their cited lines** on this tree — none
already-fixed, none moved.

## Preamble (the W's + spec, condensed — full triples in the F17 F-card)

- **Problem/WHO:** any tenant migrating in from Zoho/QuickBooks/Excel. Comma-thousands money
  silently truncates ($1,234.56 → $1.00: `parseFloat("1,234.56") === 1`) across FOUR importers
  (B98); payments re-uploads double-record and flip invoices PAID (B99); Excel's UTF-8 BOM blanks
  column one (B112); the migration hub starts jobs for connectors that don't exist (B08).
- **Cost of shipping nothing:** every onboarding import of comma-formatted money is silently,
  massively wrong; the natural recovery action (re-upload) makes the books worse.
- **Success signal:** a comma-formatted CSV imports to the cent; a re-uploaded payments file
  creates 0 new rows and reports N duplicates; a BOM'd file imports identically; an unconnected
  source cannot start a job.
- **Deploy-day:** parsing fixes apply to future imports only; no schema change, no gate, no
  backfill. Rollback = revert the PR.

## Requirements

- **R1 (B98, Critical)** — one pure helper module `apps/api/src/import/parse-import-number.ts`:

  ```ts
  import { roundMoney } from "../common/pricing";

  /**
   * Parse a number column from an imported CSV (Zoho/QuickBooks/Excel exports).
   * Strips currency symbols, thousands-separator commas and spaces before parsing.
   * Returns NaN when the cell is empty, non-numeric or not a string/number —
   * callers rely on NaN to detect ABSENCE (the Balance-Due status logic), so
   * never default to 0 here. csv-parse only ever hands us strings.
   */
  export function parseImportNumber(raw: unknown): number {
    if (typeof raw === "number") return raw;
    if (typeof raw !== "string") return NaN;
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (cleaned === "") return NaN;
    return parseFloat(cleaned);
  }

  /** parseImportNumber + cent rounding for monetary columns. NaN passes through. */
  export function parseImportMoney(raw: unknown): number {
    const n = parseImportNumber(raw);
    return Number.isFinite(n) ? roundMoney(n) : n;
  }
  ```

  The non-string guard is `typeof raw !== "string"`, NOT `raw == null` + `String(raw)`:
  `String()` on an `unknown` is a `@typescript-eslint/no-base-to-string` **error**, so the
  `String(raw)` shape fails `npm run lint` and therefore `npm run verify`/CI.

  Applied at EVERY monetary/quantity read in `import.service.ts` (import.service.ts already
  imports `roundMoney` from `../common/pricing` — same relative path works for the new module):
  - `:623-627` invoice total/subtotal/discount/shippingFee → `parseImportMoney`
  - `:656-658` balanceDue → `parseImportMoney` **keeping the `|| "NaN"` absence sentinel**
    (helper returns NaN for it; the `isNaN(balanceDue)` status logic is load-bearing)
  - `:684` line qty → `parseImportNumber` (quantity, not cents-rounded)
  - `:686-689` unitPrice/itemDiscount/Item Total → `parseImportMoney` (keep the outer
    `roundMoney` wrap on the `sub` expression as-is)
  - `:837` payment amount → `parseImportMoney`
  - `:1086` expense amount → `parseImportMoney`
  - `:1394` product pricePerUnit → `parseImportMoney`
  - `:1464-1465` importInventory closingStock → replace the hand-rolled
    `.replace(/,/g, "")` with `parseImportNumber` (same behavior, one pattern)

  Existing `|| 0` / `|| total` / `|| 1` fallbacks and `<= 0` guards at every call site stay
  EXACTLY as they are — the helper only fixes what parseFloat saw.
  **Out of scope:** locale decimal commas ("3 456,78"), parenthesized negatives, and the
  lat/lng parseFloat sites at `:263-278` (coordinates, not money — leave untouched).

- **R2 (B99, Critical)** — the fallback dedupe the comment at `:856` promises, with **snapshot
  semantics**: dedupe against payments that existed BEFORE this run's inserts, so a re-upload
  dedupes against history while two identical legitimate rows inside ONE file both import.
  In `importPayments`, memoize per invoice:

  ```ts
  // Snapshot of payments that existed BEFORE this run's inserts, per invoice —
  // dedupe compares against history only, so identical legit rows within one
  // file still both import while a re-upload of the same file creates nothing.
  const preRunPayments = new Map<string, { amount: number; method: string; createdAt: Date }[]>();
  // on first encounter of invoice.id:
  //   preRunPayments.set(invoice.id, (await this.prisma.forTenant().invoicePayment.findMany({
  //     where: { invoiceId: invoice.id } }))
  //     // The synthetic "zoho-import" placeholder importInvoices writes for PAID/PARTIAL
  //     // invoices is meant to be REPLACED by the real payment (it is deleted just before
  //     // every create), so counting it would make the FIRST payments import after an
  //     // invoices import "dedupe" the real row away. A VOID row (bounced check) is
  //     // likewise not something a legitimately re-recorded payment collides with.
  //     .filter(p => p.reference !== "zoho-import" && p.status !== "VOID")
  //     .map(p => ({ amount: Number(p.amount), method: p.method, createdAt: p.createdAt })));
  ```

  A row **without** `zohoPaymentId` is a duplicate iff the snapshot — which EXCLUDES
  `reference === "zoho-import"` placeholders and `status === "VOID"` rows — holds an entry with
  cent-equal amount (`Math.abs(a - b) < 0.005`), same method, and `createdAt` within ±1 day
  (86_400_000 ms). On match: `duplicates++; continue;` — no create, no placeholder delete.
  The existing `zohoPaymentId` reference check stays first and unchanged. The status-recalc
  block after the loop is untouched (it now simply sees no duplicate rows).

- **R3 (B112)** — add `bom: true` to the `parse()` options in `parseCsv` (`:42-48`); csv-parse
  6.x supports it natively. One line.

- **R4 (B08)** — web migration hub (`apps/web/app/(dashboard)/settings/migration/page.tsx`):
  Start migration is disabled for `connected: false` sources (the honest option; wiring OAuth
  connectors is a feature, not this fix). Exact change at `:263-270`:

  ```tsx
  const selected = SOURCES.find((s) => s.key === source);
  // …
  <button
    onClick={start}
    disabled={createJob.isPending || !selected?.connected}
    className="…unchanged — disabled:opacity-40 is already there…"
  >
    {createJob.isPending
      ? "Starting…"
      : selected?.connected
        ? "Start migration"
        : "Connector coming soon"}
    <ArrowRight className="h-4 w-4" />
  </button>;
  ```

  No new tokens/components — the tile desc already says "coming soon" and the button already
  carries `disabled:opacity-40`. Default source is CSV (connected), so nothing changes for the
  working paths.

- **R5** — the payments import result surfaces duplicates: return
  `{ imported, skipped, duplicates, errors }` from `importPayments` (`:937`), and in the web
  import page (`apps/web/app/(dashboard)/settings/import/page.tsx`) add `duplicates?: number` to
  the `ImportResult` type (`:36-40`) and render it in the summary/toast alongside `skipped`
  (`:157-162` and the result badges around `:210-221`), e.g. "N duplicates skipped".

- **R6 (scanner ratchet)** — delete the **`import-parsefloat-money`** block from
  `.claude/skills/bug-hunt/scan-known-bugs.json` (KEEP `draft-payment-not-void` — that block is
  F09's). With the block gone and the sites fixed, `npm run verify`'s signature scan must be
  GREEN — any bare-parseFloat money site left behind fails verify by construction. Also update
  the `import-parsefloat-money` row in `.claude/skills/bug-hunt/references/bug-signatures.md`
  (`:518` and the §24 prose at `:452-459`) to record the 9 baselined sites were fixed by F17 and
  the signature now gates fresh.

- **Non-goals:** no OAuth connectors; no re-parse of historical imports. **Repair note (owner's
  repair-as-we-go): B98's historical truncations are UNREPAIRABLE post-hoc** — a stored $1.00
  cannot be distinguished from a truncated $1,234.56 without the source CSV. The register entry
  records this; the recovery path is client re-upload through the NOW-deduped, NOW-correct
  importer. B99's historical duplicates ARE identifiable — see P3.

## Packages

- **P1 api parsing + dedupe** — `apps/api/src/import/import.service.ts` + new
  `apps/api/src/import/parse-import-number.ts` + the R5 web surface
  `apps/web/app/(dashboard)/settings/import/page.tsx` (its rendering proven by
  `apps/web/e2e/26-import-duplicates.spec.ts` + that spec's `playwright.config.ts` project
  entry — **a spec without a config project entry NEVER runs**).
  satisfies R1 R2 R3 R5 · provenBy T-B98 T-B99 T-B112 REG-B99w.
- **P2 web hub gate** — `apps/web/app/(dashboard)/settings/migration/page.tsx` +
  `apps/web/playwright.config.ts` (project entry for spec 25 — **a spec without a config project
  entry NEVER runs**; see the 22-payment-truth entry's warning comment for the precedent).
  satisfies R4 · provenBy REG-B08 (T2, proven-pending-deploy).
- **P3 repair: duplicate payments** — `scripts/repair-f17.mjs`, mirroring the
  `scripts/repair-f03.mjs` contract EXACTLY (read its header + `scripts/repair-integrity.mjs`):
  dry-run by default with a read-only session; writing requires BOTH `--execute` AND
  `--i-have-a-fresh-backup`; refuses non-production DATABASE_URL without `--force-nonprod`;
  per-row re-read + compare-and-set (drift ⇒ SKIP, never overwrite); JSONL log to
  `local-assets/repair-f17-<timestamp>.jsonl` with before-state; prints row IDs/amounts/statuses
  only, never customer names. Exports for the spec (repair-f03 shape):
  `parseFlags(argv)`, `assertRepairTarget(databaseUrl, flags)`, `identifyRepairs(store)`
  (READ-ONLY), `applyRepairs(store, proposals, flags)`.
  Detection: per invoice, payment PAIRS matching the B99 damage signature — cent-equal amount,
  same method, `createdAt` within ±1 day, and NO distinct external reference distinguishing them.
  Proposal = VOID the later twin AND recompute that invoice's status/paidAt from the surviving
  confirmed rows. Clusters of >2 matching rows are REPORT-ONLY (ambiguous — returned under
  `unrepairable`/`skipped` with a reason, never auto-voided).
  provenBy T-R17.
- **P4 scanner ratchet** — `.claude/skills/bug-hunt/scan-known-bugs.json` +
  `.claude/skills/bug-hunt/references/bug-signatures.md`. Mechanical, low effort.
  satisfies R6 · proven by `npm run verify`'s scan step going green with the block deleted.

## Test plan (S4 — every R has a T; REG- tokens in test TITLES are the campaign gate's proof)

Test author conventions: NestJS `Test.createTestingModule`, `createMockPrisma` from
`src/testing/prisma-mock`, mock `VendorBillsService`/`CustomersService` at the module boundary —
copy the shape of `apps/api/src/import/import-customer-cap.spec.ts`. Service methods take raw CSV
Buffers, so tests drive the real parse path end-to-end. Prettier: double quotes, semicolons,
printWidth 100.

| T#                               | Given/When/Then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Red today because                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| T-B98 (titles carry `REG-B98`)   | CSVs with `"1,234.56"` and `$2,000` through importInvoices (total/subtotal/discount/shipping/line price), importPayments (amount), importExpenses, importProducts (rate) / stored values cent-exact (1234.56, 2000) / Balance-Due comma value drives PAID-vs-PARTIAL correctly; absent Balance Due still falls back to the Zoho status label (NaN semantics preserved)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | bare parseFloat truncates to the leading digit — every assert red |
| T-B99 (titles carry `REG-B99`)   | the same payments file (no InvoicePayment ID) imported twice / second run: imported 0, duplicates N, no new create calls, statuses not double-flipped / PLUS: one file containing two identical legit rows → BOTH import (snapshot semantics)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | no fallback dedupe exists — second run doubles everything         |
| T-B112 (titles carry `REG-B112`) | a `﻿`-prefixed contacts buffer through importContacts / row imports with clean `Customer Name` key, not skipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | no `bom: true` — first header key is BOM-prefixed, row skipped    |
| T-R17                            | seeded fake store: one true duplicate pair + one same-amount-different-day pair + one >2 cluster + one clean control / dry-run proposes EXACTLY the true pair (VOID + status recompute), cluster is report-only / applyRepairs rejects without both flags; drift row is skipped; non-prod URL throws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `scripts/repair-f17.mjs` does not exist                           |
| REG-B99w (T2, spec 26)           | R5's WEB half — the API half (`duplicates` in the payload) is T-B99's; this proves the page renders it. POST /import/payments mocked with `page.route` (no upload, no writes) returning `{imported:0, skipped:1, duplicates:2}` / the success toast reads "0 records imported, 1 skipped, 2 duplicates skipped" and the Customer Payments card badge reads "2 duplicates skipped"; a second import with `duplicates:1` reads "1 duplicate skipped" (singular) / **no build-age self-skip** — a pre-R5 build and a regressed build look identical here (summary with no duplicates clause, no badge), so a skip keyed on that state reports the very regression this gate exists to catch as SKIPPED instead of FAILED; the 12-search-back-nav convention needs a signal SEPARATE from the assertion and this result has none. Staleness stays ci.yml's job: its "Wait for the deployed app to match this commit" gate fails the run unless the deployed web build is code-identical to the commit under test | proven post-deploy — runs against the DEPLOYED build              |
| REG-B08 (T2, spec 25)            | migration hub as operator: select Zoho tile → Start button disabled with "Connector coming soon"; select CSV → enabled "Start migration" / read-only, never actually starts a job; **no build-age self-skip** — a pre-fix build and a regressed build look identical here (Zoho: enabled + "Start migration"), so a skip keyed on that state reports the very regression this gate exists to catch as SKIPPED instead of FAILED; the 12-search-back-nav convention needs a signal SEPARATE from the assertion and this page has none. Staleness stays ci.yml's job: its "Wait for the deployed app to match this commit" gate fails the run unless the deployed web build is code-identical to the commit under test                                                                                                                                                                                                                                                                                         | proven post-deploy — runs against the DEPLOYED build              |

Red gate (jest only — Playwright tests the deployed build and cannot be red-gated pre-merge):
`cd apps/api && npx jest --runTestsByPath src/import/import-robustness.spec.ts src/scripts/repair-f17.spec.ts`
→ expect FAIL on assertions.

Mutation targets: parse-import-number strip → bare parseFloat (T-B98 must go red) · delete the
fallback dedupe branch (T-B99 red) · remove `bom: true` (T-B112 red).

## Close-out

Ledger `F17.jsonl` → B98/B99/B112 `proven` + B08 `proven-pending-deploy`, each with `proof` and
`buildPlan` fields (F03 row shape) · `campaign-check --batch F17 --pipeline-dir` this folder ·
full `npm run verify` · map/CHANGELOG/_meta/HANDOFF · register chips ×4 + republish `310ae33a…` ·
PR → CI → squash-merge → deploy → post-deploy-check; auto-E2E discharges B08 → `done` with
dischargeEvidence · board issue per `.claude/campaign/board.json` · post-deploy: repair-f17
dry-run (fresh backup first) → apply only exact-signature pairs → JSONL log filed · integrity
re-check.

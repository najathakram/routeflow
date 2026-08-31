# F17 · Import robustness

**Bug IDs (4):** B08, B98, B99, B112

**Root cause:** Three parsing defects with one shape — the importer trusts a raw primitive. parseFloat("1,234.56") is 1, so $1,234.56 silently becomes $1.00 across four importers (B98); a payments re-upload has no dedupe despite a comment promising one (B99); Excel's UTF-8 BOM blanks the first column (B112, a one-line bom:true).

**Ships as:** One PR.

**Files:** import/import.service.ts · web migration hub

**Together because:** One class of mistake — trusting a raw primitive instead of a locale-aware parse — across several importers.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F17.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B08  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED |
| B98  | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |
| B99  | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |
| B112 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B08 — Migration hub offers connectors it can’t run

**Area:** Data migration · web

**Meant to do:** Let a business migrating off Zoho Books or QuickBooks pull their data into RouteFlow via a connected import, in addition to CSV/paper uploads.

**Actually does:** SOURCES lists ZOHO and QUICKBOOKS with `connected: false` and desc 'connector coming soon'; only CSV and PAPER show `connected: true`. Selecting Zoho/QuickBooks and clicking 'Start migration' is not blocked and creates a job, but the only backend connector logic (OAuthConnectorStub) throws BadRequestException if ever invoked, and it is never actually called — SourceConnectorRegistry is registered in import.module.ts but not injected into any controller/service.

**The gap:** The 'coming soon' labeling is honest, but the UI doesn't prevent starting a Zoho/QuickBooks-labeled job that then only works via the identical manual-CSV-upload path as any other source — no real connector fetch exists or is reachable at all.

**Evidence:** apps/web/app/(dashboard)/settings/migration/page.tsx:64-77 (SOURCES array); apps/api/src/import/connectors/source-connectors.ts:29-46 (OAuthConnectorStub throws), :50-61 (registry); apps/api/src/import/import.module.ts:16,52 (registered, no injector found); apps/api/src/import/migration.service.ts:53-63 createJob never calls a connector.

**Suggested fix:** Either disable the 'Start migration' button for unconnected sources (matching the `connected` flag already in SOURCES) or wire the OAuth connectors before advertising them as source options.

### B98 — Comma-thousands amounts truncated to the leading digit on CSV import

**Area:** Import · API

**Meant to do:** A CSV with comma-formatted amounts ("1,234.56") from Zoho/QuickBooks/Excel should import the full value for invoice totals, line prices, payment amounts, product rates, and expenses.

**Actually does:** Bare parseFloat everywhere: I ran parseFloat("1,234.56") on the repo's Node — returns 1. Truncated values pass the amount>0 guards and count as imported successes with no warning.

**The gap:** $1,234.56 silently becomes $1.00 across four importers; only importInventory strips commas, proving the format is a known real input.

**Evidence:** apps/api/src/import/import.service.ts:623-627 (invoice total/subtotal/discount/shipping), 656-658 (Balance Due — also drives PAID/PARTIAL status), 684-689 (line qty/price/total), 837-841 (payment amount, passes <=0 guard), 1086 (expense amount), 1394 (product pricePerUnit) — all bare parseFloat; contrast 1455-1464 (importInventory strips commas, comment names "comma-formatted numbers" in real files). Computed: parseFloat("1,234.56")===1 via node against the repo.

**Suggested fix:** Add a single parseMoney helper that strips thousands separators (and currency symbols) before parseFloat, and use it at every monetary/quantity read in import.service.ts, mirroring the importInventory pattern.

### B99 — Payments CSV without an InvoicePayment ID re-imports with zero dedupe — duplicates every payment

**Area:** Import · payments

**Meant to do:** Re-uploading the same payments file (a normal recovery action after an unclear success response) should not double-record payments; the code comment promises an amount+date fallback check.

**Actually does:** Dedupe runs only inside if (zohoPaymentId); the commented amount+date fallback does not exist anywhere in the function, so every re-upload unconditionally reaches invoicePayment.create and mints new rows.

**The gap:** Each re-upload doubles recorded payments; the post-import recalc (status !== VOID) then flips invoices to PAID and inflates cash received.

**Evidence:** apps/api/src/import/import.service.ts:852-865 (comment claims 'or amount+date combo'; only the zohoPaymentId branch exists — grepped the function, no other dup check), 873-882 (unconditional create), 890-925 (payment-based status recalc counts the duplicates via status !== VOID and flips invoices to PAID/PARTIAL at 909-915).

**Suggested fix:** Implement the promised fallback: before create, findFirst on {invoiceId, amount, createdAt (±day), method} and skip on match; or return a preview/confirm step for files lacking a payment ID column.

### B112 — Excel UTF-8 BOM silently corrupts the first CSV column's header key

**Area:** Import · CSV parsing

**Meant to do:** A CSV re-saved by Excel as 'CSV UTF-8' (which prepends EF BB BF) should import identically; the first column's field should be read normally.

**Actually does:** Reproduced with the installed csv-parse 6.2.1 and the exact parser options: first header key becomes "﻿Customer Name" (trim does not strip it), so row["Customer Name"] is undefined for every row.

**The gap:** Whichever field is column one silently blanks: contacts skip wholesale (if no Display/Company Name fallback), other importers fall to fallback columns or synthetic values, with only a bare skip count.

**Evidence:** apps/api/src/import/import.service.ts:39-52 (parseCsv, no bom option; grep 'bom' across apps/api/src = zero matches), 220-229 (importContacts name lookup + silent skipped++). Empirically ran the repo's csv-parse (node_modules/csv-parse, v6.2.1) with {columns:true, trim:true,...} on a BOM'd buffer: keys[0].codePointAt(0)===0xFEFF, row["Customer Name"]===undefined.

**Suggested fix:** Pass bom: true in the parse() options in parseCsv — a one-line fix csv-parse supports natively.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.

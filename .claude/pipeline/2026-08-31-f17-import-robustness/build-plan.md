# F17 · Import robustness — build plan (with inline discovery/spec preamble)

**Status: APPROVED for execution** · worktree `.claude/worktrees/rf-F17`, branch
`fix/F17-import-robustness` off `master e7eb1627` · scale **major** (money parsing) but lean:
two production files, no lane conflicts, freely parallel.

## Preamble (the W's + spec, condensed — full triples in the F17 F-card)

- **Problem/WHO:** any tenant migrating in from Zoho/QuickBooks/Excel. Comma-thousands money
  silently truncates ($1,234.56 → $1.00) across FOUR importers (B98); payments re-uploads
  double-record and flip invoices PAID (B99); Excel's UTF-8 BOM blanks column one (B112); the
  migration hub starts jobs for connectors that don't exist (B08).
- **Requirements:** R1 one `parseImportMoney`/`parseImportNumber` helper (strips thousands
  separators + currency symbols, mirrors importInventory's existing pattern) used at EVERY
  monetary/quantity read the card cites (:623-627, :656-658, :684-689, :837-841, :1086, :1394)
  — and a sweep of the file for any bare `parseFloat(` the card missed (in-file only). R2 B99's
  promised fallback dedupe: before create, `findFirst {invoiceId, amount, method, createdAt
  ±1 day}` → skip + count as duplicate in the result summary. R3 `bom: true` in parseCsv. R4 web
  hub: Start-migration disabled for `connected: false` sources (the honest option; wiring OAuth
  connectors is a feature, not this fix). R5 import result summaries surface skipped/duplicate
  counts they already track.
- **Non-goals:** no OAuth connectors; no re-parse of historical imports. **Repair note (owner's
  repair-as-we-go): B98's historical truncations are UNREPAIRABLE post-hoc** — a stored $1.00
  cannot be distinguished from a truncated $1,234.56 without the source CSV. The register entry
  records this; the recovery path is client re-upload through the NOW-deduped, NOW-correct
  importer. B99's historical duplicates ARE identifiable (same invoiceId/amount/method within
  the same import window) — the repair script proposes VOIDs for exact-duplicate payment pairs,
  dry-run first, per the standing repair safety shape.
- **Deploy-day:** parsing fixes apply to future imports only; no schema, no gate. Rollback =
  revert.

## Packages

- **P1 api parsing + dedupe** — `apps/api/src/import/import.service.ts` (+ spec).
  satisfies R1 R2 R3 R5 · provenBy T-B98 T-B99 T-B112.
- **P2 web hub gate** — `apps/web/app/(dashboard)/settings/migration/page.tsx` +
  `apps/web/e2e/23-migration-hub.spec.ts` (REG-B08, proven-pending-deploy).
  satisfies R4 · provenBy REG-B08.
- **P3 repair: duplicate payments** — `scripts/repair-f17.mjs` (B99 historical duplicates;
  dry-run default, --execute + --i-have-a-fresh-backup, JSONL log — repair-integrity.mjs shape).
  provenBy T-R17.

## Test plan (S4, condensed — every R has a T)

| T# | Given/When/Then | Red today because |
| --- | --- | --- |
| T-B98 (REG-B98) | CSV rows with "1,234.56", "$2,000", "3 456,78"? — NO: comma-thousands + $ only (locale decimals out of scope, note it) / import invoices+payments+expenses+products / stored values exact | bare parseFloat truncates — every assert red |
| T-B99 (REG-B99) | same payments file imported twice (no zohoPaymentId) / second run creates 0 rows, reports N duplicates | today it doubles — red |
| T-B112 (REG-B112) | BOM'd buffer through parseCsv / first header key clean, rows keyed correctly | today key[0] is ﻿-prefixed — red |
| T-R17 | seeded store with one true duplicate pair + one legit same-amount pair (different days) / dry-run proposes exactly the true pair | script absent — red |
| REG-B08 (T2) | migration hub, Zoho tile / Start migration disabled with "coming soon" | proven post-deploy |

Red gate: `-t "REG-B(98|99|112)"` apps/api, expect fail. Mutation targets: parseImportMoney
(strip → bare parseFloat), dedupe (drop the fallback branch), parseCsv (bom:false).

## Close-out

Ledger F17.jsonl → proven (+B08 pending-deploy) · campaign-check --batch F17 · map/CHANGELOG/
_meta/HANDOFF · register chips ×4 + republish · merge when ready · post-deploy: repair-f17
dry-run → apply for B99 duplicates (fresh backup first) · integrity re-check.

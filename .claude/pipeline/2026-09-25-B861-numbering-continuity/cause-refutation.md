# B861 — cause refutation (S2, Opus, read-only, base 21085bcb)

**VERDICT: confirmed.** The paths split at `apps/api/src/import/numbering.service.ts:254`:
`year > 0 && isYearScoped(docType)` sends every live INVOICE/ESTIMATE/CREDIT_NOTE mint to `mintForYear`,
which reads only the caller's calendar-year row (key `:251`, read `:301`) and creates it from `DEFAULTS`
when missing (`:304`, `:319`). The card writes `year: 0` (`:131`). Only `getSettings` (`:104`) and the
no-year fast path (`:266-282`) read year 0, and no live caller reaches that fast path. Slightly wider
than filed (the PAYMENT row, and two scripts).

1. **Nothing live reads year 0 for the three types.** All six callers pass `new Date().getFullYear()`:
   `invoices.service.ts:2872-2873` (every invoice site: `:459→:309`, `:1233/:1237`, `:2785`, `:4669`),
   `estimates.service.ts:97-101` + `:442-443`, `credit-notes.service.ts:437-441`,
   `inline-returns.service.ts:385-390`, `import.service.ts:581` (used `:949`). The no-year fast path runs
   only in unit spec P2 (`numbering.service.spec.ts:196-210`). Scripts that mint their own invoice
   numbers and also ignore the card: `import-zoho.js:364-397` (local counter from 1, `INV-<year>-####`),
   `backfill-invoices.js:17-25` (max+1 across all tenants, B273).
2. **Year-0 writers: only `updateSettings` (`:130-144`)**, via `numbering.controller.ts:27-29` ←
   `page.tsx:450-458`. `seedFromSource`/`peekNext`: no callers. RETURN callers pass a year. No migration
   inserts rows (`20260908000000…/migration.sql:42` set pre-existing rows to year 0 — those can only be
   card saves). No seed/demo/e2e/smoke writer (`e2e/26` opens /settings/import but never touches the
   card). DB specs create rows only at an explicit year. ⇒ prod year-0 rows = tenants who saved the
   card; count unknown.
3. **Only the card reads `preview`** (controller `:21-24` → `useNumberingSettings` → `page.tsx:423`,
   shown `:370-372`, `:529`, toast `:470`). Live mints always carry the year (`format` `:81`), so
   `INV-0001` is never produced; `formatDocumentNumber` has no year either.
4. **Nothing is noted on the document**: a skip is `logger.warn` (`:347-351`); `reserveNext` returns a
   bare string, so no caller can tell a number was skipped.
5. **PAYMENT row dead**: all three payment sites use `paymentCounter` (`invoices.service.ts:4985-4992`,
   `:5272-5281`, `:5296-5318` → `:5669`), format `PAY-<tenantShort>-####`; no `reserveNext("PAYMENT")`.
6. **Hazards a fix must respect**
   - Unescaped prefix in the regex (`:417`); DTO allows any ≤ 16-char string incl. empty. `INV.` over-
     matches; `INV(` is an invalid regex → Postgres throws and aborts the tx — on the delivery path that
     is the caller's stop-completion tx (`:259-260`).
   - Two prefixes: the seed scan uses the default (`:304`), the collision re-scan the row's (`:355`).
   - The skip logic assumes a year segment: `:417` requires `<prefix><year>-`, so for a year-less series
     the scan returns 0, the target is just next (`:356`), each attempt skips ONE number, and after 5
     (`:334`) → 409 (`:373`) — exactly the "next lands inside an imported block" migration case.
   - Exact-string collision check only (`:387-391`); padding 0–12 ⇒ imported `INV-010543` vs minted
     `INV-10543` pass both the check and `@@unique([tenantId, invoiceNumber])`.
   - `-R{i}`: only the base is checked; `parseDocumentNumber` reads `INV-10543-R1` as prefix
     `INV-10543-R`, number 1. Zoho fallback shape `INV-<year>-NNNN-<seq>` (`import-zoho.js:475`) is
     skipped by the max scan.
   - **Card saves can move the counter backwards**: absolute `nextNumber` (`:141`); the card loads drafts
     once (`page.tsx:429-440`) and sends all three fields on every save (`:453-457`) — if the row went
     live, a stale tab or a prefix-only edit rewinds it (the D8 class).
   - Empty prefix never falls back: column non-null default `""` (`platform.prisma:618`), so
     `current.prefix ?? d.prefix` (`:326`) never takes the default.
   - Tests locking today's behaviour: `invoice-numbering.db.spec.ts:501-525` (T1i REG-B100-D2b),
     `numbering.service.spec.ts:196-210` (P2), `:62`, `:76-77`.
   - Needs a ruling: B100 ruling D1's "exactly `INV-<year>-NNNN`" invariant and the January reset
     (`platform.prisma:621`) conflict with a continuous year-less series.

# F09 · P8 plan (Fable, 2026-09-06) — ledger + records + code map + lesson, executed by one Sonnet agent

Preconditions (Fable does these first): fix rounds 2 + 3 committed; `origin/master` (a94f9428) merged;
tree clean except the three `.claude/` files this plan finalises (`code-map/_meta.json`, `code-map/api.md`,
`lessons/_meta.json` — all already carry partial F09 edits; build on them, never revert them).

## Step 1 — code map (surgical entries, never a regen)

`.claude/code-map/api.md`:

- `credit-notes/` section, `credit-notes.service.ts`: `applyCreditInTx` now returns `{ applied: 0 }` when
  `CREDIT_SETTLE_EXCLUDED.includes(inv.status)` — the ONE gate for settle, auto-apply (`send()`/`sendEmail()`)
  and any future caller (F09/B67, REG-B67 T1/T2/T5); the settle `where` keeps `status: { not: "VOID" }` on
  purpose so SHRINK still sees WRITTEN_OFF (T3/T3b pin it). `create()` selects `status` and refuses
  `CREDIT_SOURCE_EXCLUDED` (VOID, WRITTEN_OFF) with `BadRequestException("Cannot issue a credit note against a
<status> invoice.")` — DRAFT allowed on purpose (returns' pending-mirror invoices; T7b pins it) (F09/B66,
  REG-B66 T6/T7). `findAll` includes `invoice: { select: { id, invoiceNumber } }` like `findOne` (B19, T12).
  `issue()` deleted (B18 — the enum never had DRAFT). `applyToInvoice`'s literal re-pointed at
  `CREDIT_NOT_APPLICABLE`.
- `credit-notes.controller.ts`: `@Post(":id/issue")` deleted (B18).
- `invoices/` section: `invoice-status-sets.ts` (NEW) — `CREDIT_NOT_APPLICABLE` [PAID, VOID, WRITTEN_OFF]
  (manual apply + the advance wallet's apply in `customers.service.ts`), `CREDIT_SETTLE_EXCLUDED` [VOID,
  WRITTEN_OFF] (automatic apply — PAID stays IN because shrink runs over the same list), `CREDIT_SOURCE_EXCLUDED`
  [VOID, WRITTEN_OFF] (minting), `PAYABLE` [DRAFT, SENT, PARTIAL, OVERDUE] (delivery payments; moved here from
  `invoices.service.ts`). One home, reasons in the comments (R3a).
- `invoices.service.ts`: the `voidInvoiceInTx` capping sentence is already in the map (keep it); add:
  `voidInvoice` runs its `tenantTransaction` with the orders-side void caller's options (Serializable,
  15 s) so the cap never writes a stale `amountUsed` (lens A5).
- `returns/` section, `returns.service.ts`: `processRefund` selects the order's invoices with
  `status: { notIn: CREDIT_SOURCE_EXCLUDED }` so a refund against a voided/written-off source mints an
  UNSOURCED credit instead of throwing after the REFUNDED claim committed (lens A2; spec
  `returns.service.spec.ts` "F09 A2").
- `customers/` section, `customers.service.ts`: the advance-wallet apply guard reads `CREDIT_NOT_APPLICABLE`
  (was a byte-identical literal; lens A6).
- `deleteInvoice` (invoices.service.ts) — one clause: "unlinks sourced credit notes (`invoiceId: null`) with
  their FULL amount — the B66 delete door, filed as <the new B### from step 3>".

`.claude/code-map/web.md`: `lib/api/credit-notes.ts` (`CreditNoteStatus` from `@routeflow/types`, L-072;
`CreditNote.invoice?: { id; invoiceNumber }`; the issue hook deleted), `lib/api/customers.ts`
(`useApplyAdvancePayment` deleted — R12; `useApplyAdvanceToInvoice` in `invoices.ts` is the one hook),
`app/(dashboard)/credit-notes/page.tsx` + `[id]/page.tsx` (DRAFT/Issue affordances, `IssueConfirmModal`
and the list chip/count removed; three render sites show `invoice?.invoiceNumber ?? invoiceId`; void-modal
copy), `e2e/28-credit-note-wallet.spec.ts` (REG-B19 T13 list renders the invoice number; REG-B18 T14
detail loads and no `Issue Credit Note` button exists — DRAFT fixture so the pre-fix build is red; heading
locators scoped through `#main-content`) + the `credit-note-wallet` project in `playwright.config.ts`.

`.claude/code-map/mobile.md`: `lib/api/credit-notes.ts` (`CreditNoteStatus` from `@routeflow/types`),
`lib/credit-notes-logic.ts` (DRAFT pill case and `canIssue` removed; `default` stays as the runtime net),
`__tests__/credit-notes-helpers.test.ts` (DRAFT cases dropped), `app/(operator)/credit-notes/{[id],index}.tsx`
(Issue/Draft UI removed; `new.tsx`'s DRAFT is the INVOICE status pill and is untouched).

`.claude/code-map/CHANGELOG.md`: one dated bullet at the top (F09: B66/B67 primitives, B18/B19, lens
fallout A2/A5/A6, sibling filed). `.claude/code-map/_meta.json`: `mappedSha` = `git rev-parse --short HEAD`
at that moment, `generatedAt` now, `notes` = the same bullet (replace the partial note).

## Step 2 — lesson L-081

The register is at 40/40 after the master merge. Archive the OLDEST active entry whose **Guard** names an
automated artifact (spec/hook/script/CI check — not judgment/none/runbook), SKIPPING the id the
registry-guards branch archives (Fable fills it in here: `<ARCHIVED-BY-REGISTRY: L-0xx>`) so the two
branches never archive the same entry. Move it verbatim to `ARCHIVE.md` under its category with a dated
one-line note; append `lesson-L-081.md` (this directory) under `domain`. `_meta.json`: nextId 82 — NO: the
registry-guards branch mints L-080 and bumps nextId to 81; this branch mints **L-081** and sets nextId 82
only if it merges after registry-guards (Fable confirms the number at commit time — if registry-guards has
not merged, mint L-080 here and let the later merge renumber, per [[L-039]]). activeCount 40,
archivedCount +1, updatedAt now, note = one sentence. `node scripts/validate-lessons.mjs` → exit 0.

## Step 3 — registry (records via `sync`; `prove` is deferred until the PR number exists)

- `node scripts/campaign/bugs.mjs note B13 "Refuted as a bug (F09 S2 refutation + S3 ruling, 2026-09-05): no web affordance for applying a customer advance ever existed — git log -S shows useApplyAdvanceToInvoice added once and never called; R11 is a FEATURE deferred to dev-pipeline; the duplicate useApplyAdvancePayment hook was deleted (R12). Ledger row stays queued pending the owner's feature decision." --section "Root cause"`
- `node scripts/campaign/bugs.mjs file "Deleting an invoice (or its order) leaves the credit notes it sourced fully spendable with no provenance" --location "apps/api/src/invoices/invoices.service.ts#deleteInvoice" --severity high --symptom "deleteInvoice sets invoiceId null on sourced credit notes and the order-delete cascade relies on FK SetNull, so a note minted against a deleted invoice keeps its full amount and loses its source — the delete twin of B66's void door, which F09 P3 closes only for voids" --files "apps/api/src/invoices/invoices.service.ts apps/api/src/orders/orders.service.ts apps/api/prisma/schema/finance.prisma"` (no batch — triage; record the new id in the report and in the code-map clause above).
- `node scripts/campaign/bugs.mjs sync` → records updated; `git status` shows only intended files.

## Step 4 — gate and commit

`node scripts/validate-lessons.mjs` (exit 0) · `node scripts/campaign/bugs.mjs self-test 2>&1 | tail -3`
(all checks passed) · `npx prettier --check` on every `.md`/`.json` you touched. Commit:
`docs(f09): code map, lesson, b13 note, file the invoice-delete credit door` (+ Co-Authored-By trailer).

Deferred to the push slot (Fable): `prove B66 --pr <n> --proof "REG-B66 …"`, `prove B67 --pr <n> --proof
"REG-B67 …"`, `prove B18 --pr <n> --pending-deploy --proof "REG-B18 …"`, `prove B19 --pr <n> --pending-deploy
--proof "REG-B19 …"`, then `sync` and a second push.

## Post-P8 correction (Fable, 2026-09-06 ~07:10Z) — id collision

P8's `file` allocated **B213** for the invoice-delete credit door because this tree is master-based and the
OCR-outage **B213** exists only on `feat/registry-guards` (W1). After W1 lands and `origin/master` is merged
here: take master's `bugs/B213.md` and catalogue row (the OCR one), delete this branch's B213 record + row,
re-run the same `bugs.mjs file …` command so the delete-door bug gets the next free id, fix the code-map
`deleteInvoice` clause and `p8-report.md` to the new id, `sync`, commit `chore(campaign): renumber the
invoice-delete credit door after the f32 merge`. Then F09 is "ready to push" (W2).

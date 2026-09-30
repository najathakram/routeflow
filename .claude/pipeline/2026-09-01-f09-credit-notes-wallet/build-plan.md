# F09 · Build plan (revised 2026-09-05 — supersedes the Sep-1 plan; ruling in `cause-ruling.md`)

Base master `d12203a3`, worktree `rf-F09`, branch `fix/F09-credit-notes-wallet`, ONE PR. Artifacts (the whole context): `cause-brief.md` · `refutation.md` · `cause-ruling.md` · `bug-test-plan.md` · `spec.md` (Sep 1; R4 amended to `{VOID, WRITTEN_OFF}`, R11 removed) · this file. Code map: `.claude/code-map/INDEX.md` → `api.md` / `web.md` / `mobile.md`. Lessons carried: L-072 (never hand-type a server enum — import from `@routeflow/types`), L-067 (writers read back and assert), L-041, L-051.

## The one idea

Fix the **primitives that write money**, never a call site: `applyCreditInTx` (7 settle callers + the auto-apply path share it), `create()`, `voidInvoiceInTx`. A mock that injects the query result bypasses a `where`-only fix — so the guard sits after the read, on `inv.status`, as an EXCLUDE-list.

## Exact code for the tricky parts (line numbers = `d12203a3`; trust the tree)

**1. `apps/api/src/invoices/invoice-status-sets.ts` (NEW; mirror `payment-predicates.ts`'s export style):**

```ts
import { InvoiceStatus } from "@prisma/client";
/** Manual operator apply (`applyToInvoice`): refuses a settled, dead or forgiven target. */
export const CREDIT_NOT_APPLICABLE: InvoiceStatus[] = [
  InvoiceStatus.PAID,
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];
/**
 * Automatic apply (`applyCreditInTx`, reached by settleOrderCreditsInTx and autoApplyOldestCreditsInTx).
 * Deliberately NARROWER than CREDIT_NOT_APPLICABLE: PAID must stay applicable-but-zero-balance because
 * settle's SHRINK pass runs over the same invoice list and PAID is exactly where shrink has work.
 * This set gates the WRITE, not the query — the settle `where` keeps WRITTEN_OFF so shrink can restore excess.
 */
export const CREDIT_SETTLE_EXCLUDED: InvoiceStatus[] = [
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];
/** Minting (`CreditNotesService.create`): a dead or forgiven invoice justifies no new credit. DRAFT is allowed on purpose. */
export const CREDIT_SOURCE_EXCLUDED: InvoiceStatus[] = [
  InvoiceStatus.VOID,
  InvoiceStatus.WRITTEN_OFF,
];
/** Delivery payment targets (`recordDeliveryPaymentInTx`): an ALLOW-list. */
export const PAYABLE: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.SENT,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
];
```

**2. B67 — `applyCreditInTx` (`credit-notes.service.ts` ~:380-422):** immediately after the invoice is read and before `invoiceBalance` is computed:

```ts
// F09/B67: the write is gated here, not at the callers' queries — settle, auto-apply and any future
// caller all pass through this line. Exclude-list on purpose: a fixture without `status` still applies.
if (CREDIT_SETTLE_EXCLUDED.includes(inv.status as InvoiceStatus)) return { applied: 0 };
```

The settle `where` at `:930` (`status: { not: "VOID" }`) is **unchanged** (shrink must still see WRITTEN_OFF).

**3. B66 — `create()` (`:107-124`):** add `status: true` to the `select`; after the customer check:

```ts
if (CREDIT_SOURCE_EXCLUDED.includes(invoice.status)) {
  throw new BadRequestException(`Cannot issue a credit note against a ${invoice.status} invoice.`);
}
```

**4. B66 — `voidInvoiceInTx` (`invoices.service.ts` ~:3836-3851):** after the atomic claim (`claimed.count` check, `:3846`) and BEFORE the final `tx.invoice.findUnique` (`:3850`):

```ts
// F09/B66: a credit note's headroom dies with the invoice that justified it. Only the UNUSED portion
// goes — spent credit paid real invoices and clawing it back would corrupt them.
const sourced = await tx.creditNote.findMany({
  where: { invoiceId: id, status: { not: "VOID" } },
  select: { id: true, amount: true, amountUsed: true },
});
for (const cn of sourced) {
  const used = Number(cn.amountUsed ?? 0);
  await tx.creditNote.update({
    where: { id: cn.id },
    data: used <= 0.001 ? { status: "VOID" } : { amount: roundMoney(used) },
  });
}
```

`roundMoney` from `@routeflow/pricing` (already imported at `:13-19`). Callers (`voidInvoice :3874`, `orders.service.ts:2754`) already call `releaseWalletPaymentsInTx` first — do not reorder.

**5. B19 — `findAll` (`:295`):** add `invoice: { select: { id: true, invoiceNumber: true } }` to the include (same shape as `findOne` `:331-338`).

**6. B18 — delete `issue()` (`:358-360`) and `@Post(":id/issue")` (`credit-notes.controller.ts:51-55`).** Web: `apps/web/lib/api/credit-notes.ts:6` → `import type { CreditNoteStatus } from "@routeflow/types"` (from `packages/types/api/enums.ts`), add `invoice?: { id: string; invoiceNumber: string }` to `CreditNote`; then remove every branch that no longer compiles (`[id]/page.tsx:410, 653`, `IssueConfirmModal` `:34`, the issue hook `:243`, modal `:704-709`; list chip/count `page.tsx:37, 563, 677, 685`). Mobile: `apps/mobile/lib/api/credit-notes.ts:8` same import; `credit-notes-logic.ts` drop the DRAFT pill case (`:22-23`) and `canIssue` (`:52`); screens `(operator)/credit-notes/{[id],index,new}.tsx` drop Issue/Draft UI; `__tests__/credit-notes-helpers.test.ts` drop the DRAFT cases (`:16, :44, :87`). Web render sites `page.tsx:855-856`, `[id]/page.tsx:508-516, 638-646` → `invoice?.invoiceNumber ?? invoiceId`. R12: delete `useApplyAdvancePayment` (`customers.ts:282-297`). **No R11.**

## Work packages

| id       | title                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | files                                                                                                                                                                                                                                                                                                                                                                                                                                             | dependsOn      | satisfies         | provenBy           | effort |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------- | ------------------ | ------ |
| `TP-API` | Edit the two safekept jest specs to `bug-test-plan.md` (gate: T1 T2 T5 T6 T7 T9 T10 T12; pins: T3 T3b T4 T7b T8 T11). Implementation forbidden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts`, `…pins.spec.ts`                                                                                                                                                                                                                                                                                                                                                                | —              | —                 | T1–T12             | high   |
| `P1`     | Shared status sets + re-point `applyToInvoice`'s literal and `PAYABLE` (behaviour-neutral)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `apps/api/src/invoices/invoice-status-sets.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/credit-notes/credit-notes.service.ts`                                                                                                                                                                                                                                                                                                  | —              | R3a               | T1–T5              | medium |
| `P2`     | B67 apply-side guard · B66 `create()` guard · B19 include · B18 delete `issue()` + route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/api/src/credit-notes/credit-notes.service.ts`, `apps/api/src/credit-notes/credit-notes.controller.ts`                                                                                                                                                                                                                                                                                                                                       | P1             | R1,R2,R3,R4,R7,R9 | T1,T2,T5,T6,T7,T12 | high   |
| `P3`     | B66 void-side capping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/api/src/invoices/invoices.service.ts`                                                                                                                                                                                                                                                                                                                                                                                                       | P2             | R5,R6             | T9,T10,T11         | high   |
| `P5`     | Web: types from `@routeflow/types`, DRAFT/Issue removal, invoice number at 3 sites, delete duplicate hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/web/lib/api/credit-notes.ts`, `apps/web/lib/api/customers.ts`, `apps/web/app/(dashboard)/credit-notes/page.tsx`, `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx`                                                                                                                                                                                                                                                                      | —              | R7,R8,R10,R12     | T13,T14            | medium |
| `P6`     | Mobile: types from `@routeflow/types`, DRAFT/Issue removal, logic + its test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `apps/mobile/lib/api/credit-notes.ts`, `apps/mobile/lib/credit-notes-logic.ts`, `apps/mobile/__tests__/credit-notes-helpers.test.ts`, `apps/mobile/app/(operator)/credit-notes/[id].tsx`, `apps/mobile/app/(operator)/credit-notes/index.tsx`, `apps/mobile/app/(operator)/credit-notes/new.tsx`                                                                                                                                                  | —              | R7,R8             | (build)            | medium |
| `P7`     | e2e spec 28 (T13, T14) + `playwright.config.ts` project entry (confirm the slot)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `apps/web/e2e/28-credit-note-wallet.spec.ts`, `apps/web/playwright.config.ts`                                                                                                                                                                                                                                                                                                                                                                     | P5             | R7,R10            | T13,T14            | medium |
| `P8`     | Ledger + records + code map + lesson: B66/B67 → `proven` (proof REG tests), B18/B19 → `proven-pending-deploy`, B13 → `refuted` (evidence: no affordance ever existed, `git log -S`; feature deferred); `node scripts/campaign/bugs.mjs sync` BEFORE committing; code-map entries for the touched files + `_meta` + CHANGELOG bullet; ONE lesson (archive the oldest fully-guarded entry first if at the cap): Symptom "a wallet leak was fixed at the query while a second primitive shared the write"; Root cause "the guard sat at a call site's query, not at the money write"; Lesson "gate a money write inside the primitive that performs it — mocks that inject query results, and sibling primitives, bypass a where-only fix"; Guard T1/T2/T5. | `.claude/campaign/status/F09.jsonl`, `.claude/campaign/bugs/B13.md`, `.claude/campaign/bugs/B18.md`, `.claude/campaign/bugs/B19.md`, `.claude/campaign/bugs/B66.md`, `.claude/campaign/bugs/B67.md`, `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/mobile.md`, `.claude/code-map/_meta.json`, `.claude/code-map/CHANGELOG.md`, `.claude/lessons/LESSONS.md`, `.claude/lessons/ARCHIVE.md`, `.claude/lessons/_meta.json` | P3, P5, P6, P7 | —                 | —                  | low    |

## Red gate

`cd apps/api && npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts --runInBand` — `expect: fail`, behavioral (each test on its own wrong value). Pins and spec 28 are outside the gate.

## Verify commands (scoped)

perRound: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` · `cd apps/api && npx jest src/credit-notes src/invoices src/returns --runInBand` · `cd apps/web && npx tsc --noEmit -p tsconfig.json` · `cd apps/mobile && npx tsc --noEmit` · `cd apps/mobile && npx jest credit-notes-helpers`. final: the same plus `cd apps/api && npx jest --silent`, `cd apps/mobile && npx jest --silent`, `node scripts/validate-lessons.mjs`. (`npm run verify` is the pre-push hook's job.)

## Close-out (human; after the engine)

Standalone api + mobile suites; `npx playwright test --list --project=<spec 28 project>` (list only, with `PLAYWRIGHT_JSON_OUTPUT_FILE` redirected); `node scripts/campaign/bugs.mjs sync --check` (if that flag has landed) else `sync`; result.json + ledger row (`--subagent-tokens`) + RUN-LOG entry; owner-owed: the read-only wallet-leak report script (`cause-ruling.md` §6) and the B13 feature decision; announce "ready to push" to the fleet lead; push with the full hook; PR; window; E2E read for spec 28 → discharge B18/B19.

## Pipeline args (keep under 4 KB — the run record truncates longer args)

```js
{
  planPath: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09/.claude/pipeline/2026-09-01-f09-credit-notes-wallet/build-plan.md",
  testPlanPath: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09/.claude/pipeline/2026-09-01-f09-credit-notes-wallet/bug-test-plan.md",
  specPath: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09/.claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md",
  lessonsPath: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09/.claude/lessons/LESSONS.md",
  startedAt: "<launch>", mode: "bugfix", scale: "major",
  workdir: "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09",
  context: "F09 credit notes + wallet integrity (B66 B67 T1; B18 B19 T2; B13 refuted): guard money writes at the primitives; ruling in cause-ruling.md.",
  formatCommand: "git ls-files -mo --exclude-standard | grep -E '\\.(ts|tsx)$' | grep -v '^\\.claude/' | xargs -r npx prettier --write",
  radiusFiles: [ /* cause-ruling §4 */ ],
  siblingPatterns: [ { pattern: "status: \\{ not: \"VOID\" \\}", note: "single-status exclusion where the shared set belongs" }, { pattern: "\"DRAFT\" \\| \"ISSUED\"", note: "hand-typed enum union — import from @routeflow/types (L-072)" }, { pattern: "tx\\.invoicePayment\\.create\\(", note: "a money write — needs a status gate upstream" } ],
  testPackages: [ { id: "TP-API", files: [gate, pins], tests: ["T1","T2","T3","T3b","T4","T5","T6","T7","T7b","T8","T9","T10","T11","T12"], effort: "high", brief: "Edit the two safekept specs to bug-test-plan.md exactly; implement nothing." } ],
  redGate: { commands: ["cd apps/api && npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts --runInBand"], expect: "fail" },
  packages: [ P1, P2, P3, P5, P6, P7, P8 — as the table, briefs = "build-plan §<n>" pointers ],
  verifyCommands: { perRound: [...], final: [...] },  // as above
  mutationProbe: { targets: [ { file: "apps/api/src/credit-notes/credit-notes.service.ts", revertFix: true, behavior: "apply-side guard: WRITTEN_OFF/VOID never receive credit; create refuses VOID/WRITTEN_OFF; findAll includes invoice", test: "REG-B67" }, { file: "apps/api/src/invoices/invoices.service.ts", revertFix: true, behavior: "void caps sourced credit notes without clawing back spent credit", test: "REG-B66" } ] }
}
```

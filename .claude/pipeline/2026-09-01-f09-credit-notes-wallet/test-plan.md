# F09 · Test plan

**Status: IN PROGRESS** · Jest for T1 (B66, B67), Playwright **spec 28** (allocated by the
coordinator) for T2 (B13, B18, B19). No snapshots, no Vitest. New files:

- `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts` (T1–T9)
- `apps/api/src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts` (green-pre-fix pins)
- `apps/web/e2e/28-credit-note-wallet.spec.ts` + its `playwright.config.ts` `projects[]` entry

⚠️ **Token-discipline hazard, deliberate:** B13/B18/B19 are **T2** rows, discharged by the
deployed e2e run. Any jest test carrying a `REG-B13/18/19` token would satisfy `campaign-check`
from `api.json` and could flip a T2 row to `done` **without the web half ever having run**. So
the server-side jest test for `findAll`'s include is titled WITHOUT a REG token; only spec 28
carries those three tokens. (`REG-B66`/`REG-B67` are T1 and belong in jest.)

**Anti-vacuity:** every new api test asserts through a collaborator (a real `tx` mock recording
calls), never internal state. Reads of not-yet-existing fields go through `as any` so the red
run fails on assertions, not TS errors.

| T#  | R#     | Level                                      | Given / When / Then + oracle                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | R1     | unit                                       | Order with a WRITTEN_OFF invoice carrying an unmet credit intent → `settleOrderCreditsInTx` creates **no** `InvoicePayment` against it and does not increment `amountUsed`. Oracle: the tx mock's `invoicePayment.create` call list is empty for that invoice id. `REG-B67`                                                                                                                    |
| T2  | R1     | unit                                       | Same with a VOID invoice → excluded (pins existing behaviour survives the rewrite). `REG-B67`                                                                                                                                                                                                                                                                                                  |
| T3  | **R3** | unit                                       | **The anti-regression test for the design correction.** A **PAID** invoice whose total was edited BELOW its payments → the shrink pass still runs and restores the excess to the credit note (`restoreCreditFromPaymentInTx` invoked for that invoice). Fails if PAID is excluded — i.e. fails against the "reuse `notApplicableStatuses`/`PAYABLE`" design that was almost adopted. `REG-B67` |
| T4  | R1     | unit                                       | A SENT invoice with a balance still RECEIVES credit — positive control that the new exclusion did not over-exclude. `REG-B67`                                                                                                                                                                                                                                                                  |
| T5  | R2     | unit                                       | The primitive is exercised through a `send()`-shaped caller (orderId set, WRITTEN_OFF invoice on the order) → still no application. Proves the fix covers F07's two added call sites without six call-site tests. `REG-B67`                                                                                                                                                                    |
| T6  | R4     | unit                                       | `create({ invoiceId })` where that invoice is **VOID** → rejects `BadRequestException` whose message names the status; **no** `creditNote.create` call. `REG-B66`                                                                                                                                                                                                                              |
| T7  | R4     | unit                                       | Same for a **DRAFT** invoice. `REG-B66`                                                                                                                                                                                                                                                                                                                                                        |
| T8  | R4     | unit                                       | A live **SENT** invoice → creates exactly as before, and the existing over-credit cap still throws when `existing + amount > total`. Pins that the new status read did not disturb the cap. `REG-B66`                                                                                                                                                                                          |
| T9  | R5     | unit                                       | `voidInvoiceInTx` on an invoice with a **fully-unused** sourced credit note (`amountUsed = 0`) → that note is set VOID, inside the same tx (call-order oracle: before the invoice row is finalised). `REG-B66`                                                                                                                                                                                 |
| T10 | R5, R6 | unit                                       | **Partly-used** sourced note (`amount 100, amountUsed 40`) → capped to 40, status not VOID, and **no** `invoicePayment.delete` and **no** `amountUsed` decrement anywhere. Already-spent money is never clawed back. `REG-B66`                                                                                                                                                                 |
| T11 | R5     | unit                                       | A credit note sourced from a DIFFERENT invoice is untouched by the void. `REG-B66`                                                                                                                                                                                                                                                                                                             |
| T12 | R9     | unit (**no REG token** — see hazard above) | `findAll` issues its query with `invoice: { select: { id: true, invoiceNumber: true } }`. Titled descriptively so it cannot discharge the T2 row.                                                                                                                                                                                                                                              |
| T13 | R10    | e2e 28                                     | Credit-note **list**: with `GET /credit-notes` mocked to return a row whose `invoice.invoiceNumber` is `INV-2026-0042`, the row renders that string and **not** the UUID. Asserts the page loaded first (heading visible) so an absence assertion cannot pass on a broken page. `REG-B19`                                                                                                      |
| T14 | R7     | e2e 28                                     | Credit-note **detail**: page loads (number heading visible) AND `getByRole("button", { name: "Issue Credit Note", exact: true })` has count 0. Load-first ordering is what stops this from passing on a 500. `REG-B18`                                                                                                                                                                         |
| T15 | R11    | e2e 28                                     | Invoice **detail** for a customer with a mocked advance balance → an **Apply advance** action is visible and opens its sheet. `REG-B13`                                                                                                                                                                                                                                                        |

Coverage: R1→T1,T2,T4 · R2→T5 · R3→T3 · R3a→T1–T5 (all read the shared constants) · R4→T6,T7,T8 ·
R5→T9,T10,T11 · R6→T10 · R7→T14 · R8→build (no references remain) · R9→T12 · R10→T13 ·
R11→T15 · R12→build (hook deleted, no callers).

**Red gate** (must fail on assertions, none passing):

```
cd apps/api && npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts
```

Spec 28 is NOT in the red gate — it only runs against a deployed build (T2,
proven-pending-deploy). The pins file is excluded from the gate by design.

**Mutation probes (post-implementation, run by hand as with F07):** drop WRITTEN_OFF from
`CREDIT_SETTLE_EXCLUDED` → T1 red · add PAID to it → **T3 red** (the design-correction probe) ·
drop the status read in `create()` → T6 red · drop the void-side credit capping → T9 red ·
change the cap to zero out `amountUsed` → T10 red.

**Standing traps:** never run Playwright from a subagent; `--reporter=list` if ever listing;
after any scoped `jest -t` run, re-run the FULL suite last and CHECK `api.json`'s mtime
(`turbo run test --force` if stale) — a rebase cannot bust turbo's cache.

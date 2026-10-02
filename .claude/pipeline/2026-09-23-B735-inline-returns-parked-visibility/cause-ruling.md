# B735 — Cause ruling (S3)

- **Bug:** B735 — inline-returns capture dialog shows unconditional "Return recorded" when the B681 park guard parked the ledger reversal instead of booking it.
- **Stage:** S3 fix ruling (Fable, no repo access — ruled over S1 + S2 verbatim).
- **Date:** 2026-09-22
- **Scope constraint (from assignment):** operator path only. Server-side fix may touch `approve()`; no new driver-facing UI.

---

## 1. Cause verdict

**ACCEPTED — S2's CONFIRMED verdict stands, with S2's correction to S1 adopted as the defect statement.**

The defect is precisely: *the park state is invisible at capture time*. It is not "lost forever" (report warning + filing block surface it later), so the fix is a capture-time visibility fix, not a ledger fix. That framing matters for the build: nothing about the park write, the report, or the filing gate changes.

Two places S2's reasoning is thin, neither rising to a send-back because neither changes the cause:

- S2 asserts the standard-returns LINE_UNIT caller of `reverseReturnEntries` "can never park" without showing why. Under the fix design below (fresh read, no signature change) this claim is load-bearing only for the sibling sweep, not for the fix. The sweep must prove it rather than inherit it (§5).
- S2 left `regulatedLedgerParkedReversal`'s membership in the `forTenant()` extension unverified. This is a build-plan verification item, not a cause question — the fix is written so the answer cannot make it wrong (§2, tenant clause).

No question sent back.

---

## 2. Fix design (minimal diff)

### Ruling on the design question: **fresh DB read at the response boundary. Threaded return value is rejected.**

Reasons, in order of weight:

1. **The three replay exits.** `capture()` has a pre-read short-circuit, an in-lock race check, and a P2002-conflict catch, none of which call `reverseLedgerForReturn`. A threaded value covers only the fourth (main) path. A double-tap or retry of a parked capture would render clean — and an existing dialog test already exercises exactly the retry case. A fix that is correct on the first click and wrong on the second is not a fix.
2. **Correct after cancel for free.** `unreverseReturnEntries` deletes unresolved parked rows on cancel; a `resolvedAt: null` read reflects that with no extra code. A threaded value would need its own invalidation story.
3. **Zero signature change** to `reverseReturnEntries` / `reverseLedgerForReturn`, so the other caller (standard returns) is untouched and out of the blast radius.
4. Cost is one indexed `findMany` per capture/approve response. Acceptable.

### The invariant (one testable sentence)

> Every `capture()` and `approve()` response carries `parkedReversals` equal to the unresolved `RegulatedLedgerParkedReversal` rows for that `returnId` **as of the moment the response is built** — on every exit path including the three replay exits — and the operator dialog renders the parked warning if and only if `parkedReversals` is non-null.

### Edits, file by file

**(a) `apps/api/src/inline-returns/inline-returns.service.ts`** — the only server change.

Add one private helper:

```ts
private async withParkedReversals<T extends { id: string; tenantId: string }>(
  ret: T,
  db: PrismaClientLike = this.prisma,   // tx client when called inside a transaction
): Promise<T & { parkedReversals: InlineReturnParkedReversals | null }> {
  const rows = await db.regulatedLedgerParkedReversal.findMany({
    where: { returnId: ret.id, tenantId: ret.tenantId, resolvedAt: null },
    select: { <quantity column> : true },
  });
  if (rows.length === 0) return { ...ret, parkedReversals: null };
  return {
    ...ret,
    parkedReversals: { count: rows.length, pieces: rows.reduce((s, r) => s + r.<quantity>, 0) },
  };
}
```

Apply it at **every** `return` of a `Return` row in `capture()` — four sites: (1) pre-read short-circuit, (2) in-lock race check, (3) P2002-conflict catch, (4) main path tail (`result.ret`) — and at the single `return` of `approve()` (the raw `findUnique`). The builder must enumerate all four `capture()` exits in the diff; a missed exit is a build failure, and the regression tests in §3 pin three of them.

Rules the helper must obey:

- **Ordering/visibility:** the read runs *after* `reverseLedgerForReturn` has resolved on that path, on a client that can see its writes — the tx client if the return happens inside the transaction, `this.prisma` if after commit. Never before, never concurrently.
- **Tenant clause:** `tenantId` is in the `where` unconditionally. This makes the fix correct whether or not `regulatedLedgerParkedReversal` is inside the `forTenant()` extension. The build plan still verifies the extension membership (S2's open item) and records the answer in the task brief; if the model somehow lacks a `tenantId` column, that is a send-back to me, not a silent drop of the clause.
- **`resolvedAt: null` only.** A resolved row means the reversal was later booked; it must not warn.
- Return type of `capture()`/`approve()` becomes `Return & { parkedReversals: InlineReturnParkedReversals | null }`; the value is **always emitted** (`null`, never `undefined`) on the server.
- **DRIVER_CAP / overCap capture** legitimately yields `parkedReversals: null` — nothing is parked yet because the reversal is deferred to `approve()`; the hold is already signalled by `holdReason`. Do not conflate the two.

**(b) `packages/types/api/inline-returns.ts`** — additive type only.

```ts
export interface InlineReturnParkedReversals { count: number; pieces: number }
// on InlineReturnRecord:
parkedReversals?: InlineReturnParkedReversals | null;
```

Optional (`?`) in the shared type so no existing fixture or mobile consumer breaks; the server nonetheless always emits it (pinned by §3). `count` = parked rows, `pieces` = summed quantity — the partial-park case (one product parked, sibling reversed normally) is why this is not a boolean.

**(c) `apps/web/.../RecordInlineReturnDialog.tsx`** — success view only.

- The heading stays **"Return recorded"**. It is true: the Return row, credit note and refund are real. The bug is a missing warning, not a wrong heading.
- Below the existing `returnNumber` / `creditNoteId` / `refundAmount` block, render **iff `parkedReversals` is non-null**, a warning callout with `data-testid="inline-return-parked-warning"`:

  > Ledger reversal parked — {pieces} piece(s) across {count} line(s) could not be booked to the regulated ledger. It stays on the regulated report until resolved.

- **Copy constraint:** the parked copy must contain neither the substring "held" nor "approve" (the existing holdReason pin asserts their absence on the success view, and the retry pin requires plain success either time). "parked" / "not booked" / "regulated report" are the allowed vocabulary.
- No new action, no block, no button. `undefined` (older server) is treated as `null`.

**(d) `apps/web/lib/api/inline-returns.ts`** — conditional. If `capture()` there is typed as returning `InlineReturnRecord`, no change. If it re-declares or maps the shape, add the field (and that is itself a `@routeflow/types` convention violation to note, not fix, in the review pack).

**Not touched:** `regulated-ledger.service.ts`, `parkReturnReversal`, `reverseReturnEntries`, `reverseLedgerForReturn`, standard returns, report, filing, cancel, mobile.

---

## 3. Regression tests

All REG tests must be **red on the current tree at the stated wrong value** before the fix task runs (bug-pipeline repro-first rule).

**API — `apps/api/src/inline-returns/inline-returns.service.spec.ts`**

| id | setup | wrong today | must assert after |
|---|---|---|---|
| `REG-B735-api-capture-parked` | main path; `reverseReturnEntries` mocked resolve; `regulatedLedgerParkedReversal.findMany` mocked → `[{qty:3},{qty:2}]` | `res.parkedReversals === undefined` | `toEqual({ count: 2, pieces: 5 })`; `findMany` called with `where` containing `returnId`, `tenantId`, `resolvedAt: null` |
| `REG-B735-api-capture-clean` | main path; `findMany` → `[]` | `undefined` | `toBeNull()` (strictly `null`, not `undefined`) |
| `REG-B735-api-capture-replay-shortcircuit-parked` | same `returnKey` pre-read short-circuit exit; `findMany` → `[{qty:4}]`; assert `reverseReturnEntries` **not** called | `undefined` | `{ count: 1, pieces: 4 }` |
| `REG-B735-api-capture-replay-p2002-parked` | P2002 catch exit; `findMany` → `[{qty:4}]` | `undefined` | `{ count: 1, pieces: 4 }` |
| `REG-B735-api-capture-race-parked` | in-lock race-check exit (if mockable at the unit boundary; otherwise a `.db.spec.ts` lane case) | `undefined` | `{ count: 1, pieces: 4 }` |
| `REG-B735-api-capture-overcap-null` | DRIVER_CAP/overCap capture; `findMany` → `[]` | `undefined` | `toBeNull()` and `holdReason` present — the two signals are independent |
| `REG-B735-api-approve-parked` | `approve()` reverses then `findUnique`; `findMany` → `[{qty:1}]` | `undefined` | `{ count: 1, pieces: 1 }` |

The three replay rows are the ones that distinguish fresh-read from threading; they are not optional.

**Web — `RecordInlineReturnDialog.test.tsx`**

| id | setup | wrong today | must assert after |
|---|---|---|---|
| `REG-B735-web-dialog-parked-warning` | capture resolves with `parkedReversals: { count: 1, pieces: 4 }` | `queryByTestId("inline-return-parked-warning") === null` | present; text matches `/parked/i` and contains `4`; heading still "Return recorded" |
| `REG-B735-web-dialog-parked-copy-vocab` | same render | (new) | rendered success view text contains neither `/held/i` nor `/approve/i` |
| `REG-B735-web-dialog-no-field-no-warning` | capture resolves with **no** `parkedReversals` key (older server) | (new, back-compat) | warning absent, plain success |

**Pins of the two existing behaviours S2 found (must stay green throughout):**

| id | behaviour |
|---|---|
| `PIN-B735-web-dialog-replay-success` | existing test: retry with the same `returnKey` shows success both times — **extend** with a variant where both responses carry `parkedReversals` non-null and assert the warning renders both times too |
| `PIN-B735-web-dialog-holdreason-plain` | existing test: response with `holdReason` and `parkedReversals: null` shows plain success, no "held"/"approve" text, and **no** parked warning |

**Type:** no parity spec exists for this response (S2 §5); the API spec rows above assert on the typed `capture()` return, which is the pin. Do not add a parity spec in this bug.

---

## 4. Blast radius (review-pack.mjs context pairs)

Line numbers are not available to S3; anchors are by symbol/text and the pack script should resolve them.

**fix-1 — `apps/api/src/inline-returns/inline-returns.service.ts`**
- `[before: "return result.ret;" (capture main-path tail), after: "return this.withParkedReversals(result.ret, <tx|this.prisma>);"]`
- `[before: "return existing;" (pre-read short-circuit exit, whatever the local name), after: "return this.withParkedReversals(existing);"]`
- `[before: "return <raced row>;" (in-lock race-check exit), after: "return this.withParkedReversals(<raced row>);"]`
- `[before: "return <replayed row>;" (P2002 catch exit), after: "return this.withParkedReversals(<replayed row>);"]`
- `[before: "return this.prisma.return.findUnique({ where: { id } ... })" (approve tail), after: "return this.withParkedReversals(await this.prisma.return.findUnique(...))"]`
- `[before: (no helper), after: "private async withParkedReversals(" declaration]`

**fix-2 — `packages/types/api/inline-returns.ts`**
- `[before: "export type InlineReturnRecord =" (or interface) declaration line, after: same declaration + "parkedReversals?: InlineReturnParkedReversals | null;"]`
- `[before: (none), after: "export interface InlineReturnParkedReversals { count: number; pieces: number }"]`

**fix-3 — `apps/web/.../RecordInlineReturnDialog.tsx`**
- `[before: the success-branch JSX that renders refundAmount (last existing field), after: same + the `data-testid="inline-return-parked-warning"` block guarded by `result.parkedReversals`]`

**fix-4 (conditional) — `apps/web/lib/api/inline-returns.ts`**
- `[before: capture() return-type annotation, after: unchanged if it is InlineReturnRecord; else the mapped/declared shape gains parkedReversals]`

Review scope: these four files plus the two spec files. Nothing in `regulated-ledger/`, `returns/`, `credit-notes/`, or mobile.

---

## 5. Sibling pattern

**Plausible — one grep, sweep result is a list, not fixes.**

Shape: a `Promise<void>` service method whose only degraded-path signal is a `logger.warn(` (or `.log(`), whose caller returns a raw Prisma row / response type with no field for that state.

Multiline regex (ripgrep `-U`):

```
rg -nU --type ts 'async \w+\([^)]*\)\s*:\s*Promise<void>\s*\{[\s\S]{0,2500}?this\.logger\.(warn|log)\(' apps/api/src/regulated-ledger apps/api/src/returns apps/api/src/inline-returns apps/api/src/credit-notes apps/api/src/invoices
```

Then for each hit, one hop up: does the public method that calls it `return` a Prisma row / `@routeflow/types` record with no field describing the warned state? Expected hits to adjudicate:

- other `park*` / classify-fallback paths in `regulated-ledger.service.ts` (same B681 family) — most likely true siblings;
- the standard-returns LINE_UNIT reversal path — the sweep must *prove* S2's "can never park" claim by reading `classifySaleAxis`'s inputs on that path, not restate it;
- any credit-note / invoice ledger-posting helper that logs-and-continues on an unclassifiable axis.

Same-bug siblings (a park that reaches an operator-facing response with no signal) get fixed in this diff **only** if they are on the operator inline-returns path; anything else is filed via `bugs.mjs`, not fixed here.

---

## 6. Data repair

**No.** Display/visibility defect only. Parked rows are correct and already surface via the regulated report and the filing gate; no persisted value is wrong.

---

## 7. Probe plan (fix-revert probes)

| touched file | revert probe | REG test that must go red |
|---|---|---|
| `apps/api/src/inline-returns/inline-returns.service.ts` | revert the whole file | `REG-B735-api-capture-parked`, `REG-B735-api-capture-clean` (null vs undefined), `REG-B735-api-capture-replay-shortcircuit-parked`, `REG-B735-api-capture-replay-p2002-parked`, `REG-B735-api-approve-parked` |
| same file, **partial** probe: revert only the short-circuit and P2002 call sites, keep the main path | proves the replay exits are independently pinned | `REG-B735-api-capture-replay-shortcircuit-parked`, `REG-B735-api-capture-replay-p2002-parked` red; `REG-B735-api-capture-parked` stays green |
| `apps/web/.../RecordInlineReturnDialog.tsx` | revert the file | `REG-B735-web-dialog-parked-warning` red; both PIN tests stay green (the revert must not break them — if it does, the pins were wrongly coupled to the fix) |
| `packages/types/api/inline-returns.ts` | revert the file | not a Jest test: `npm run check-types` red in `apps/web` (dialog references `parkedReversals`) and in `apps/api` (service return type). Record the probe as a check-types probe, not a REG probe. |

Harness-integrity: the partial probe above is the one that catches a builder who fixed only the main path and made the replay tests pass by mocking `findMany` globally — the review must confirm each replay test asserts `reverseReturnEntries` was **not** called on that path.

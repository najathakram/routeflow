# S2 cause refutation — B735 (sha bc7b0ad9)

**Verdict: CONFIRMED, with a refined divergence point.** The park itself works as SA-067 intends. What goes wrong is that capture() builds its response without checking for a park.

## 1. Call chain (re-derived; brief's lines drift by 1-10 at most)
- `regulated-ledger.service.ts:409` `reverseReturnEntries(): Promise<void>`. Park branch `:586-598`: `parkReturnReversal` (`:380-399`, createMany skipDuplicates + warn), then `remaining = 0; break`. Nothing is returned. Every exit is a bare `return` (`:411,423,429,683`).
- `inline-returns.service.ts:93` `reverseLedgerForReturn(): Promise<void>` awaits each source order in turn and captures nothing (`:103-113`). It is called at `:313` (non-overCap only) and at `:545` (approve).
- `capture()` `:146 Promise<any>`. Its tail `:359-365` returns the raw Prisma Return (`findUnique include items`, or `result.ret`) and never reads park state. **This is the diverging line.**
- `packages/types/api/inline-returns.ts` `InlineReturnRecord` has no park field.

## 2. Does anything read parked rows on the capture path? No.
Every non-schema reader: `parked-reversals.ts:32 listParkedReversals` (filters by period bucket, not returnId), `regulated-report.service.ts:189` (PARKED_REVERSALS warning), `regulated-filing.service.ts:108` (assertNoParkedReversals blocks filing), and `unreverseReturnEntries:702` (cancel deletes unresolved rows). None of these is in capture()'s path.
Nuance: the claim that the log is "the only signal" is too strong. The park does surface later as a report warning and a filing block. It is invisible at capture time, which is the actual bug.

## 3. Open unknowns
1. **Coverage:** `inline-returns.service.spec.ts:128` mocks `reverseReturnEntries` as `mockResolvedValue(undefined)`, so no test runs capture with a park. `regulated-ledger.service.spec.ts:1310-1728` cases (a) through (f) and the productPackNow cases assert createMany and the warn only; there is no return value to assert. Dialog test `:255` pins "a retry with the same returnKey renders success either time". Dialog test `:350` pins "a response with holdReason still renders plain success" (no `held`/`approve` text).
2. **Fix point:** see the recommendation below.
3. **DRIVER_CAP:** confirmed. The overCap branch `:308-335` skips restock and reversal and writes only the audit row. `approve()` `:545` reverses, then returns a raw findUnique (`:552`), so it has the same gap.
4. **Parity spec:** there isn't one for capture. `inline-returns-quote-response-parity.spec.ts` pins only the quote interfaces (PricedChunk/QuoteBreakdown ↔ InlineReturnQuote*). The types header (`inline-returns.ts:~130-135`) says outright that InlineReturnRecord is typed from the Prisma model "rather than a service return-type parity spec". An additive field breaks no spec, but nothing pins it either.

## 4. Client callers of inline approve: none (confirmed)
- `web/lib/api/returns.ts:126` posts `/returns/${id}/approve`. That hits controller `:160` (the STANDARD `returnsService.approve`), not `inline/:id/approve` (`:80`).
- `web/lib/api/inline-returns.ts` calls only quote (`:45`) and capture (`:62`).
- Mobile has no `returns/inline` hit.
- The dialog header `:7` says there is no approve UI yet.

## Recommendation: fresh DB read, not threading a return value
After the tx commits, capture() (and approve()) should run `regulatedLedgerParkedReversal.findMany({ where: { returnId, resolvedAt: null } })` and add the result to the response, e.g. `parkedReversals: { count, pieces }` or null.
- The fresh read covers all three replay branches: the pre-read at `:164-180`, the in-lock race at `:213-227` and the P2002 catch at `:340-349`. None of them calls reverseLedgerForReturn. Threading a value up would therefore show a parked capture as clean on an offline retry or double-tap, which is exactly the path dialog test `:255` exercises.
- One helper serves both capture and approve. There are no signature changes to `reverseReturnEntries`, which has LINE_UNIT callers that can never park.
- The read stays correct after cancel (`:702` deletes unresolved rows).
- It is cheap: the unique index `(returnId, saleEntryId)` leads with returnId.

Before building, S3 must check:
- that the model is tenant-scoped through `forTenant()` (prisma-mock lists it in both proxies, `:132`/`:209`, but I have not verified this);
- the partial-park shape: one multi-product return can park product A while reversing B, and a park consumes that product's whole remaining quantity (`:597`). A count or pieces field fits this better than a boolean.

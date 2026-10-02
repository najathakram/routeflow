# Cause brief — B735 inline-returns-parked-visibility

> S1, written in-session against a fresh worktree pinned to origin/master `bc7b0ad9` (fleet lead's
> stated base sha). Facts with evidence only — every claim carries a file:line or quoted source.

## The bug as stated

- **Source** (`.claude/campaign/bugs/B735.md`, quoted): "The inline-returns capture screen (#1250)
  displays a return number, credit note and refund amount on every successful capture. Underneath,
  capture() calls reverseLedgerForReturn(), which the B681 park guard (#1255, merged same batch)
  can now silently PARK instead of reversing when the row's basis can't be safely determined — the
  function returns void, and the only signal is a server-side warning log. Neither the capture
  response type nor the dialog carries any notion of a park, so an operator completing a return has
  no way to know one happened."
- **Repro**: capture an inline return whose SALE row's box/piece axis is legacy/unknown (pre-B661
  or unclassifiable) → operator dialog shows "Return recorded" with return #, credit note link,
  refund amount — **identical to a normal capture** → **expected**: some visible signal that the
  regulated ledger reversal did not happen and is parked.
- **Suspected cause (claim, unverified)**: the bug finder's own read — `reverseLedgerForReturn`
  returns `void`, "the only signal is a server-side warning log."

## Code path (verified directly against the pinned worktree, not assumed from the registry)

1. `apps/web/.../RecordInlineReturnDialog.tsx:216` — `captureMutation.mutate(...)`, `onSuccess:
   (data) => { setResult(data); setStep("success"); }`. No branch on any park signal — none exists
   to branch on.
2. `RecordInlineReturnDialog.tsx:513-556` — the `step === "success"` block renders "Return
   recorded" plus return #, credit note link, refund amount, order link — **unconditionally**, off
   fields (`returnNumber`, `creditNoteId`, `refundAmount`) that all come from `result`, itself the
   raw API response.
3. `packages/types/api/inline-returns.ts:130-186` — `InlineReturnRecord`, the web-side mirror of
   the capture response. Header comment (verbatim): "No response DTO on the api side either —
   these methods are typed `Promise<any>` and return the raw Prisma `Return` row." No field
   anywhere in the interface represents a park.
4. `apps/api/src/returns/inline-returns.service.ts:146` — `async capture(dto, user):
   Promise<any>`. Ends (`:355-365`) `return this.prisma.forTenant().return.findUnique(...)` or
   `return result.ret` — a raw Prisma `Return`/`ReturnItem[]` row. No additive field.
5. `inline-returns.service.ts:309-311` (non-`overCap` branch only): `await
   restockReturnItems(tx, created, user.sub); await this.reverseLedgerForReturn(tx, created);` —
   the return value of `reverseLedgerForReturn` is not read (it has none).
6. `inline-returns.service.ts:93-113` — `private async reverseLedgerForReturn(tx, ret):
   Promise<void>`. Groups `ret.items` by `sourceOrderId`, calls
   `this.ledger.reverseReturnEntries({ returnId, orderId, returnedByProduct, returnedUnit:
   "PIECES", db: tx })` once per source order, in an `await`ed loop with **no captured result**.
7. `apps/api/src/regulated/regulated-ledger.service.ts:400-...` — `async reverseReturnEntries(...):
   Promise<void>`. Every internal exit is a bare `return;`.
8. Inside the per-sale-row loop (`:576-596`): `const verdict = classifySaleAxis(...)`; when
   `verdict.state === "legacy" || "unknown"`: calls `await this.parkReturnReversal(db, {...})`,
   sets `remaining = 0`, `break`s — **never pushes anything the caller can read**.
9. `parkReturnReversal` (`:379-395`, `Promise<void>`): `await
   db.regulatedLedgerParkedReversal.createMany({ data: [row], skipDuplicates: true });
   this.logger.warn(...)`. This IS the "only signal" the bug describes — a server log line and a
   DB row in `RegulatedLedgerParkedReversal`, both invisible to the HTTP response.

**Diverging point**: step 9 (the park write) is the last place the fact "this reversal did not
happen" exists as data. Every hop from there back up to step 2 (the dialog) is a `Promise<void>`
or an untouched pass-through — the information is generated once, at the bottom of the call stack,
and discarded at every return boundary above it.

## History

- `3ff8b142` (#1255, "B681 park guard... SA-067", 2026-09-22) ADDED `parkReturnReversal`/the
  `classifySaleAxis` branch into `reverseReturnEntries` — genuinely new behavior this batch, not
  a pre-existing gap. Before it, this function always booked a REVERSAL (never parked).
- `inline-returns.service.ts` last touched by `baf9f7ea` (#1221, unrelated caller-axis fix);
  `reverseLedgerForReturn`'s `void` signature predates #1255 and wasn't wrong until #1255 gave
  it something worth signaling.
- Registry's own 2026-09-23 note: same gap independently reachable from `POST
  /returns/inline/:id/approve` (driver-cap-hold defers reversal to `approve()`), but no client
  calls that endpoint today (grepped web+mobile) — no UI blind yet, but any future
  driver-approval UI must apply the same fix.

## Existing tests around this behavior

- `regulated-ledger.service.spec.ts` (not yet read in full — S2 should check whether it asserts
  `parkReturnReversal` is called, and whether anything currently asserts the RETURN VALUE of
  `reverseReturnEntries`/`reverseLedgerForReturn`/`capture()` in a parked scenario; the registry
  and this brief strongly suggest nothing does, since the bug exists).
- `RecordInlineReturnDialog` likely has a test file under the same directory — not yet read; S2 or
  the test-plan stage should check what the "success" step's existing tests assert today (almost
  certainly only the non-parked happy path, given the bug's existence).

## Production evidence

- None gathered — this is a fresh-code gap (the parking behavior itself landed same-batch,
  2026-09-22), not a reported production incident with corrupted rows. No PII/client data
  involved.

## Open unknowns for S2

1. **Confirm, don't assume**: does `capture()`'s non-`overCap` branch truly have NO way today to
   know a park happened, or does something read `RegulatedLedgerParkedReversal` afterward that
   this brief missed? (Grepped `parkedReversal` case-insensitively across `apps/api/src` — only
   hits were inside `regulated-ledger.service.ts` and `regulated-filing.service.ts`'s
   `assertNoParkedReversals` gate, neither of which is in `capture()`'s call path.)
2. **The natural fix point**: does `reverseLedgerForReturn` need to return a value (a count/bool),
   threaded through `capture()`'s response, or is a fresh read of
   `RegulatedLedgerParkedReversal` (by `returnId`) immediately before `capture()` returns more
   robust — it would also cover the REPLAYED-capture branch (`:340-348`, which never calls
   `reverseLedgerForReturn` at all on a race-replay) and requires no signature change through 3
   layers of `Promise<void>`. S3 should rule on this explicitly; it changes the diff shape a lot.
3. **DRIVER_CAP scope**: confirm the `overCap` branch truly never calls
   `reverseLedgerForReturn`/reaches parking at capture time (this brief's read of
   `inline-returns.service.ts:309-335` says yes — reversal is skipped entirely when `overCap`,
   deferred to `approve()`) — if so, the fix's response-shape change should still be safe to leave
   `null`/absent on that branch, matching `holdReason`'s existing "OFFICE capture never sets this"
   convention.
4. Confirm no other reader of `capture()`'s response (mobile, if inline returns reach it; any
   other web caller) would be broken by an additive field — additive-only per the bug's own
   suggested shape, so this should be low risk, but check the parity spec's discipline (`packages/
   types/api/inline-returns.ts:135` mentions "a service return-type parity spec" — find and read
   it before designing the field).

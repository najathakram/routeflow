# F07 lesson — staged for `.claude/lessons/LESSONS.md`

`.claude/lessons/` does not exist on this branch's base (`df1ef9a3`, which predates #571). The
register reaches this worktree only via the rebase onto post-#571 master, so the entry is staged
here and **appended at rebase time, before merge** — never written into whatever tree a hook
happens to run from (fleet policy: that would land the entry in another session's working tree
and surface as a mystery diff in their PR).

**Re-derive the id against the MERGED register** rather than assuming `L-026`: several entries are
queued in parallel (routeflow-7d owns an artifact-freshness rule, the mobile session has one with
the fleet lead, and this is a third). Category: **domain**.

---

### L-0XX · 2026-09-01 · domain · F07

- **Symptom:** cancelling an order silently destroyed value three different ways — it voided the
  invoice for goods already delivered, never returned the creation-time stock decrement, and its
  sibling `deleteOrder` skipped the regulated-ledger reversal both other invoice-destruction paths
  performed. Each had shipped green.
- **Root cause:** the conservation rules were built for the *edit* path (`settleStockForEdit`
  clamps a credit-back to the undelivered remainder; `voidInvoiceInTx`/`deleteInvoice` reverse the
  ledger) and the *teardown* paths were simply never enrolled in them. The signal each fix needed
  already existed in the same file — `deliveredQty`, the clamp, the reversal call — and was not
  consulted. Nothing failed loudly, because a conservation law has no natural test: stock is only
  wrong later, and nowhere near the cancel.
- **Lesson:** **When a codebase establishes an invariant on one path, enumerate every OTHER path
  that reaches the same state and enroll it explicitly — an invariant with a known exception is a
  bug with a scheduled date.** Search by the state being mutated (who else deletes an invoice, who
  else marks an order delivered), never by the feature name; the paths that violate it are the ones
  that do not mention it.
- **Guard:** `orders.lifecycle-conservation.spec.ts` + its pins spec (9 mutation probes). Two
  further instances of this exact class were found by the same search and recorded rather than
  fixed in-scope: `routes.service.ts` `completeStop` flips orders to DELIVERED via raw
  `updateMany`, bypassing the awaited auto-invoice and credit settle; `customers.service.ts`'s
  purge hard-deletes invoices with no ledger reversal — the fourth instance of B65's invariant.

---

**Second, narrower lesson — record only if the register has room under the cap** (it is a genuine
generalizable rule, but the one above is the load-bearing one):

### L-0YY · 2026-09-01 · domain · F07

- **Symptom:** the first implementation of the cancel-side stock return introduced a NEW
  conservation bug: a DRAFT cancel credited no stock (correct — a draft never decremented) but
  still marked its line items CANCELLED, and `reopenOrder` re-decremented every marked line, so a
  draft's cancel→reopen round trip understated stock by the full order quantity.
- **Root cause:** the marker that recorded "this cancel gave stock back" was written
  unconditionally while the give-back itself was conditional. Two halves of one decision, expressed
  as two independent statements.
- **Lesson:** **When one write is the RECORD of another write having happened, the two must share a
  single condition — not two conditions that happen to agree today.** Bind them to one named
  boolean so the pairing is visible and testable.
- **Guard:** `REG-B64 (T7)` asserts a DRAFT cancel neither credits stock nor marks its lines;
  mutation probe 3 (make the flip unconditional) turns it red.

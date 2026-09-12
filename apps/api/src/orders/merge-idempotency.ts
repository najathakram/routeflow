import { createHash } from "crypto";

// Canonical JSON: object keys sorted, undefined-valued keys dropped (an absent field and a
// missing field fingerprint the same), arrays kept in order at this level.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * B215: the fingerprint of a staff merge request, stored as OrderIdempotencyKey.responseHash.
 * A same-key retry is replayed only when its fingerprint matches; a same key with a different
 * cart is refused (409), mirroring create()'s R4 content check. Neither item order NOR
 * credit-note order matters — both are SETS on the wire (the client sends whatever order its
 * selection UI happens to hold), so an order-sensitive fingerprint refused an honest retry of
 * the identical cart with a 409.
 */
export function mergeRequestHash(input: {
  customerId: string;
  items?: readonly unknown[] | null;
  appliedCreditNotes?: unknown;
}): string {
  const items = (input.items ?? []).map(stable).sort();
  // Same treatment as `items`: stable-serialize each entry, then sort the serialized strings.
  // A non-array value (null / undefined / an object) is fingerprinted as-is — only a list has
  // an order to normalize away.
  const appliedCreditNotes = Array.isArray(input.appliedCreditNotes)
    ? input.appliedCreditNotes.map(stable).sort()
    : (input.appliedCreditNotes ?? null);
  return createHash("sha256")
    .update(
      stable({
        customerId: input.customerId,
        items,
        appliedCreditNotes,
      }),
    )
    .digest("hex");
}

/**
 * B215: the machine-readable `code` on both Idempotency-Key 409 bodies from
 * `findOrderIdByIdempotencyKey`. Clients branch on this (mobile NewOrderScreen offers
 * "Open order" using the body's `orderId`) the same way they branch on the merge branch's
 * `MERGE_CHOICE_REQUIRED` and the lock path's `LOCK_UNAVAILABLE`. There is no shared
 * error-code const module in `packages/types` yet — these codes are declared next to the
 * code that throws them, so this lives here rather than beside `MERGE_CHOICE_REQUIRED`
 * (an inline literal in orders.controller.ts).
 *
 * Bodies: `{ code, reason: "CART_MISMATCH" | "HELD_BY_OTHER_ORDER", orderId, message }` —
 * `orderId` is always the order that HOLDS the key.
 */
export const IDEMPOTENCY_KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT";

/**
 * B215/R2 (round 2): a post-delivery merge REPLAY whose partial-billing routing cannot be
 * reproduced from the order's current state. The fold's guard reads the PRE-EDIT cumulative
 * `invoicedQty`, which a replace-all fold resets — so when the current lines show nothing
 * invoiced while finalized invoices still exist, the replay can neither safely resync (it could
 * expand an already-issued invoice to units it never billed) nor safely skip (it would leave the
 * invoice permanently out of step with the edit). It refuses LOUDLY instead and points the
 * operator at the order. Clients treat it like `IDEMPOTENCY_KEY_CONFLICT`: offer "Open order"
 * using the body's `orderId`.
 *
 * Body: `{ code, orderId, message }`.
 */
export const IDEMPOTENCY_REPLAY_NEEDS_RECONCILE = "IDEMPOTENCY_REPLAY_NEEDS_RECONCILE";

/**
 * B215/R2: the partial-billing guard `updateOrderItems` applies to a POST-DELIVERY edit, as a
 * pure predicate over the line rows it reads — so the replay path can evaluate the SAME rule
 * instead of hard-coding one side of it.
 *
 * "Partial" is CROSS-LINE, not just within a line: a line billed for part of its qty, OR a subset
 * of lines billed in full while siblings are entirely un-invoiced. Both make an in-place resync
 * unsafe (it rebuilds each invoice at the full current line qty). The two safe states proceed:
 * nothing invoiced yet, and every billable line fully invoiced.
 *
 * `true` = skip the in-place resync (the operator reconciles manually).
 */
export function shouldSkipInPlaceResync(
  lines: ReadonlyArray<{ qty?: unknown; invoicedQty?: unknown }>,
): boolean {
  const billableLines = lines.filter((li) => Number(li.qty ?? 0) > 0.001);
  const anyInvoiced = billableLines.some((li) => Number(li.invoicedQty ?? 0) > 0.001);
  const allFullyInvoiced = billableLines.every(
    (li) => Number(li.invoicedQty ?? 0) >= Number(li.qty ?? 0) - 0.001,
  );
  return anyInvoiced && !allFullyInvoiced;
}

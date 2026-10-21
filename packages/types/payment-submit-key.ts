import {
  isDefinitiveSaleRefusal,
  mintSaleKey,
  saleAttemptKey,
  type HeldSaleKey,
} from "./sale-attempt";

/**
 * SA-824 (row 661 step 1): the Idempotency-Key a record-payment dialog sends on the customer
 * money-in writers (POST /invoices/payments/record, POST /invoices/:id/payments,
 * POST /customers/:id/advance-payments). The server claims the key inside the money transaction and
 * replays the stored result on a same-key retry, so a double click or a lost-response retry records
 * the payment ONCE.
 *
 * The rule builds on the shared submit-key rule of the sale ring (row 485, `saleAttemptKey`), keyed on
 * what the server hashes that a dialog edits: amount, method, allocations, status and the bank fields.
 *  - One key per dialog open: create the holder when the dialog opens (or call `reset()` on open).
 *  - Kept across retries: an unknown outcome (no response, a timeout, a 5xx) keeps the key, even if
 *    the form is then edited, so the server's replay or its 409 answers.
 *  - Re-minted on a known outcome (a 2xx, or a 4xx that wrote nothing) or a changed amount, method or
 *    allocation with nothing unknown pending.
 * Payments stay online-only: the mobile offline queue never replays them (unchanged).
 */
export interface PaymentSubmitShape {
  amount: number;
  method: string;
  allocations?: ReadonlyArray<{ invoiceId: string; amount: number }>;
  /** DRAFT or PAID (absent = PAID): a draft retried as a payment is a NEW attempt. */
  status?: string | null;
  bankCharges?: number | null;
  settledAt?: string | null;
}

/**
 * The form identity of one payment attempt: amount, allocations and bank charges to the cent, method,
 * status, bank date, sorted allocations.
 */
export function paymentSubmitFingerprint(p: PaymentSubmitShape): string {
  const money = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "NaN");
  const allocations = (p.allocations ?? [])
    .map((a) => `${a.invoiceId}:${money(a.amount)}`)
    .sort()
    .join(",");
  const charges = p.bankCharges == null ? "" : money(p.bankCharges);
  return [
    money(p.amount),
    p.method,
    allocations,
    p.status ?? "PAID",
    charges,
    p.settledAt ?? "",
  ].join("|");
}

/**
 * The 409 the payment writers send when this Idempotency-Key already recorded a DIFFERENT request
 * (`IDEMPOTENCY_KEY_CONFLICT`, reason `PAYMENT_MISMATCH`). It proves a payment already exists under the
 * key (an earlier attempt whose response was lost), so it is never a "nothing was recorded" refusal.
 */
export function isPaymentKeyConflict(err: unknown): boolean {
  const res = (
    err as { response?: { status?: unknown; data?: { code?: unknown; reason?: unknown } } }
  )?.response;
  return (
    res?.status === 409 &&
    res.data?.code === "IDEMPOTENCY_KEY_CONFLICT" &&
    res.data?.reason === "PAYMENT_MISMATCH"
  );
}

/** The ONE recovery copy for that 409, shared by the web and mobile record-payment dialogs. */
export const PAYMENT_MAY_BE_RECORDED_COPY =
  "This payment may already be recorded. Check the customer's payments before trying again.";

/** The recovery copy for a payment key conflict, or null for any other error. */
export function paymentMayBeRecordedCopy(err: unknown): string | null {
  return isPaymentKeyConflict(err) ? PAYMENT_MAY_BE_RECORDED_COPY : null;
}

/**
 * The holder a record-payment dialog keeps for one open: the sale-attempt rule (`saleAttemptKey`,
 * `isDefinitiveSaleRefusal`) plus two payment rules.
 *  - A payment key conflict (`isPaymentKeyConflict`) proves a payment may already exist under the key:
 *    the key is KEPT and locked (never re-minted), and `mayBeRecorded()` turns true for the dialog copy.
 *  - A 4xx on a RETRY after an unknown outcome proves only that the retry wrote nothing: the key is kept
 *    (the web orders submit-key rule). Only a 2xx, or a 4xx with nothing unknown pending, re-mints.
 */
export function createPaymentKeyHolder(mint: () => string = mintSaleKey) {
  let held: HeldSaleKey | null = null;
  let locked = false;
  let mayBeRecorded = false;
  return {
    /** The key to send for this submit: the held one while the attempt is the same, or locked. */
    keyFor(p: PaymentSubmitShape): string {
      const fingerprint = paymentSubmitFingerprint(p);
      held = locked && held ? held : saleAttemptKey(held, fingerprint, mint);
      return held.key;
    },
    /** Apply the outcome (see above). */
    settle(outcome: { ok: true } | { ok: false; error: unknown }): void {
      if (!held) return;
      if (outcome.ok) {
        held = null;
        locked = false;
        mayBeRecorded = false;
      } else if (isPaymentKeyConflict(outcome.error)) {
        locked = true;
        mayBeRecorded = true;
      } else if (isDefinitiveSaleRefusal(outcome.error)) {
        if (!locked) held = null;
      } else {
        locked = true;
      }
    },
    /** True after a payment key conflict: show PAYMENT_MAY_BE_RECORDED_COPY, never "nothing recorded". */
    mayBeRecorded(): boolean {
      return mayBeRecorded;
    },
    /** The key currently held, or null. */
    peek(): string | null {
      return held ? held.key : null;
    },
    /** A fresh dialog open: forget the held key and any unknown outcome. */
    reset(): void {
      held = null;
      locked = false;
      mayBeRecorded = false;
    },
  };
}

export type PaymentKeyHolder = ReturnType<typeof createPaymentKeyHolder>;

/** The trailing request-config argument: none at all without a key, so a keyless call is unchanged. */
export type PaymentKeyConfig = [] | [{ headers: Record<string, string> }];

/**
 * Send one keyed payment request (web and mobile): the header carries the holder's key for `shape`,
 * and the outcome settles the holder (a success or a definitive refusal re-mints; anything unknown
 * keeps the key for the retry). No holder = no header and no extra argument, exactly as before.
 */
export async function sendWithPaymentKey<T>(
  holder: PaymentKeyHolder | undefined,
  shape: PaymentSubmitShape,
  send: (config: PaymentKeyConfig) => Promise<T>,
): Promise<T> {
  if (!holder) return send([]);
  const key = holder.keyFor(shape);
  try {
    const out = await send([{ headers: { "Idempotency-Key": key } }]);
    holder.settle({ ok: true });
    return out;
  } catch (error) {
    holder.settle({ ok: false, error });
    throw error;
  }
}

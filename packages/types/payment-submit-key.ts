import { createSaleKeyHolder, mintSaleKey } from "./sale-attempt";

/**
 * SA-824 (row 661 step 1): the Idempotency-Key a record-payment dialog sends on the customer
 * money-in writers (POST /invoices/payments/record, POST /invoices/:id/payments,
 * POST /customers/:id/advance-payments). The server claims the key inside the money transaction and
 * replays the stored result on a same-key retry, so a double click or a lost-response retry records
 * the payment ONCE.
 *
 * The rule is the shared submit-key rule of the sale ring (row 485, `createSaleKeyHolder`), keyed on
 * what the server hashes that a dialog edits: the amount, the method and the allocations.
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
}

/** The form identity of one payment attempt: amount and allocations to the cent, method, sorted allocations. */
export function paymentSubmitFingerprint(p: PaymentSubmitShape): string {
  const money = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "NaN");
  const allocations = (p.allocations ?? [])
    .map((a) => `${a.invoiceId}:${money(a.amount)}`)
    .sort()
    .join(",");
  return `${money(p.amount)}|${p.method}|${allocations}`;
}

/** The holder a record-payment dialog keeps for one open. */
export function createPaymentKeyHolder(mint: () => string = mintSaleKey) {
  const holder = createSaleKeyHolder(mint);
  return {
    /** The key to send for this submit (the held one while the attempt is the same or unknown). */
    keyFor(p: PaymentSubmitShape): string {
      return holder.keyFor(paymentSubmitFingerprint(p));
    },
    /** Apply the outcome: a success or a definitive refusal drops the key; anything else keeps it. */
    settle: holder.settle,
    /** The key currently held, or null. */
    peek: holder.peek,
    /** A fresh dialog open: forget the held key and any unknown outcome. */
    reset: holder.startNew,
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

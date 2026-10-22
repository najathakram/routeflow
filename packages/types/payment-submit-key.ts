import { API_ERROR_CODES } from "./api/error-codes";
import { PAYMENT_KEY_ANSWER_STATE } from "./api/payment-key";
import {
  isDefinitiveSaleRefusal,
  mintSaleKey,
  namesCommittedSale,
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

type CodedError = { response?: { status?: unknown; data?: { code?: unknown } } } | null | undefined;
const is409 = (err: unknown, code: string) => {
  const res = (err as CodedError)?.response;
  return res?.status === 409 && res.data?.code === code;
};

/**
 * 409 PAYMENT_KEY_RESOLVED (SA-824 race ruling 2): a Save under a key "Check payment status" already resolved
 * to a tombstone. Nothing was recorded under the key and nothing was written: the key is released.
 */
export function isPaymentKeyResolved(err: unknown): boolean {
  return is409(err, API_ERROR_CODES.PAYMENT_KEY_RESOLVED);
}

/**
 * 409 PAYMENT_KEY_IN_FLIGHT (SA-824 race ruling 3): the resolve waited out its lock behind an uncommitted
 * payment under the key. NOT an answer: the payment may still commit, so the key stays locked (retryable).
 */
export function isPaymentKeyInFlight(err: unknown): boolean {
  return is409(err, API_ERROR_CODES.PAYMENT_KEY_IN_FLIGHT);
}

/** The ONE copy for a Save refused 409 PAYMENT_KEY_RESOLVED (the ruling's fixed copy, web and mobile). */
export const PAYMENT_KEY_RESOLVED_COPY =
  "This payment attempt was cancelled — nothing was charged. Start a new payment.";

/** What "Check payment status" learned: the stored payment, a tombstone, still in flight, or no answer. */
export type PaymentStatusOutcome<T = unknown> =
  | { kind: "found"; payment: T }
  | { kind: "tombstoned" }
  | { kind: "inFlight" }
  | { kind: "error" }
  /** Nothing unknown was held: no call was made. */
  | { kind: "idle" };

/** The fixed copy of the status check (web and mobile): never a raw server message. */
export const PAYMENT_STATUS_COPY = {
  action: "Check payment status",
  checking: "Checking...",
  recorded: "This payment was recorded.",
  notRecorded: "Nothing was recorded. You can try again.",
  /** The resolve closed the key: the ruling's fixed copy. */
  tombstoned: PAYMENT_KEY_RESOLVED_COPY,
  /** 409 PAYMENT_KEY_IN_FLIGHT: retryable. */
  inFlight: "This payment is still being recorded. Check its status again in a moment.",
  error: "We couldn't check right now. Try again in a moment.",
  /** Shown while the outcome is unknown, beside the action that replaces Record. */
  unknownHint:
    "We couldn't confirm this payment. It may already be recorded. Check its status before trying again.",
} as const;

export function paymentStatusCopy(outcome: PaymentStatusOutcome): string {
  switch (outcome.kind) {
    case "found":
      return PAYMENT_STATUS_COPY.recorded;
    case "tombstoned":
      return PAYMENT_STATUS_COPY.tombstoned;
    case "inFlight":
      return PAYMENT_STATUS_COPY.inFlight;
    case "idle":
      return PAYMENT_STATUS_COPY.notRecorded;
    default:
      return PAYMENT_STATUS_COPY.error;
  }
}

/**
 * The fixed copy for a Save refused by the payment key rule (web and mobile, and the app-wide toast): a key
 * conflict (may be recorded), a resolved key (cancelled, nothing charged), a key still in flight. Null for any
 * other error, so the surface keeps its own copy.
 */
export function paymentKeyRefusalCopy(err: unknown): string | null {
  if (isPaymentKeyResolved(err)) return PAYMENT_KEY_RESOLVED_COPY;
  if (isPaymentKeyInFlight(err)) return PAYMENT_STATUS_COPY.inFlight;
  return paymentMayBeRecordedCopy(err);
}

/**
 * True for a payment-writer 4xx that PROVES nothing was written: the sale-attempt rule, plus the coded
 * end-of-day refusal COUNTER_SALE_DAY_CLOSED. A counter SALE commits before its tender (so for a sale that
 * code means "exists"), but the payment writers throw it INSIDE the money transaction after the key claim, so
 * the claim and every payment row roll back with it. A body naming a committed order or invoice is still
 * unknown; 409 PAYMENT_KEY_IN_FLIGHT never is definitive.
 */
function isDefinitivePaymentRefusal(err: unknown): boolean {
  if (isPaymentKeyInFlight(err)) return false;
  if (is409(err, API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED)) return !namesCommittedSale(err);
  return isDefinitiveSaleRefusal(err);
}

/** The answer of POST /invoices/payments/by-key/:key/resolve, read strictly: anything else is no answer. */
function resolvedOutcome<T>(body: T): PaymentStatusOutcome<T> {
  const state = (body as { state?: unknown } | null)?.state;
  if (state === PAYMENT_KEY_ANSWER_STATE.FOUND) return { kind: "found", payment: body };
  if (state === PAYMENT_KEY_ANSWER_STATE.TOMBSTONED) return { kind: "tombstoned" };
  return { kind: "error" };
}

/**
 * The holder a record-payment dialog keeps for one open: the sale-attempt rule (`saleAttemptKey`,
 * `isDefinitiveSaleRefusal`, widened by `isDefinitivePaymentRefusal`) plus the payment rules.
 *  - A payment key conflict (`isPaymentKeyConflict`) proves a payment may already exist under the key:
 *    the key is KEPT and locked (never re-minted), and `mayBeRecorded()` turns true for the dialog copy.
 *  - A 4xx on a RETRY after an unknown outcome proves only that the retry wrote nothing: the key is kept
 *    (the web orders submit-key rule). Only a 2xx, or a 4xx with nothing unknown pending, re-mints.
 *  - SA-824 race ruling: 409 PAYMENT_KEY_RESOLVED releases the key even while locked (the key is a tombstone:
 *    nothing is or ever will be recorded under it); 409 PAYMENT_KEY_IN_FLIGHT keeps it locked.
 */
export function createPaymentKeyHolder(mint: () => string = mintSaleKey) {
  let held: HeldSaleKey | null = null;
  let locked = false;
  let mayBeRecorded = false;
  const release = () => {
    held = null;
    locked = false;
    mayBeRecorded = false;
  };
  // Race ruling 5: ONLY a found payment or a tombstone releases; in flight, an error or a 404 never does.
  const resolveStatus = <T>(outcome: PaymentStatusOutcome<T>): PaymentStatusOutcome<T> => {
    if (outcome.kind === "found" || outcome.kind === "tombstoned") release();
    return outcome;
  };
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
      if (outcome.ok || isPaymentKeyResolved(outcome.error)) {
        release();
      } else if (isPaymentKeyConflict(outcome.error)) {
        locked = true;
        mayBeRecorded = true;
      } else if (isDefinitivePaymentRefusal(outcome.error)) {
        if (!locked) held = null;
      } else {
        locked = true;
      }
    },
    /** True while an outcome is unknown: the key is kept and locked, and the dialog offers the status check. */
    hasUnknown(): boolean {
      return locked;
    },
    /**
     * Apply a status answer (race ruling 5): found settles as a success and a tombstone releases the key;
     * in flight or an error changes nothing (still unknown and locked).
     */
    resolveFromStatus: resolveStatus,
    /**
     * "Check payment status": RESOLVE the HELD key (`resolve` is POST /invoices/payments/by-key/:key/resolve,
     * rejecting with the HTTP error) and apply the answer: { state: "found" } or { state: "tombstoned" }
     * releases; 409 PAYMENT_KEY_IN_FLIGHT is "inFlight"; anything else (a 404 included) is "error". Both keep
     * the key locked. Nothing held = nothing unknown: "idle", no call.
     */
    async checkStatus<T>(resolve: (key: string) => Promise<T>): Promise<PaymentStatusOutcome<T>> {
      if (!held || !locked) return { kind: "idle" };
      try {
        return resolveStatus(resolvedOutcome(await resolve(held.key)));
      } catch (error) {
        return resolveStatus<T>(
          isPaymentKeyInFlight(error) ? { kind: "inFlight" } : { kind: "error" },
        );
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
    /**
     * A fresh dialog open: forget a SETTLED key. NEVER while an outcome is unknown (condition b): a
     * Cancel -> reopen must not drop the key the status check and the server's replay depend on.
     */
    reset(): void {
      if (locked) return;
      held = null;
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

/**
 * One holder per payment TARGET (scope + customer / invoice id), kept at module level so it outlives the
 * dialog: a Cancel -> reopen, or an unmount -> remount, of a dialog whose outcome is unknown gets the SAME
 * holder back (same key, still locked, "Check payment status" still offered). The entry is dropped only
 * once the key is released (nothing unknown, nothing in flight): `releasePaymentKeyHolder`.
 */
const holders = new Map<string, PaymentKeyHolder>();

export function acquirePaymentKeyHolder(scope: string, mint?: () => string): PaymentKeyHolder {
  let holder = holders.get(scope);
  if (!holder) {
    holder = createPaymentKeyHolder(mint);
    holders.set(scope, holder);
  }
  return holder;
}

/**
 * Put a holder a live dialog is using back in the registry if its entry was dropped under it (a
 * development double-mount releases an idle entry between the two mounts).
 */
export function adoptPaymentKeyHolder(scope: string, holder: PaymentKeyHolder): void {
  if (!holders.has(scope)) holders.set(scope, holder);
}

/**
 * Called when a dialog unmounts (or its scope changes): drop the scope's holder (and its remembered proof) unless an
 * outcome is unknown or a request is in flight (a key held with no outcome yet).
 */
export function releasePaymentKeyHolder(scope: string): void {
  const holder = holders.get(scope);
  if (!holder || holder.hasUnknown() || holder.peek() !== null) return;
  holders.delete(scope);
  proofs.delete(scope);
}

/** Test seam: forget every holder and proof. */
export function clearPaymentKeyRegistry(): void {
  holders.clear();
  proofs.clear();
}

/**
 * The proof photo (a web `File`, a mobile uri) of the attempt that may have recorded a payment. A status
 * check that finds the payment attaches it, so the photo is not lost when the first response was.
 */
const proofs = new Map<string, unknown>();

/** Remember the proof of the attempt being submitted (null = none). A 2xx forgets it. */
export function rememberPaymentProof(scope: string, proof: unknown): void {
  if (proof == null) proofs.delete(scope);
  else proofs.set(scope, proof);
}

export function forgetPaymentProof(scope: string): void {
  proofs.delete(scope);
}

/** The recovery copy when the photo cannot be attached to a found payment. */
export const PAYMENT_PHOTO_LATER_COPY = "The payment was recorded. Add the photo from the payment.";

/**
 * The id the proof photo attaches to, from a stored payment result (the 2xx path's id): an invoice
 * payment carries `createdPaymentId`; a standalone payment's first allocation row (`payments[0]`) is
 * what the 2xx path uses. Anything else (an invoice result without it, an advance) is not derivable.
 */
export function recordedPaymentId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as {
    scope?: unknown;
    paymentGroupId?: unknown;
    createdPaymentId?: unknown;
    payments?: unknown;
  };
  if (typeof r.createdPaymentId === "string" && r.createdPaymentId) return r.createdPaymentId;
  const standalone =
    r.scope === "STANDALONE_PAYMENT" ||
    (r.scope === undefined && typeof r.paymentGroupId === "string");
  if (!standalone || !Array.isArray(r.payments)) return null;
  const first = r.payments[0] as { id?: unknown } | undefined;
  return typeof first?.id === "string" && first.id ? first.id : null;
}

/** What happened to the proof photo when a status check found the payment. */
export type FoundPhotoOutcome = "none" | "uploaded" | "failed" | "later";

/**
 * The "found" path of "Check payment status": attach the remembered proof photo to the found payment
 * with the same upload the 2xx path uses. "later" = a photo exists but no single payment id is derivable:
 * the dialog shows PAYMENT_PHOTO_LATER_COPY, never a silent loss.
 */
export async function finishFoundPayment<P>(
  scope: string,
  found: unknown,
  upload: (paymentId: string, proof: P) => Promise<unknown>,
): Promise<FoundPhotoOutcome> {
  if (!proofs.has(scope)) return "none";
  const proof = proofs.get(scope) as P;
  proofs.delete(scope);
  const id = recordedPaymentId(found);
  if (!id) return "later";
  try {
    await upload(id, proof);
    return "uploaded";
  } catch {
    return "failed";
  }
}

import { CATCHUP_META } from "./catchup-claim";
import { chargeNowCents } from "./catchup-plan";
import { buildCatchupSessionParams, type CatchupSessionInput } from "./catchup-session-params";

/**
 * SA-800d G2: the deploy date of the fold that started signing every catch-up session. A live session WITHOUT a
 * signature that Stripe says was created AFTER this instant came from a creation path that does not sign: a defect
 * (the service logs it). Sessions created before it and still open at the deploy are expected to be unsigned.
 */
export const SIGNING_SINCE = new Date("2026-10-17T00:00:00Z");

/**
 * Row 542d: do the terms a STORED Checkout session was built with equal the fresh plan's? One pure answer, so
 * `PaymentDueService` never reuses a live session whose Stripe page shows old terms (a $0 card add after the quote
 * flipped to next month's stub, or an old "Pay $X" whose figure no longer matches).
 *
 * Two checks, both read from the metadata `buildCatchupSessionParams` writes on EVERY shape (SA-800c):
 *  1. `catchup_terms_sig`: sha256 of the FULL params sent to Stripe (every line, the trial end, the mode...). The
 *     expected one is computed by the SAME builder from the fresh plan, so a changed price, an add-on, a forgiven
 *     amount or anything the builder learns later is a mismatch with no change here.
 *  2. The metadata terms the signature does NOT cover (it excludes metadata): `catchup_stub_cents`, `catchup_shape`,
 *     `catchup_from` (= S) and `catchup_to` (= A), which the settlement reads. Kept alongside the signature on
 *     purpose: S and the shape live only in metadata for the stub-free `trial` shape.
 * SA-800d: a session with NO signature (created before signing existed) whose other four fields read fine is a
 * `mismatch`: it takes the Stripe-confirmed expire, release, recreate path and is never reused. A MALFORMED signature
 * (present, not 64-hex) or any unreadable field is `unknown`: never guessed. Money is never recomputed here and
 * nothing is charged from it.
 */
export interface ExpectedSessionTerms {
  /** sha256 hex of the full session terms (`catchup_terms_sig`) of a session built from the fresh plan. */
  sig: string;
  /** What the Checkout charges at completion: 0 for the stub-free `trial` shape and for a forgiven line. */
  stubCents: number;
  shape: string;
  /** S: where the unpaid period starts. */
  from: Date;
  /** A: the first charge (the trial end). */
  to: Date;
}

/** match: reuse; mismatch: the session is stale; unknown: a field is missing or unreadable (never guess). */
export type SessionTermsCheck = "match" | "mismatch" | "unknown";

/** What the builder needs to sign a session for the fresh plan: everything but the Stripe customer and the URLs. */
export type ExpectedTermsInput = Omit<
  CatchupSessionInput,
  "customerId" | "successUrl" | "cancelUrl"
>;

/**
 * The terms the session builder would write for this plan: the signature comes from the builder itself (no Stripe
 * call; the customer and URLs are not signed), the rest from the planner's own values.
 */
export function expectedSessionTerms(i: ExpectedTermsInput): ExpectedSessionTerms {
  const params = buildCatchupSessionParams({ ...i, customerId: "", successUrl: "", cancelUrl: "" });
  return {
    sig: params.metadata[CATCHUP_META.termsSig],
    stubCents: chargeNowCents(i.plan),
    shape: i.plan.shape,
    from: i.plan.stub.from,
    to: i.plan.stub.to,
  };
}

/** Same instant, whatever the ISO spelling; two nulls match, a null never matches an instant, junk never matches. */
export function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/** A canonical non-negative integer string ("0", "31000"); anything else (empty, "12.5", "-1", "1e3") is unreadable. */
function parseCents(v: unknown): number | null {
  if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function readInstant(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function checkSessionTerms(
  metadata: unknown,
  expected: ExpectedSessionTerms,
): SessionTermsCheck {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "unknown";
  const m = metadata as Record<string, unknown>;
  const sig = m[CATCHUP_META.termsSig];
  const cents = parseCents(m[CATCHUP_META.stubCents]);
  const shape = m[CATCHUP_META.shape];
  const from = readInstant(m[CATCHUP_META.from]);
  const to = readInstant(m[CATCHUP_META.to]);
  const unsigned = sig === undefined || sig === null;
  // a half-read session decides nothing: an unreadable field (or a malformed signature) wins over a readable mismatch
  if (
    (!unsigned && (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig))) ||
    cents === null ||
    typeof shape !== "string" ||
    shape.length === 0 ||
    from === null ||
    to === null
  ) {
    return "unknown";
  }
  // never reuse an unsigned session (SA-800d); the four metadata terms were readable, so this is a plain mismatch
  if (unsigned) return "mismatch";
  return sig === expected.sig &&
    cents === expected.stubCents &&
    shape === expected.shape &&
    from === expected.from.getTime() &&
    to === expected.to.getTime()
    ? "match"
    : "mismatch";
}

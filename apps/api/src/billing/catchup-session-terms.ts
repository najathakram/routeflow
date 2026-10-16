import { CATCHUP_META } from "./catchup-claim";
import { chargeNowCents, type CatchupPlan } from "./catchup-plan";

/**
 * Row 542d: do the terms a STORED Checkout session was built with equal the fresh plan's? One pure answer, so
 * `PaymentDueService` never reuses a live session whose Stripe page shows old terms (a $0 card add after the quote
 * flipped to next month's stub, or an old "Pay $X" whose figure no longer matches).
 *
 * The session side is the metadata `buildCatchupSessionParams` writes on EVERY shape: `catchup_stub_cents` (what the
 * Checkout charges at completion, i.e. {@link chargeNowCents}), `catchup_shape`, `catchup_from` (= S) and
 * `catchup_to` (= A). Money is never recomputed here and nothing is charged from it: it only decides reuse.
 */
export interface ExpectedSessionTerms {
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

/** The terms the session builder would write for this plan (the very values, so the two cannot drift). */
export function expectedSessionTerms(
  plan: Pick<CatchupPlan, "shape" | "stub">,
): ExpectedSessionTerms {
  return {
    stubCents: chargeNowCents(plan),
    shape: plan.shape,
    from: plan.stub.from,
    to: plan.stub.to,
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
  const cents = parseCents(m[CATCHUP_META.stubCents]);
  const shape = m[CATCHUP_META.shape];
  const from = readInstant(m[CATCHUP_META.from]);
  const to = readInstant(m[CATCHUP_META.to]);
  // a half-read session decides nothing: an unreadable field wins over a readable mismatch
  if (
    cents === null ||
    typeof shape !== "string" ||
    shape.length === 0 ||
    from === null ||
    to === null
  ) {
    return "unknown";
  }
  return cents === expected.stubCents &&
    shape === expected.shape &&
    from === expected.from.getTime() &&
    to === expected.to.getTime()
    ? "match"
    : "mismatch";
}

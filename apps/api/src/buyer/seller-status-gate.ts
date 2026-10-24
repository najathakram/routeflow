import { ForbiddenException } from "@nestjs/common";
import type { Logger } from "@nestjs/common";
import type { TenantStatus } from "@prisma/client";
import { READ_ONLY_STATUS } from "../billing/dunning-config";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA ruling 10-11 A3 (N6), row 390 FLIP: the buyer-side READ_ONLY refusal is ENFORCED. It shipped dark behind
 * `SELLER_READ_ONLY_BUYER_GATE` while the READ_ONLY-sellers-with-buyers count and a week of `would_deny` log counts
 * were read; the owner has now ruled it on. `enforced` (the default, and what any unset or unknown value means: 403
 * SELLER_UNAVAILABLE) | `dark` (the explicit ROLLBACK: allow, and log a `would_deny` line). It is separate from
 * BILLING_PAUSE_MODE because a lapsed trial is READ_ONLY too. Rollback without a deploy is
 * `SELLER_READ_ONLY_BUYER_GATE=dark`; a typo of "dark" stays enforced (a typo can never turn the refusal OFF).
 */
export type SellerReadOnlyBuyerGate = "dark" | "enforced";
export function sellerReadOnlyBuyerGate(
  env: Record<string, string | undefined> = process.env,
): SellerReadOnlyBuyerGate {
  return (env.SELLER_READ_ONLY_BUYER_GATE ?? "").trim().toLowerCase() === "dark"
    ? "dark"
    : "enforced";
}

/** The buyer-facing copy of a seller-status refusal: fixed, neutral, never a reason or anything about billing. */
export const SELLER_UNAVAILABLE_MESSAGE =
  "This seller isn't taking online orders right now. Please check back soon.";

/** The ONE refusal body (403 SELLER_UNAVAILABLE) every seller-status refusal answers with. */
export function sellerUnavailableException(): ForbiddenException {
  return new ForbiddenException({
    code: API_ERROR_CODES.SELLER_UNAVAILABLE,
    message: SELLER_UNAVAILABLE_MESSAGE,
  });
}

export type SellerWriteVerdict =
  /** `wouldDeny`: the gate is dark and the seller is READ_ONLY - allowed, and a `would_deny` line was logged. */
  | { allowed: true; wouldDeny: boolean }
  | { allowed: false; reason: "SELLER_BLOCKED" | "SELLER_READ_ONLY" };

/**
 * SA-776: the ONE rule for a buyer write toward a seller, by the seller's workspace status. Every caller that lets a
 * buyer (or a buyer's sign-in) change what is linked to a seller asks this function and nothing else:
 *   - ACTIVE / TRIAL seller: allowed.
 *   - READ_ONLY seller: governed by `SELLER_READ_ONLY_BUYER_GATE` - `enforced` (the default) refuses, `dark` (the
 *     explicit rollback) allows and logs `would_deny`.
 *   - SUSPENDED / CANCELLED (and any status not listed here): refused always.
 * `context` is the route or flow label that goes into the would-deny line (seller tenant id + route, no buyer data).
 * The caller shapes the refusal itself (a request throws `sellerUnavailableException()`; a redirect flow maps it to an
 * error code) - the decision lives here only.
 *
 * Fail closed: ONLY ACTIVE and TRIAL are allowed outright. A status this function does not know (a value a future
 * migration adds, or a bad row) is refused like SUSPENDED/CANCELLED, never allowed.
 */
export function sellerAcceptsBuyerWrite(args: {
  sellerStatus: TenantStatus;
  sellerId: string;
  /** Defaults to the env gate; a spec may pass one explicitly. */
  gate?: SellerReadOnlyBuyerGate;
  logger: Pick<Logger, "warn">;
  context: string;
}): SellerWriteVerdict {
  const { sellerStatus, sellerId, logger, context } = args;
  if (sellerStatus === "ACTIVE" || sellerStatus === "TRIAL") {
    return { allowed: true, wouldDeny: false };
  }
  if (sellerStatus !== READ_ONLY_STATUS) return { allowed: false, reason: "SELLER_BLOCKED" };

  if ((args.gate ?? sellerReadOnlyBuyerGate()) === "enforced") {
    return { allowed: false, reason: "SELLER_READ_ONLY" };
  }
  // dark: allow, and log what enforced would have refused (seller tenant id + route, no buyer data)
  logger.warn(
    `seller_read_only.would_deny code=${API_ERROR_CODES.SELLER_UNAVAILABLE} seller=${sellerId} route=${context}`,
  );
  return { allowed: true, wouldDeny: true };
}

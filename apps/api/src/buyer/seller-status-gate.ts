import { ForbiddenException } from "@nestjs/common";
import type { Logger } from "@nestjs/common";
import type { TenantStatus } from "@prisma/client";
import { READ_ONLY_STATUS } from "../billing/dunning-config";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA ruling 10-11 A3 (N6): the buyer-side READ_ONLY refusal ships DARK like every new behaviour gate.
 * `SELLER_READ_ONLY_BUYER_GATE` = `dark` (the default: allow, and log a `would_deny` line) | `enforced` (403
 * SELLER_UNAVAILABLE). It is separate from BILLING_PAUSE_MODE because a lapsed trial is READ_ONLY too. An unknown
 * value is `dark`: a typo can never turn the refusal on. The owner flips it after the READ_ONLY-sellers-with-buyers
 * count plus a week of would-deny log counts.
 */
export type SellerReadOnlyBuyerGate = "dark" | "enforced";
export function sellerReadOnlyBuyerGate(
  env: Record<string, string | undefined> = process.env,
): SellerReadOnlyBuyerGate {
  return (env.SELLER_READ_ONLY_BUYER_GATE ?? "").trim().toLowerCase() === "enforced"
    ? "enforced"
    : "dark";
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
 *   - READ_ONLY seller: governed by `SELLER_READ_ONLY_BUYER_GATE` - `dark` (default) allows and logs `would_deny`,
 *     `enforced` refuses.
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

import type { CreditNoteStatus } from "./api/credit-notes";

/**
 * Pure (screen-free, testable) credit-note helpers — status→pill mapping and the
 * detail-screen action gating. Kept out of the RN screens so
 * apps/mobile/__tests__/*.test.ts (pure-logic, node env) can lock them.
 *
 * No line-amount helper: credit notes render a single amount tile (mirrors web),
 * not a line list. If items are ever rendered, reuse the estimates money-safe
 * pattern (prefer server subtotal; fall back to computeLineSubtotal; never
 * qty*unitPrice).
 */

export type PillVariant = "brand" | "green" | "orange" | "red" | "gray" | "purple";

/** Status → badge variant + label. Mirrors the web credit-notes status chips. */
export function creditNotePillFor(status: CreditNoteStatus): {
  variant: PillVariant;
  label: string;
} {
  switch (status) {
    case "DRAFT":
      return { variant: "gray", label: "Draft" };
    case "ISSUED":
      return { variant: "brand", label: "Issued" };
    case "APPLIED":
      return { variant: "green", label: "Applied" };
    case "VOID":
      return { variant: "red", label: "Void" };
    default:
      return { variant: "gray", label: status };
  }
}

export interface CreditNoteActionFlags {
  canIssue: boolean;
  canApply: boolean;
  canVoid: boolean;
}

/**
 * Which detail-screen actions are available for a status. Gated to the SERVER
 * contract to avoid guaranteed error toasts (the estimates precedent):
 *  - Issue → DRAFT only (cosmetic — server issue() is a no-op, DRAFT never
 *            occurs in practice, but mirrors the web DRAFT branch).
 *  - Apply → ISSUED only (matches the web Apply button gating).
 *  - Void  → DRAFT | ISSUED (server also rejects a partially-applied note, which
 *            the client can't see — that rare case error-toasts, same as web).
 * APPLIED and VOID are terminal read-only.
 */
export function creditNoteActionFlags(status: CreditNoteStatus): CreditNoteActionFlags {
  return {
    canIssue: status === "DRAFT",
    canApply: status === "ISSUED",
    canVoid: status === "DRAFT" || status === "ISSUED",
  };
}

/**
 * Dollars still available on a credit note. A partially-applied note stays
 * ISSUED with amountUsed > 0, so `amount` alone is NEVER the open balance.
 * Mirrors web's openCreditBalance (apps/web/lib/api/credit-notes.ts:188).
 */
export function openCreditBalance(cn: {
  amount: number | string;
  amountUsed?: number | string | null;
}): number {
  const amount = Number(cn.amount) || 0;
  const used = Number(cn.amountUsed ?? 0) || 0;
  return Math.max(0, Math.round((amount - used) * 100) / 100);
}

/**
 * Whether a credit note belongs in an "apply to this invoice" list: ISSUED,
 * unexpired, and with dollars remaining. Expiry is a COMPUTED filter — the
 * server never flips a status on expiry, so the list endpoint still returns
 * expired ISSUED notes and apply would 400 ("Credit note has expired").
 */
export function isCreditOpenForApply(
  cn: {
    status: CreditNoteStatus;
    amount: number | string;
    amountUsed?: number | string | null;
    expiresAt?: string | null;
  },
  now: Date,
): boolean {
  if (cn.status !== "ISSUED") return false;
  if (cn.expiresAt && new Date(cn.expiresAt) <= now) return false;
  return openCreditBalance(cn) > 0;
}

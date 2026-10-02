import { roundMoney } from "@routeflow/pricing";
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
  canApply: boolean;
  canVoid: boolean;
}

/**
 * Which detail-screen actions are available for a status. Gated to the SERVER
 * contract to avoid guaranteed error toasts (the estimates precedent):
 *  - Apply → ISSUED only (matches the web Apply button gating).
 *  - Void  → ISSUED only (server also rejects a partially-applied note, which
 *            the client can't see — that rare case error-toasts, same as web).
 * APPLIED and VOID are terminal read-only. (No Issue action — B18: create
 * always writes ISSUED and the server issue() endpoint is gone.)
 */
export function creditNoteActionFlags(status: CreditNoteStatus): CreditNoteActionFlags {
  return {
    canApply: status === "ISSUED",
    canVoid: status === "ISSUED",
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

// ─── #2648 / SA-535(c): Edit a credit note ──────────────────────────────────────

/** What the Edit form holds. `expiry` is a calendar date "YYYY-MM-DD", "" = no expiry. */
export interface CreditNoteEditDraft {
  amount: number | null;
  /** Per-line amounts, keyed by invoiceItemId (line-linked notes only). */
  lineAmounts: Record<string, number | null>;
  reason: string;
  expiry: string;
}

export interface CreditNoteEditSource {
  /** ISSUED is the only status whose expiry can change in place (the server says 400 otherwise). */
  status?: string;
  amount: number | string;
  reason?: string | null;
  expiresAt?: string | null;
  items?: Array<{ invoiceItemId: string | null; amount: number | string }>;
}

export type CreditNoteEditPlan =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "patch"; patch: { reason?: string; expiresAt?: string | null } }
  | {
      kind: "reissue";
      input: {
        amount: number;
        items?: Array<{ invoiceItemId: string; amount: number }>;
        reason?: string;
        expiresAt?: string | null;
      };
    };

/** The server bound on a credit note reason (PATCH and reissue DTOs). */
export const CREDIT_NOTE_REASON_MAX = 450;

const cents = (n: number | string | null | undefined) => roundMoney(Number(n ?? 0));

/** The note's lines that carry an invoice line link (a line-linked note must restate them). */
export function creditNoteLines(note: CreditNoteEditSource) {
  return (note.items ?? []).filter(
    (i): i is { invoiceItemId: string; amount: number | string } => !!i.invoiceItemId,
  );
}

/** The draft's credit amount: Σ lines for a line-linked note, else the amount field. */
export function creditNoteDraftAmount(note: CreditNoteEditSource, draft: CreditNoteEditDraft) {
  const lines = creditNoteLines(note);
  return lines.length
    ? roundMoney(lines.reduce((s, l) => s + cents(draft.lineAmounts[l.invoiceItemId]), 0))
    : cents(draft.amount);
}

/**
 * Mirrors web's EditCreditNoteModal: reason/expiry only ⇒ an in-place PATCH; an amount or line
 * change ⇒ a reissue (void-with-reversal + an unapplied replacement), never in place (SA-500).
 */
export function planCreditNoteEdit(
  note: CreditNoteEditSource,
  draft: CreditNoteEditDraft,
): CreditNoteEditPlan {
  const lines = creditNoteLines(note);
  const amount = creditNoteDraftAmount(note, draft);
  const moneyChanged = lines.length
    ? lines.some((l) => cents(draft.lineAmounts[l.invoiceItemId]) !== cents(l.amount))
    : amount !== cents(note.amount);
  const reason = draft.reason.trim();
  const reasonChanged = reason !== (note.reason ?? "").trim();
  const oldExpiry = note.expiresAt ? note.expiresAt.slice(0, 10) : "";
  const expiryChanged = draft.expiry !== oldExpiry;

  // Mirrors web: a reason that was set can be changed but not blanked, and is bounded (server max 450).
  if (reasonChanged && reason === "" && (note.reason ?? "").trim() !== "")
    return { kind: "invalid", message: "A reason is required." };
  if (reason.length > CREDIT_NOTE_REASON_MAX)
    return {
      kind: "invalid",
      message: `The reason can be at most ${CREDIT_NOTE_REASON_MAX} characters.`,
    };
  // Mirrors web: the expiry field is locked on a non-ISSUED note unless the amount is being changed.
  if (expiryChanged && !moneyChanged && note.status && note.status !== "ISSUED")
    return {
      kind: "invalid",
      message: "The expiry can only be changed while the credit note is unused.",
    };

  if (draft.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(draft.expiry))
    return { kind: "invalid", message: "Enter the expiry as YYYY-MM-DD, or leave it empty." };
  const expiresAt = draft.expiry ? new Date(draft.expiry).toISOString() : null;
  if (expiryChanged && expiresAt && new Date(expiresAt).getTime() <= Date.now())
    return { kind: "invalid", message: "The expiry must be in the future." };

  if (moneyChanged) {
    if (!(amount > 0) || lines.some((l) => !(cents(draft.lineAmounts[l.invoiceItemId]) > 0)))
      return { kind: "invalid", message: "Every amount must be greater than 0." };
    return {
      kind: "reissue",
      input: {
        amount,
        ...(lines.length
          ? {
              items: lines.map((l) => ({
                invoiceItemId: l.invoiceItemId,
                amount: cents(draft.lineAmounts[l.invoiceItemId]),
              })),
            }
          : {}),
        ...(reasonChanged ? { reason } : {}),
        ...(expiryChanged ? { expiresAt } : {}),
      },
    };
  }
  if (!reasonChanged && !expiryChanged) return { kind: "none" };
  return {
    kind: "patch",
    patch: {
      ...(reasonChanged ? { reason } : {}),
      ...(expiryChanged ? { expiresAt } : {}),
    },
  };
}

/**
 * Whether the expiry field is editable: an ISSUED note's always; otherwise only while the amount is
 * changing (a reissue) or while the expiry differs from the note's, so a change can be put back
 * (amount -> expiry -> amount back is not a trap).
 */
export function creditNoteExpiryEditable(
  note: { status?: string; expiresAt?: string | null },
  draftExpiry: string,
  planKind: CreditNoteEditPlan["kind"],
): boolean {
  return (
    note.status === "ISSUED" ||
    planKind === "reissue" ||
    draftExpiry !== (note.expiresAt ? note.expiresAt.slice(0, 10) : "")
  );
}

/** The money path's confirm copy (SA-535(c)); `unapplied` comes from void-preview. */
export function reissueConfirmMessage(
  creditNoteNumber: string,
  newAmount: number,
  unapplied: Array<{ invoiceNumber: string; amount: number | string }>,
): string {
  const money = (n: number | string) => `$${cents(n).toFixed(2)}`;
  const off = unapplied.length
    ? ` and un-applies ${unapplied.map((u) => `${money(u.amount)} from ${u.invoiceNumber}`).join(", ")}`
    : "";
  return `This voids ${creditNoteNumber} and issues a new credit note for ${money(newAmount)}${off}. The new credit note starts unapplied.`;
}

/** The void confirm copy (SA-436 PR-2); `unapplied` comes from void-preview. Fixed wording, no server text. */
export function voidConfirmMessage(
  creditNoteNumber: string,
  unapplied: Array<{ invoiceNumber: string; amount: number | string }>,
): string {
  const money = (n: number | string) => `$${cents(n).toFixed(2)}`;
  const off = unapplied.length
    ? ` It first un-applies ${unapplied.map((u) => `${money(u.amount)} from ${u.invoiceNumber}`).join(", ")}, which reopens ${unapplied.length === 1 ? "that invoice" : "those invoices"}.`
    : "";
  return `${creditNoteNumber} will be voided and can't be undone.${off}`;
}

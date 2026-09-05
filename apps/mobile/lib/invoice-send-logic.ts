/**
 * Pure helpers for the post-delivery "send invoice" share flow (WhatsApp / SMS /
 * Email). Mirrors web's SendInvoiceModal (apps/web .../orders/[id]/page.tsx):
 * a plain-text message with NO PDF link embedded — the signed PDF URL expires in
 * ~1h (storage.service `signLocalUrl`), so a link in a message would go stale;
 * the actual file goes through the OS share sheet (`sharePdf`) instead.
 *
 * Screen-free so apps/mobile/__tests__/*.test.ts (node env) can lock the exact
 * deep-link formats and the web-parity copy.
 */
import type { ShareOutcome } from "./share-pdf";

/** The customer-facing "your invoice is ready" text — mirrors web verbatim. */
export function invoiceReadyMessage(
  customerName: string,
  invoiceNumber: string,
  totalFmt: string,
): string {
  return `Hi ${customerName}, your invoice ${invoiceNumber} for ${totalFmt} is ready. Please let us know if you have any questions.`;
}

/** WhatsApp deep link — phone stripped to bare digits (wa.me requires digits only). */
export function whatsappUrl(phone: string, message: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
}

/**
 * SMS deep link. iOS wants `&body=`, everything else `?body=` — the caller passes
 * the platform separator (Platform.OS === "ios" ? "&" : "?") so this stays pure.
 */
export function smsUrl(phone: string, message: string, separator: "?" | "&" = "?"): string {
  return `sms:${phone}${separator}body=${encodeURIComponent(message)}`;
}

/**
 * Preferred messaging number — mobile beats landline (mirrors web's
 * `customerMobile || customerPhone`). Returns undefined when neither is usable,
 * so WhatsApp/SMS affordances can hide.
 */
export function preferredPhone(mobile?: string | null, phone?: string | null): string | undefined {
  return mobile?.trim() || phone?.trim() || undefined;
}

/**
 * The WhatsApp channel's send plan (owner decision: "WhatsApp = PDF via share
 * sheet — file + message text through the OS sheet; wa.me text link remains
 * the fallback with a toast").
 *
 *  - `"share-file"` — this device/browser can hand a File to the OS/browser
 *    share sheet (`canShareFilesHere()` from `share-pdf.ts`): attach the
 *    actual invoice PDF, with `message` riding along as the share's `text`.
 *  - `"text-link"` — file sharing isn't available (most desktops, or the
 *    rare browser that lacks it): fall back to the existing wa.me deep link,
 *    text only. The caller toasts alongside this — the operator should know
 *    the PDF wasn't attached.
 */
export type WhatsAppSendPlan =
  { mode: "share-file"; text: string } | { mode: "text-link"; url: string };

export interface PlanWhatsAppSendInput {
  phone: string;
  message: string;
  /** `canShareFilesHere()`'s result — whether this device/browser can share
   *  a File through the OS/browser share sheet at all. */
  canShareFiles: boolean;
}

/** Pure — no fetch, no share() call, just the file-vs-text decision. */
export function planWhatsAppSend({
  phone,
  message,
  canShareFiles,
}: PlanWhatsAppSendInput): WhatsAppSendPlan {
  if (canShareFiles) {
    return { mode: "share-file", text: message };
  }
  return { mode: "text-link", url: whatsappUrl(phone, message) };
}

/**
 * The SMTP-fallback disclosure a successful send/reminder can carry — see
 * `SendInvoiceEmailResult` in `lib/api/invoices.ts`.
 */
export interface SmtpFallbackDisclosure {
  warning?: string;
  fromAddress?: string;
}

/**
 * The operator-facing disclosure for a send that only succeeded because Resend
 * rescued a failing tenant SMTP — verbatim web's toast copy (apps/web
 * .../invoices/[id]/page.tsx), so both surfaces say the same thing. The changed
 * From address is part of the disclosure, not a footnote.
 *
 * Returns null when the tenant's own mail worked, so callers fall back to their
 * plain success copy.
 */
export function smtpFallbackNotice({
  warning,
  fromAddress,
}: SmtpFallbackDisclosure): string | null {
  if (!warning) return null;
  return `Sent via RouteFlow's mail service${
    fromAddress ? ` (from ${fromAddress})` : ""
  } — your own email couldn't send: ${warning}.`;
}

/** UI state for a "prepare → share" control (the WhatsApp row in file-share
 *  mode, or the plain Share-PDF affordance) — see `share-pdf.ts`'s
 *  `ACTIVATION_BUDGET_MS` contract. `"preparing"` = the PDF fetch is racing
 *  the activation budget, busy + disabled. `"ready"` = the budget ran out
 *  first; nothing was shared — the NEXT tap shares the by-then-cached file
 *  synchronously. */
export type PdfSharePhase = "idle" | "preparing" | "ready";

/** Maps a `sharePdf` outcome to the next phase. Only `"ready-await-tap"`
 *  needs a second tap — every other outcome (shared, opened-tab, failed)
 *  resolves the flow, so the control goes back to idle. */
export function nextPdfSharePhase(outcome: ShareOutcome): PdfSharePhase {
  return outcome === "ready-await-tap" ? "ready" : "idle";
}

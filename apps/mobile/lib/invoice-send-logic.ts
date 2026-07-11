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

import { MessageChannel, NotificationEvent } from "@prisma/client";

/**
 * Pure, side-effect-free messaging helpers (P6-2). The engine composes these;
 * the spec targets them directly. No Prisma, no I/O.
 */

/** Channels that consume a metered MSGS unit + are STOP/consent-gated. */
export const METERED_CHANNELS = new Set<MessageChannel>([
  MessageChannel.WHATSAPP,
  MessageChannel.SMS,
]);

/** Channels that require explicit customer consent before an outbound send. */
export const CONSENT_CHANNELS = new Set<MessageChannel>([
  MessageChannel.WHATSAPP,
  MessageChannel.SMS,
]);

/** Events that must NOT go over WhatsApp/SMS (G12: invoices are email/portal only). */
export const INVOICE_EVENTS = new Set<NotificationEvent>([NotificationEvent.INVOICE_SENT]);

export function isMetered(channel: MessageChannel): boolean {
  return METERED_CHANNELS.has(channel);
}

export function requiresConsent(channel: MessageChannel): boolean {
  return CONSENT_CHANNELS.has(channel);
}

/** G12: block invoice-type events on the metered messaging channels. */
export function isInvoicePolicyViolation(
  eventKey: NotificationEvent | undefined,
  channel: MessageChannel,
): boolean {
  if (!eventKey) return false;
  return (
    INVOICE_EVENTS.has(eventKey) &&
    (channel === MessageChannel.WHATSAPP || channel === MessageChannel.SMS)
  );
}

/**
 * Substitute `{{key}}` placeholders (inner whitespace tolerated) with `vars`.
 * A missing var renders as an empty string (never leaves a raw `{{x}}` in the
 * outgoing body). Pure.
 */
export function renderTemplate(
  body: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

export interface QuietHoursSettings {
  quietHoursEnabled: boolean;
  quietHoursStart: string; // "HH:mm"
  quietHoursEnd: string; // "HH:mm"
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Whether `now` falls inside the tenant's quiet-hours window. Handles the
 * midnight-spanning case (e.g. 21:00→07:00: quiet if t ≥ start OR t < end).
 * NOTE: P6-2 computes in the `now` Date's own clock (server-local); true
 * per-tenant timezone handling + the actual defer/release queue is P6-10 — the
 * engine only *computes* the window here, it does not block or schedule.
 */
export function isQuietHours(now: Date, settings: QuietHoursSettings): boolean {
  if (!settings?.quietHoursEnabled) return false;
  const start = toMinutes(settings.quietHoursStart);
  const end = toMinutes(settings.quietHoursEnd);
  if (start == null || end == null || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start > end ? t >= start || t < end : t >= start && t < end;
}

/**
 * Distinct `{{var}}` names in a body, first-appearance order — same grammar as
 * renderTemplate. Pure. P6-6 re-derives MessageTemplate.variables on every edit
 * + at seed time; P6-5 reads the consts below for the vars each trigger passes.
 */
export function extractVariables(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

import type { MailboxStateChange } from "./mailbox-send.service";
import { BRAND } from "../../common/brand";

/**
 * F-10a — what a tenant admin is told when their connected mailbox stops sending on its own.
 * ONE source for both the in-app notification and the REVOKED email, so the two can never say
 * different things: what happened, where their email is going in the meantime, and what (if
 * anything) to do about it. Plain text only — `EmailService.sendMailboxRevokedNotice` escapes
 * every line before it reaches HTML. The only dynamic values are the mailbox address, the
 * provider and a duration: nothing here can carry a token.
 *
 * "Where their email is going" mirrors the Settings → Email card's own wording ("your SMTP setup
 * (or the platform's)") and is only claimed when a fallback sender really exists
 * (`EmailService.isEmailConfigured()` — the tenant's SMTP or a platform transport).
 */

type Provider = MailboxStateChange["provider"];

const VENDOR: Record<Provider, string> = { GOOGLE: "Google", MICROSOFT: "Microsoft" };

export interface MailboxRevokedCopy {
  subject: string;
  heading: string;
  /** The email body, one paragraph per entry, in reading order. */
  paragraphs: string[];
  /** The email's one button, to Settings → Email. */
  cta: string;
  inApp: { title: string; body: string };
}

export interface MailboxThrottledCopy {
  inApp: { title: string; body: string };
}

export function mailboxRevokedCopy(p: {
  accountEmail: string;
  provider: Provider;
  hasFallback: boolean;
}): MailboxRevokedCopy {
  const whatHappened = `${BRAND.name} can no longer send from ${p.accountEmail}: access was removed.`;
  const why =
    "This usually happens when the mailbox password is changed, or when someone removes " +
    `${BRAND.name}'s access in the ${VENDOR[p.provider]} account.`;
  const meanwhile = p.hasFallback
    ? `Your emails are still going out, just not from ${p.accountEmail}. Until you reconnect, ` +
      `they are sent from your SMTP setup, or from ${BRAND.name}'s address if you don't have one.`
    : `Until you reconnect, ${BRAND.name} can't send your emails: there is no other sender set up.`;
  const fix = `To send from ${p.accountEmail} again, go to Settings → Email and click Reconnect.`;
  return {
    subject: `${BRAND.name} can no longer send from ${p.accountEmail}`,
    heading: "Reconnect your email",
    paragraphs: [whatHappened, why, meanwhile, fix],
    cta: "Open email settings",
    inApp: {
      title: "Reconnect your email",
      body:
        `${whatHappened} ` +
        (p.hasFallback
          ? `Your emails are still going out, from your SMTP setup or ${BRAND.name}'s address. `
          : "Your emails can't be sent until you reconnect. ") +
        "To fix it, go to Settings → Email → Reconnect.",
    },
  };
}

export function mailboxThrottledCopy(p: {
  accountEmail: string;
  provider: Provider;
  throttledUntil: Date | null;
  hasFallback: boolean;
  now: Date;
}): MailboxThrottledCopy {
  const vendor = VENDOR[p.provider];
  const span = approxDuration(p.throttledUntil, p.now);
  return {
    inApp: {
      title: `${vendor} is limiting your emails`,
      body:
        `${vendor} is limiting how many emails ${BRAND.name} can send from ${p.accountEmail}. ` +
        (p.hasFallback
          ? `For ${span}, your emails go out from your SMTP setup or ${BRAND.name}'s address instead. ` +
            `${BRAND.name} switches back to ${p.accountEmail} on its own, so there's nothing to do.`
          : `Your emails can't be sent for ${span}. ${BRAND.name} tries ${p.accountEmail} again on ` +
            "its own, so there's nothing to do."),
    },
  };
}

/**
 * "about an hour" / "about 5 minutes" — relative, so it reads right in any time zone (the
 * notification has no reliable tenant-local clock to format against). A missing or past window
 * reads as "a little while" rather than a wrong number.
 */
export function approxDuration(until: Date | null, now: Date): string {
  const ms = until ? until.getTime() - now.getTime() : 0;
  if (ms <= 0) return "a little while";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

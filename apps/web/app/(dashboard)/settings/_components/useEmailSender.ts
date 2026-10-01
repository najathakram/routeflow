"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { useTenantAddons } from "@/lib/api/tobacco";
import { EMAIL_CONNECTED_MAILBOX_ADDON } from "./MailboxCard";

export type EmailSender = {
  kind: "mailbox" | "smtp" | "default";
  label: string;
  /** The connected-mailbox add-on is on for this tenant (so "Use your own mailbox" makes sense). */
  mailboxAvailable: boolean;
};

interface MailboxLite {
  connected?: boolean;
  status?: string;
  accountEmail?: string;
  throttledUntil?: string | null;
}
interface SmtpLite {
  /** Host + user + password all entered (settings.controller.ts) — the only SMTP that sends. */
  smtpConfigured?: boolean;
  fromEmail?: string | null;
}

/**
 * Which address do notification emails go out from? A usable connected mailbox beats the tenant's
 * fully-entered SMTP, which beats RouteFlow's own address. FAILS CLOSED: returns `null` (the page
 * makes no claim) while the SMTP settings are unknown, or while the mailbox status is still unknown
 * for a tenant that has the mailbox add-on, since a connected mailbox may be the real sender.
 *
 * A REVOKED mailbox is not a sender; a THROTTLED one is only while its window is still open (mail
 * falls back to SMTP until `throttledUntil`).
 */
export function resolveEmailSender(input: {
  mailbox?: MailboxLite | null;
  smtp?: SmtpLite | null;
  mailboxAvailable: boolean;
  /** False while the add-on is on but the mailbox query has not succeeded yet. Default true. */
  mailboxKnown?: boolean;
  now?: Date;
}): EmailSender | null {
  const { mailbox, smtp, mailboxAvailable, mailboxKnown = true, now = new Date() } = input;
  if (mailboxAvailable && !mailboxKnown) return null;
  if (!smtp) return null;

  const throttledNow =
    mailbox?.status === "THROTTLED" &&
    !!mailbox.throttledUntil &&
    new Date(mailbox.throttledUntil).getTime() > now.getTime();
  if (mailbox?.connected && mailbox.accountEmail && mailbox.status !== "REVOKED" && !throttledNow) {
    return {
      kind: "mailbox",
      label: `your connected mailbox (${mailbox.accountEmail})`,
      mailboxAvailable,
    };
  }
  if (smtp.smtpConfigured) {
    // The From address, never smtpUser (B468: smtpUser is not guaranteed to be an address).
    return {
      kind: "smtp",
      label: smtp.fromEmail ? `your SMTP account (${smtp.fromEmail})` : "your SMTP account",
      mailboxAvailable,
    };
  }
  return { kind: "default", label: "RouteFlow's address", mailboxAvailable };
}

/** Shares the React Query cache keys of the SMTP settings tab and the mailbox card. Admin only. */
export function useEmailSender(enabled: boolean): { sender: EmailSender | null } {
  const addons = useTenantAddons();
  const addonsSettled = addons.isSuccess || addons.isError;
  const mailboxAvailable = addons.data?.addons?.includes(EMAIL_CONNECTED_MAILBOX_ADDON) === true;

  const smtp = useQuery<SmtpLite>({
    queryKey: ["settings", "email"],
    queryFn: () => apiClient.get("/settings/email").then((r) => r.data),
    enabled,
    retry: false,
  });
  const mailbox = useQuery<MailboxLite>({
    queryKey: ["settings", "email-mailbox"],
    queryFn: () => apiClient.get("/settings/email/mailbox").then((r) => r.data),
    enabled: enabled && mailboxAvailable,
    retry: false,
  });

  // Nothing is claimed for a disabled caller (operators), before the add-on answer is in, or when
  // the add-on endpoint itself errored (we cannot tell whether a mailbox exists).
  if (!enabled || !addonsSettled || addons.isError) return { sender: null };
  return {
    sender: resolveEmailSender({
      mailbox: mailbox.data,
      smtp: smtp.data,
      mailboxAvailable,
      mailboxKnown: !mailboxAvailable || mailbox.isSuccess,
    }),
  };
}

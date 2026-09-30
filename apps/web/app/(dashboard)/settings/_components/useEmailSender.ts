"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { useHasAddon } from "@/lib/api/tobacco";
import { EMAIL_CONNECTED_MAILBOX_ADDON } from "./MailboxCard";

export type EmailSender = { kind: "mailbox" | "smtp" | "default"; label: string };

interface MailboxLite {
  connected?: boolean;
  status?: string;
  accountEmail?: string;
}
interface SmtpLite {
  smtpHost?: string | null;
  smtpUser?: string | null;
}

/**
 * Which address do notification emails go out from? A connected mailbox (not revoked or throttled)
 * beats the tenant's saved SMTP account, which beats RouteFlow's own address. `null` = the SMTP
 * settings are not known yet, so the page makes no claim rather than a wrong one.
 */
export function resolveEmailSender(input: {
  mailbox?: MailboxLite | null;
  smtp?: SmtpLite | null;
}): EmailSender | null {
  const { mailbox, smtp } = input;
  if (
    mailbox?.connected &&
    mailbox.accountEmail &&
    mailbox.status !== "REVOKED" &&
    mailbox.status !== "THROTTLED"
  ) {
    return { kind: "mailbox", label: `your connected mailbox (${mailbox.accountEmail})` };
  }
  if (!smtp) return null;
  if (smtp.smtpHost && smtp.smtpUser) {
    return { kind: "smtp", label: `your SMTP account (${smtp.smtpUser})` };
  }
  return { kind: "default", label: "RouteFlow's address" };
}

/** Shares the React Query cache keys of the SMTP settings tab and the mailbox card. Admin only. */
export function useEmailSender(enabled: boolean): { sender: EmailSender | null } {
  const hasMailboxAddon = useHasAddon(EMAIL_CONNECTED_MAILBOX_ADDON);
  const smtp = useQuery<SmtpLite>({
    queryKey: ["settings", "email"],
    queryFn: () => apiClient.get("/settings/email").then((r) => r.data),
    enabled,
    retry: false,
  });
  const mailbox = useQuery<MailboxLite>({
    queryKey: ["settings", "email-mailbox"],
    queryFn: () => apiClient.get("/settings/email/mailbox").then((r) => r.data),
    enabled: enabled && hasMailboxAddon,
    retry: false,
  });
  return { sender: resolveEmailSender({ mailbox: mailbox.data, smtp: smtp.data }) };
}

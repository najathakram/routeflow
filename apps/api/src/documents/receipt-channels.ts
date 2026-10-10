import type { EmailDeliveryContext } from "../email/email-delivery.service";
import type { EmailService } from "../email/email.service";

/**
 * Mirrors `RECEIPT_CHANNEL_VALUES` in @routeflow/types (API source never value-imports that package); a parity spec pins them
 * set-equal. SMS / WhatsApp are a later row here plus a template, not a rework (SA-751r change 3).
 */
export const RECEIPT_CHANNEL_VALUES = ["email"] as const;
export type ReceiptChannel = (typeof RECEIPT_CHANNEL_VALUES)[number];

/** What a channel needs to deliver one rendered receipt. */
export interface ReceiptDelivery {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** the audit row (and the limit counter's source): one per send, kind RECEIPT, entity the Order */
  delivery: EmailDeliveryContext;
}

/** A channel sender resolves when the receipt LEFT and throws when it did not (the caller maps the throw to a coded error). */
export type ReceiptChannelSender = (
  deps: { email: Pick<EmailService, "send"> },
  args: ReceiptDelivery,
) => Promise<void>;

/** The receipt left only when the email transport says `delivered`; an honest result (R5), never "queued". */
export const sendEmailReceipt: ReceiptChannelSender = async ({ email }, args) => {
  const result = await email.send(args);
  if (!result.delivered) throw new Error("The receipt email was not delivered");
};

/**
 * The channel registry (SA-751r change 3). `NOTIFICATION_TRIGGERS` exists on master but is a set of Prisma `NotificationEvent`
 * keys (automatic, tenant-switchable events with an audience); a receipt is an on-demand cashier action with no switch, so it
 * is registered here instead. Typed so a value added to `RECEIPT_CHANNEL_VALUES` without a sender fails the build.
 */
export const RECEIPT_CHANNELS: Record<ReceiptChannel, ReceiptChannelSender> = {
  email: sendEmailReceipt,
};

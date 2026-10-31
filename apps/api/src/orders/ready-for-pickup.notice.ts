import type { ReadyForPickupDone } from "@routeflow/types";
import type { SendOutcome } from "../messaging/messaging.service";
import { isInternalEmail } from "../common/internal-email";

/**
 * Fold the messaging engine's outcomes into the ONE notice staff read (W-1043, SA-1062 MUST 18). Only the EMAIL
 * channel counts: the sentences say "email". Checked in the order that tells staff the most useful true thing:
 * no EMAIL attempt at all = the business turned the event off (OFF); no usable address = NO_EMAIL (before the
 * opt-out, since a walk-in is created with order emails off and reads as "no email"); then the buyer's opt-out;
 * then a send that did not go (a failure, a missing transport, anything else skipped) = FAILED.
 */
export function readyNoticeOf(
  outcomes: SendOutcome[],
  customer: { email: string | null; orderStatusEmails: boolean },
): ReadyForPickupDone {
  const email = outcomes.find((o) => o.channel === "EMAIL");
  if (!email) return { notice: "OFF" };
  const address = customer.email && !isInternalEmail(customer.email) ? customer.email : null;
  if (email.outcome === "sent")
    return address ? { notice: "SENT", email: address } : { notice: "FAILED" };
  if (!address || email.reason === "NO_CONTACT") return { notice: "NO_EMAIL" };
  if (email.reason === "OPTED_OUT" || !customer.orderStatusEmails) return { notice: "OPTED_OUT" };
  return { notice: "FAILED" };
}

/**
 * What a Ready press would do for this customer right now (SA-1070 rule 5), in the order of `readyNoticeOf`: the
 * business has no EMAIL rule enabled (OFF), no usable address (NO_EMAIL), the buyer turned order emails off
 * (OPTED_OUT), otherwise the email goes (SENT, to the address). `channels` is `enabledChannels(READY_FOR_PICKUP)`.
 */
export function readyPreviewOf(
  channels: readonly string[],
  customer: { email: string | null; orderStatusEmails: boolean },
): ReadyForPickupDone {
  if (!channels.includes("EMAIL")) return { notice: "OFF" };
  const address = customer.email && !isInternalEmail(customer.email) ? customer.email : null;
  if (!address) return { notice: "NO_EMAIL" };
  if (!customer.orderStatusEmails) return { notice: "OPTED_OUT" };
  return { notice: "SENT", email: address };
}

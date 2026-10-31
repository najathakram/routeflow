import type { ReadyForPickupDone } from "@routeflow/types";

/**
 * What staff read after "Ready for pickup" (W-1043, SA-1062 MUST 19): the button never promises an email, so this
 * says exactly what happened. Only SENT is a success; the rest are warnings that stay until dismissed. The switch
 * is exhaustive: a sixth notice fails the build here, not on a till.
 */
export function readyForPickupCopy(
  done: ReadyForPickupDone,
  customerName: string | null | undefined,
): { text: string; success: boolean } {
  const who = customerName?.trim() || "The customer";
  const ready = "Ready for pickup.";
  switch (done.notice) {
    case "SENT":
      return {
        text: done.email ? `${ready} Email sent to ${done.email}.` : `${ready} Email sent.`,
        success: true,
      };
    case "NO_EMAIL":
      return {
        text: `${ready} ${who} has no email on file, so nobody was told.`,
        success: false,
      };
    case "OPTED_OUT":
      return {
        text: `${ready} ${who} turned off order emails, so nobody was told.`,
        success: false,
      };
    case "OFF":
      return { text: `${ready} Your order emails are off, so nobody was told.`, success: false };
    case "FAILED":
      return {
        text: `${ready} The email didn't send, so please tell ${who} another way.`,
        success: false,
      };
    default: {
      const unreachable: never = done.notice;
      return unreachable;
    }
  }
}

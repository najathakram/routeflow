import type {
  ReadyForPickupDone,
  ReadyForPickupNotice,
  ReadyForPickupRecord,
  ReadyForPickupToldOnce,
} from "@routeflow/types";

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

/** "Oct 31" and "2:14 PM" in the business's zone (a zone Intl does not know falls back to UTC, never throws). */
export function readyWhen(iso: string, timeZone?: string): { day: string; time: string } {
  const d = new Date(iso);
  const part = (opts: Intl.DateTimeFormatOptions, zone: string | undefined) =>
    new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone }).format(d);
  const both = (zone: string | undefined) => ({
    day: part({ month: "short", day: "numeric" }, zone),
    time: part({ hour: "numeric", minute: "2-digit" }, zone),
  });
  try {
    return both(timeZone);
  } catch {
    return both("UTC");
  }
}

/** The toast after a press that found the customer already emailed (SA-1070 rule 8): a success, because nothing is wrong. */
export function toldOnceCopy(
  done: ReadyForPickupToldOnce,
  customerName: string | null | undefined,
): string {
  const who = done.email ?? (customerName?.trim() || "The customer");
  return `Ready for pickup. ${who} was already emailed, so no new email went.`;
}

/** What the one line under the order's actions can say, and the one action it may carry (SA-1070 rule 6). */
export interface ReadyLine {
  text: string;
  action: "SEND_AGAIN" | "SEND_EMAIL" | null;
}

const PREVIEW_TEXT: Record<Exclude<ReadyForPickupNotice, "SENT" | "FAILED">, string> = {
  NO_EMAIL: "No email on file, so marking ready tells nobody.",
  OPTED_OUT: "This customer turned off order emails.",
  OFF: "Your order emails are off.",
};

/**
 * The line's words per state. `ready` = the order is already Ready for pickup (the only time Send again / Send email can
 * act). A SENT or FAILED last send speaks for itself; otherwise the line says what marking ready would do, and is
 * silent once the order is Ready (nothing left to promise). The switches are exhaustive: a sixth notice fails the build.
 */
export function readyLineCopy(
  record: ReadyForPickupRecord,
  ready: boolean,
  timeZone?: string,
): ReadyLine | null {
  const last = record.last;
  if (last && (last.notice === "SENT" || last.notice === "FAILED")) {
    const when = readyWhen(last.at, timeZone);
    const stamp = `${when.day}, ${when.time}`;
    if (last.notice === "SENT") {
      return {
        text: last.email
          ? `Ready email sent to ${last.email}, ${stamp}.`
          : `Ready email sent, ${stamp}.`,
        action: ready ? "SEND_AGAIN" : null,
      };
    }
    return {
      text: `The ready email didn't send, ${stamp}.`,
      action: ready ? "SEND_EMAIL" : null,
    };
  }
  if (ready) return null;
  const p = record.preview;
  switch (p.notice) {
    case "SENT":
      return {
        text: p.email ? `Marking ready emails ${p.email}.` : "Marking ready emails the customer.",
        action: null,
      };
    case "FAILED":
      return null; // a preview is never FAILED; the case keeps the switch exhaustive
    case "NO_EMAIL":
    case "OPTED_OUT":
    case "OFF":
      return { text: PREVIEW_TEXT[p.notice], action: null };
    default: {
      const unreachable: never = p.notice;
      return unreachable;
    }
  }
}

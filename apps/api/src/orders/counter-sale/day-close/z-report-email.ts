import {
  dayCloseDateLabel,
  dayCloseHandOvers,
  dayCloseVerdictText,
  dayCloseZSections,
  type ZRow,
} from "@routeflow/pricing";
import type { DayCloseSnapshot } from "@routeflow/types";
import { escapeHtml } from "../../../common/html-escape";

/**
 * The Z report email: the closed window's summary for the tenant's admins. It is built from the stored SNAPSHOT only (totals,
 * never rows), so it carries no customer name and no line. Every interpolated value is escaped. The sections, their order and
 * their rows come from the shared `dayCloseZSections` (@routeflow/pricing), the same builder the web screen renders, so the
 * email and the screen cannot drift (SA-750r3 flow plan, section 4).
 */

export interface ZReportEmail {
  subject: string;
  html: string;
  text: string;
}

/** `$12.30`, `-$1.50`: whole cents, sign in front. */
export function zMoney(n: number): string {
  const cents = Math.round(Math.abs(n) * 100);
  const text = `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
  return n < 0 && cents > 0 ? `-${text}` : text;
}

const MINUS = "−";
const DOT = "·";
const DASH = "–";

interface Clock {
  /** "2026-10-09", the tenant-zone calendar day */
  ymd: string;
  /** "Thu" */
  weekday: string;
  /** "9:42 PM" */
  time: string;
}

/** The tenant-zone pieces of an instant; `utc` is true when the zone was unusable and UTC stood in. */
function clock(iso: string, zone: string): Clock & { utc: boolean } {
  const at = new Date(iso);
  const read = (timeZone: string): Clock => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const monthNum = new Intl.DateTimeFormat("en-US", { timeZone, month: "2-digit" }).format(at);
    const dayNum = get("day").padStart(2, "0");
    return {
      ymd: `${get("year")}-${monthNum}-${dayNum}`,
      weekday: get("weekday"),
      time: `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase()}`,
    };
  };
  try {
    return { ...read(zone), utc: false };
  } catch {
    return { ...read("UTC"), utc: true };
  }
}

/** A signed over/short figure: "+$1.00", "−$2.50", "$0.00" for none. */
function signedMoney(n: number): string {
  const text = zMoney(Math.abs(n));
  if (text === "$0.00") return text;
  return n < 0 ? `${MINUS}${text}` : `+${text}`;
}

function valueOf(row: ZRow): string {
  if (row.amount === null) return "Not recorded";
  const money = row.signed ? signedMoney(row.amount) : zMoney(row.amount);
  return row.count === undefined ? money : `${money} ${DOT} ${dayCloseHandOvers(row.count)}`;
}

export function buildZReportEmail(input: {
  businessName: string;
  snapshot: DayCloseSnapshot;
}): ZReportEmail {
  const { snapshot: s } = input;
  const z = dayCloseZSections(s);
  // The report's own calendar day, worded as the Z screen's title is ("Sun, Oct 11"): subject, title line and screen agree.
  const dayLabel = dayCloseDateLabel(s.day);
  const subject = `Z report for ${dayLabel} ${DOT} ${input.businessName}`;

  const closed = clock(s.closedAt, s.zone);
  const start = clock(s.windowStart, s.zone);
  const end = clock(s.windowEnd, s.zone);
  const suffix = closed.utc ? " UTC" : "";
  const titleLine = `Z report ${DOT} ${dayLabel}`;
  const closedLine = `Closed ${closed.time}${s.closedByName ? ` by ${s.closedByName}` : ""}${suffix}`;
  const crossesDay = start.ymd !== end.ymd;
  const windowLine = crossesDay
    ? `${start.weekday} ${start.time} ${DASH} ${end.weekday} ${end.time}${suffix}`
    : `${start.time} ${DASH} ${end.time}${suffix}`;
  // the screen's own order: the variance verdict is the headline, "Counted" sits beneath it (owner ruling 10-12 wording)
  const headline = dayCloseVerdictText(z.headline.verdict, zMoney(z.headline.amount));
  const counted = `Counted ${zMoney(z.headline.counted)}`;
  const tenderWarning = "Some refunds have no method. Expected cash may be high.";

  const tr = (row: ZRow) => {
    const cell = (v: string) => (row.bold ? `<strong>${escapeHtml(v)}</strong>` : escapeHtml(v));
    return `<tr><td style="padding:2px 12px 2px 0">${cell(row.label)}</td><td style="padding:2px 0;text-align:right">${cell(valueOf(row))}</td></tr>`;
  };

  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px">` +
    `<h2 style="margin:0 0 4px">${escapeHtml(titleLine)}</h2>` +
    `<p style="margin:4px 0">${escapeHtml(closedLine)}</p>` +
    `<p style="margin:4px 0">${escapeHtml(windowLine)}</p>` +
    `<p style="margin:12px 0 0;font-size:20px"><strong>${escapeHtml(headline)}</strong></p>` +
    `<p style="margin:2px 0 0">${escapeHtml(counted)}</p>` +
    z.groups
      .map(
        (g) =>
          `<h3 style="margin:16px 0 4px">${escapeHtml(g.heading)}</h3><table>${g.rows.map((r) => tr(r)).join("")}</table>`,
      )
      .join("") +
    (z.refundsTenderKnown
      ? ""
      : `<p style="color:#b45309"><strong>${escapeHtml(tenderWarning)}</strong></p>`) +
    (s.notes
      ? `<p style="margin:16px 0 0"><strong>Note</strong>: ${escapeHtml(s.notes)}</p>`
      : "") +
    `</div>`;

  const text = [
    titleLine,
    closedLine,
    windowLine,
    "",
    headline,
    counted,
    ...z.groups.flatMap((g) => [
      "",
      g.heading,
      ...g.rows.map((r) => `  ${r.label}: ${valueOf(r)}`),
    ]),
    ...(z.refundsTenderKnown ? [] : ["", tenderWarning]),
    ...(s.notes ? ["", `Note: ${s.notes}`] : []),
  ].join("\n");

  return { subject, html, text };
}

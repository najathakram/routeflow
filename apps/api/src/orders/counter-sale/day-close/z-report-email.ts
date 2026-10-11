import type { DayCloseSnapshot } from "@routeflow/types";
import { escapeHtml } from "../../../common/html-escape";

/**
 * The Z report email: the closed window's summary for the tenant's admins. It is built from the stored SNAPSHOT only (totals,
 * never rows), so it carries no customer name and no line. Every interpolated value is escaped.
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

/** A wall-clock time in the tenant's zone ("Oct 8, 2026, 6:05 PM"), UTC when the zone is unusable. */
export function zTime(iso: string, zone: string): string {
  const at = new Date(iso);
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(
      at,
    );
  try {
    return fmt(zone);
  } catch {
    return `${fmt("UTC")} UTC`;
  }
}

type Row = readonly [label: string, value: string];
interface Section {
  title: string;
  rows: Row[];
  warning?: string;
}

function sectionsOf(s: DayCloseSnapshot): Section[] {
  const t = s.totals;
  const variance = s.variance;
  const varianceText =
    variance === 0
      ? "Even"
      : variance > 0
        ? `Over ${zMoney(variance)}`
        : `Short ${zMoney(Math.abs(variance))}`;
  const unknown = t.refunds.unknownTenderCount;
  return [
    {
      title: "Sales",
      rows: [
        ["Sales", String(t.salesCount)],
        ["Sales total", zMoney(t.salesTotal)],
        ["On account (not paid)", zMoney(t.onAccount)],
      ],
    },
    {
      title: "Money in",
      rows: [
        ["Cash", zMoney(t.moneyIn.cash)],
        ["Card", zMoney(t.moneyIn.card)],
        ["Check", zMoney(t.moneyIn.check)],
        ["Other", zMoney(t.moneyIn.other)],
        ["Total in", zMoney(t.moneyIn.total)],
        // already inside the figures above; a close made before the field existed has no value, which is not zero
        [
          "Pickup hand-overs",
          t.handOver
            ? `${t.handOver.count} · ${zMoney(t.handOver.cash)} (in till cash)`
            : "Not recorded",
        ],
      ],
    },
    {
      title: "Refunds",
      rows: [
        ["Refunds", String(t.refunds.count)],
        ["Cash", zMoney(t.refunds.cash)],
        ["Card", zMoney(t.refunds.card)],
        ["Check", zMoney(t.refunds.check)],
        ["Tender not recorded", zMoney(t.refunds.other)],
        ["Total refunded", zMoney(t.refunds.total)],
      ],
      ...(t.refunds.tenderKnown
        ? {}
        : {
            warning: `Warning: ${unknown} refund${unknown === 1 ? " has" : "s have"} no recorded tender. ${
              unknown === 1 ? "It was" : "They were"
            } not taken out of the expected cash.`,
          }),
    },
    {
      title: "Store credit",
      rows: [
        ["Used", zMoney(t.storeCreditUsed)],
        ["Issued", `${zMoney(t.storeCreditIssued.amount)} (${t.storeCreditIssued.count})`],
      ],
    },
    { title: "Net collected", rows: [["Money in minus refunds", zMoney(t.netCollected)]] },
    {
      title: "Cash drawer",
      rows: [
        ["Opening float", zMoney(s.openingFloat)],
        ["Expected cash", zMoney(s.expectedCash)],
        ["Counted cash", zMoney(s.countedCash)],
        ["Variance", varianceText],
      ],
    },
    {
      title: "Not taken at the till",
      rows: [["Office or driver payments on counter invoices", zMoney(t.notAtTill)]],
    },
  ];
}

export function buildZReportEmail(input: {
  businessName: string;
  snapshot: DayCloseSnapshot;
}): ZReportEmail {
  const { snapshot: s } = input;
  const closedBy = s.closedByName ?? "an unknown user";
  const closedAt = zTime(s.closedAt, s.zone);
  const from = zTime(s.windowStart, s.zone);
  const to = zTime(s.windowEnd, s.zone);
  const subject = `Z report for ${s.day} - ${input.businessName}`;
  const sections = sectionsOf(s);

  const tr = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0">${escapeHtml(label)}</td><td style="padding:2px 0;text-align:right">${escapeHtml(value)}</td></tr>`;
  const block = (sec: Section) =>
    `<h3 style="margin:16px 0 4px">${escapeHtml(sec.title)}</h3><table>${sec.rows
      .map(([l, v]) => tr(l, v))
      .join("")}</table>${
      sec.warning ? `<p style="color:#b45309"><strong>${escapeHtml(sec.warning)}</strong></p>` : ""
    }`;

  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px">` +
    `<h2 style="margin:0 0 4px">Z report for ${escapeHtml(s.day)}</h2>` +
    `<p style="margin:0">${escapeHtml(input.businessName)}</p>` +
    `<p style="margin:4px 0">Closed ${escapeHtml(closedAt)} by ${escapeHtml(closedBy)}</p>` +
    `<p style="margin:4px 0">Window ${escapeHtml(from)} to ${escapeHtml(to)} (${escapeHtml(s.zone)})</p>` +
    sections.map((sec) => block(sec)).join("") +
    (s.notes ? `<h3 style="margin:16px 0 4px">Notes</h3><p>${escapeHtml(s.notes)}</p>` : "") +
    `</div>`;

  const text = [
    `Z report for ${s.day}`,
    input.businessName,
    `Closed ${closedAt} by ${closedBy}`,
    `Window ${from} to ${to} (${s.zone})`,
    ...sections.flatMap((sec) => [
      "",
      sec.title,
      ...sec.rows.map(([l, v]) => `  ${l}: ${v}`),
      ...(sec.warning ? [`  ${sec.warning}`] : []),
    ]),
    ...(s.notes ? ["", "Notes", `  ${s.notes}`] : []),
  ].join("\n");

  return { subject, html, text };
}

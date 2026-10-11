import { taxRowLabel } from "@routeflow/pricing";
import type { ReceiptModel } from "@routeflow/types";
import { escapeHtml } from "../common/html-escape";
import { renderBrandedEmail, tenantHeaderHtml } from "../email/email.service";
import {
  buildReceiptModel,
  formatReceiptMoney as money,
  type ReceiptBranding,
  type ReceiptInvoiceInput,
  type ReceiptOrderInput,
  type ReceiptPaymentInput,
} from "./receipt-model";

/**
 * SA-751r: the email half of the order receipt. PURE: stored rows in (order, invoices, payments, branding, zone), a subject +
 * html + plain text out. It builds the shared `ReceiptModel` (`receipt-model.ts`) and prints exactly the rows the 80 mm print
 * view prints for the same model, through the same branded shell every other tenant email uses. Every dynamic string (the
 * business name and address, product names, the tenant's footer) goes through `escapeHtml`; the plain-text alternative is built
 * from the same model, never by stripping tags, so a figure can never be in one and not the other.
 */

export interface RenderedReceipt {
  model: ReceiptModel;
  subject: string;
  html: string;
  text: string;
}

const CELL = "padding:6px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1D2A3D;";
const SUB = "font-size:12px;color:#536579;";
const RIGHT = "text-align:right;white-space:nowrap;padding-left:12px;";

/** One label/value row of the totals block. */
function totalRow(label: string, value: string, strong = false): string {
  const weight = strong ? "font-weight:700;font-size:16px;" : "";
  return `<tr>
    <td style="${CELL}${weight}">${escapeHtml(label)}</td>
    <td style="${CELL}${weight}${RIGHT}">${escapeHtml(value)}</td>
  </tr>`;
}

/** The totals, as (label, value, strong) triples: the ONE list both the html and the text print, in the print view's order. */
function totalsOf(m: ReceiptModel): Array<[string, string, boolean]> {
  const rows: Array<[string, string, boolean]> = [["Subtotal", money(m.subtotal), false]];
  if (m.discounts > 0) rows.push(["Discounts", `-${money(m.discounts)}`, false]);
  if (m.tax !== 0) rows.push([taxRowLabel(m.taxRatePercent), money(m.tax), false]);
  if (m.adjustments !== 0) rows.push(["Adjustments", money(m.adjustments), false]);
  rows.push(["Total", money(m.total), true]);
  if (m.methodLabel) rows.push(["Payment method", m.methodLabel, false]);
  if (m.showPaid) rows.push(["Paid", money(m.paid), false]);
  if (m.showBalance) rows.push(["Balance due", money(m.balanceDue), false]);
  if (m.tendered != null) rows.push(["Tendered", money(m.tendered), false]);
  if (m.change != null) rows.push(["Change", money(m.change), true]);
  return rows;
}

/** The line's name cell: name, detail, and the cashier's note under it (as the print view). Every value is escaped. */
function lineNameHtml(l: ReceiptModel["lines"][number]): string {
  const span = (text: string) => '<br><span style="' + SUB + '">' + escapeHtml(text) + "</span>";
  return escapeHtml(l.name) + span(l.detail) + (l.note ? span(l.note) : "");
}

/** The line's amount cell: the net total, with the struck list price above it and "Discount" below it for a lowered price. */
function lineAmountHtml(l: ReceiptModel["lines"][number]): string {
  if (l.original == null) return escapeHtml(money(l.total));
  return (
    '<s style="' +
    SUB +
    '">' +
    escapeHtml(money(l.original)) +
    "</s><br>" +
    escapeHtml(money(l.total)) +
    '<br><span style="' +
    SUB +
    '">Discount -' +
    escapeHtml(money(l.discount)) +
    "</span>"
  );
}

function bodyHtmlOf(m: ReceiptModel): string {
  const lineRows = m.lines
    .map(
      (l) => `<tr>
    <td style="${CELL}border-bottom:1px solid #f0f0f0;">${lineNameHtml(l)}</td>
    <td style="${CELL}border-bottom:1px solid #f0f0f0;${RIGHT}">${lineAmountHtml(l)}</td>
  </tr>`,
    )
    .join("");
  const address = [...m.header.addressLines, ...(m.header.phone ? [m.header.phone] : [])]
    .map((a) => escapeHtml(a))
    .join("<br>");
  const account = m.onAccount
    ? `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#1D2A3D;">On account: ${escapeHtml(money(m.balanceDue))} balance due on account</p>`
    : "";
  // the customer line is a named customer's only (null for a walk-in), as in the print header
  // owner ruling: the cashier is staff-facing (the on-screen view); the customer's copy never prints it
  const customer = m.customerName ? `<br>Customer: ${escapeHtml(m.customerName)}` : "";
  const footer = m.footer
    ? `<p style="margin:24px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#536579;white-space:pre-line;">${escapeHtml(m.footer)}</p>`
    : "";
  return `${address ? `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#536579;">${address}</p>` : ""}
          <p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#536579;">Order ${escapeHtml(m.orderNumber)} · Invoice ${escapeHtml(m.invoiceNumber)}<br>${escapeHtml(m.dateLabel)}${customer}</p>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">${lineRows}</table>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:12px;">
            ${totalsOf(m)
              .map(([label, value, strong]) => totalRow(label, value, strong))
              .join("")}
          </table>
          ${account}
          ${footer}`;
}

function bodyTextOf(m: ReceiptModel): string[] {
  const head = [
    ...(m.header.name ? [m.header.name] : []),
    ...m.header.addressLines,
    ...(m.header.phone ? [m.header.phone] : []),
  ];
  const parts = [
    ...(head.length ? [head.join("\n")] : []),
    `Order ${m.orderNumber} · Invoice ${m.invoiceNumber}\n${m.dateLabel}${m.customerName ? `\nCustomer: ${m.customerName}` : ""}`,
    m.lines
      .map((l) => {
        const amount =
          l.original != null
            ? `was ${money(l.original)}  ${money(l.total)} (Discount -${money(l.discount)})`
            : money(l.total);
        return `${l.name}\n  ${l.detail}  ${amount}${l.note ? `\n  ${l.note}` : ""}`;
      })
      .join("\n"),
    totalsOf(m)
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n"),
  ];
  if (m.onAccount) parts.push(`On account: ${money(m.balanceDue)} balance due on account`);
  if (m.footer) parts.push(m.footer);
  return parts;
}

/** A subject is one header line: CR / LF in a tenant-typed name must never reach it. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

export function renderOrderReceipt(
  order: ReceiptOrderInput,
  invoices: readonly ReceiptInvoiceInput[],
  payments: readonly ReceiptPaymentInput[],
  tenantBranding: ReceiptBranding,
  zone: string | null,
): RenderedReceipt {
  const model = buildReceiptModel(order, invoices, payments, tenantBranding, zone);
  const name = oneLine(model.header.name ?? "");
  const subject = name
    ? `Your receipt from ${name} (Order ${model.orderNumber})`
    : `Your receipt for order ${model.orderNumber}`;
  const { html, text } = renderBrandedEmail({
    headerHtml: tenantHeaderHtml(name || "Receipt"),
    heading: "Receipt",
    bodyHtml: bodyHtmlOf(model),
    bodyText: bodyTextOf(model),
    // The business name is already in this context; with none there is no name to print, so the old line stays.
    footerNote: name ? `Sent by ${name}.` : "Receipt sent from RouteFlow.",
  });
  return { model, subject, html, text };
}

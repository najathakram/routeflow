import { fromCents } from "@routeflow/pricing";
import { escapeHtml, safeLinkHref } from "../common/html-escape";
export { escapeHtml };
// N3 (2026-09-16): billing-lifecycle email templates to the tenant admin — trial ending,
// downgrade scheduled/applied, upgrade confirmed, cancelled, suspended.
//
// Base layout markup/style is copied verbatim from EmailService.buildInvoiceEmail's outer
// wrapper (email.service.ts ~1037-1116) per the notification spec's ground rule "one base
// HTML layout — no new look, reuse buildInvoiceEmail's markup/style". Every interpolated
// value goes through escapeHtml() — this repo has no prior escaping convention for email
// templates (buildInvoiceEmail and the merge-email builders interpolate unescaped), so this
// file is the first to add it; it applies only to the templates below, not to existing ones.
//
// Fix round (Opus review of 1dba2bca, finding 4): these are PLATFORM emails (sent via
// EmailService.sendPlatform, never the tenant's own SMTP/branding) — the layout BRAND is
// always "RouteFlow", never the tenant's business name. The tenant's business name still
// appears in the body copy, where it belongs.

const PLATFORM_BRAND = "RouteFlow";

const fmtMoney = (n: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

function baseLayout(params: { tagline: string; bodyHtml: string }): string {
  const brand = escapeHtml(PLATFORM_BRAND);
  const tagline = escapeHtml(params.tagline);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr><td style="background:#1a2033;padding:28px 32px;">
          <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${brand}</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.6);">${tagline}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">
          ${params.bodyHtml}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This is an automated email from ${brand}.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButtonHtml(url: string, label: string): string {
  // B809: a non-http(s) URL renders the button WITHOUT an href (logged and counted).
  const href = safeLinkHref(url, "ctaButtonHtml");
  const style =
    "display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;";
  const button = href
    ? `<a href="${escapeHtml(href)}" style="${style}">${escapeHtml(label)}</a>`
    : `<span style="${style}">${escapeHtml(label)}</span>`;
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:6px;background:#1a2033;">
    ${button}
  </td></tr></table>`;
}

// Fix round (finding 5): WEB_URL is the repo-wide convention for a user-facing link
// (payment-requests.service.ts, stripe-connect.controller.ts) — FRONTEND_URL is not in
// .env.example and is only used by a few older billing.service.ts call sites. Falls back to
// the real production domain, not localhost, so a misconfigured env never ships a dead link.
function webBaseUrl(): string {
  return (process.env.WEB_URL ?? process.env.FRONTEND_URL ?? "https://www.routeflow.info").replace(
    /\/$/,
    "",
  );
}

export function billingSettingsUrl(): string {
  return `${webBaseUrl()}/settings/billing`;
}

export interface BillingEmailTemplate {
  subject: string;
  html: string;
  text: string;
  /** Set only by rfInvoiceEmail (PLATFORM_BILLING_REPLY_TO); absent everywhere else. */
  replyTo?: string;
}

export type TrialEndingMilestone = "TRIAL_ENDING_7D" | "TRIAL_ENDING_1D" | "TRIAL_ENDING_EXPIRY";

export function trialEndingTemplate(params: {
  businessName: string;
  adminName: string;
  milestone: TrialEndingMilestone;
  trialEndsAt: string; // pre-formatted date string
}): BillingEmailTemplate {
  const upgradeUrl = billingSettingsUrl();
  const headline =
    params.milestone === "TRIAL_ENDING_7D"
      ? "Your trial ends in 7 days"
      : params.milestone === "TRIAL_ENDING_1D"
        ? "Your trial ends tomorrow"
        : "Your trial has ended";
  const bodyLine =
    params.milestone === "TRIAL_ENDING_EXPIRY"
      ? `Your RouteFlow trial for <strong>${escapeHtml(params.businessName)}</strong> ended on ${escapeHtml(params.trialEndsAt)}. Your account is now read-only until you choose a plan.`
      : `Your RouteFlow trial for <strong>${escapeHtml(params.businessName)}</strong> ends on ${escapeHtml(params.trialEndsAt)}. Choose a plan to keep everything running without interruption.`;
  const html = baseLayout({
    tagline: "Trial",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">${bodyLine}</p>
      ${ctaButtonHtml(upgradeUrl, "Choose a plan")}
    `,
  });
  const text = `Hi ${params.adminName},\n\n${headline}.\n${bodyLine.replace(/<[^>]+>/g, "")}\n\nChoose a plan: ${upgradeUrl}`;
  return { subject: `${headline} — ${params.businessName}`, html, text };
}

export function downgradeScheduledTemplate(params: {
  businessName: string;
  adminName: string;
  fromPlanName: string;
  toPlanName: string;
  effectiveAt: string; // pre-formatted date string
}): BillingEmailTemplate {
  const manageUrl = billingSettingsUrl();
  const html = baseLayout({
    tagline: "Plan change scheduled",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        We've scheduled a downgrade for <strong>${escapeHtml(params.businessName)}</strong> from
        <strong>${escapeHtml(params.fromPlanName)}</strong> to
        <strong>${escapeHtml(params.toPlanName)}</strong>, effective ${escapeHtml(params.effectiveAt)}.
        Nothing changes until then.
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">
        Changed your mind? You can cancel this scheduled downgrade any time before it takes effect.
      </p>
      ${ctaButtonHtml(manageUrl, "Manage your plan")}
    `,
  });
  const text = `Hi ${params.adminName},\n\nWe've scheduled a downgrade for ${params.businessName} from ${params.fromPlanName} to ${params.toPlanName}, effective ${params.effectiveAt}. Nothing changes until then.\n\nManage your plan: ${manageUrl}`;
  return {
    subject: `Downgrade scheduled — ${params.businessName}`,
    html,
    text,
  };
}

export function downgradeAppliedTemplate(params: {
  businessName: string;
  adminName: string;
  fromPlanName: string;
  toPlanName: string;
}): BillingEmailTemplate {
  const manageUrl = billingSettingsUrl();
  const html = baseLayout({
    tagline: "Plan changed",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        <strong>${escapeHtml(params.businessName)}</strong>'s plan has changed from
        <strong>${escapeHtml(params.fromPlanName)}</strong> to
        <strong>${escapeHtml(params.toPlanName)}</strong>, effective today.
      </p>
      ${ctaButtonHtml(manageUrl, "View your plan")}
    `,
  });
  const text = `Hi ${params.adminName},\n\n${params.businessName}'s plan has changed from ${params.fromPlanName} to ${params.toPlanName}, effective today.\n\nView your plan: ${manageUrl}`;
  return {
    subject: `Your plan is now ${params.toPlanName} — ${params.businessName}`,
    html,
    text,
  };
}

export function upgradeConfirmedTemplate(params: {
  businessName: string;
  adminName: string;
  fromPlanName: string;
  toPlanName: string;
  /** The server's own proration preview/quote (subscription-mutation.service.ts `proratedNow`)
   *  — never recompute this value, only format it. */
  proratedAmount: number;
}): BillingEmailTemplate {
  const manageUrl = billingSettingsUrl();
  const amount = fmtMoney(params.proratedAmount);
  // A zero figure means NO charge applies now (a custom fee, a trial, or a subscription with an unpaid
  // invoice): never claim a prorated charge of $0.00.
  const chargeSentence =
    params.proratedAmount > 0
      ? `We estimate a prorated charge of ${amount} for the remainder of this billing period. The exact amount is calculated by our payment processor and shown on your next invoice.`
      : "No prorated charge applies now; your new plan is reflected on your next invoice.";
  const html = baseLayout({
    tagline: "Plan upgraded",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        <strong>${escapeHtml(params.businessName)}</strong> has upgraded from <strong>${escapeHtml(params.fromPlanName)}</strong> to
        <strong>${escapeHtml(params.toPlanName)}</strong>. ${escapeHtml(chargeSentence)}
      </p>
      ${ctaButtonHtml(manageUrl, "View your plan")}
    `,
  });
  const text = `Hi ${params.adminName},\n\n${params.businessName} has upgraded from ${params.fromPlanName} to ${params.toPlanName}. ${chargeSentence}\n\nView your plan: ${manageUrl}`;
  return {
    subject: `Upgrade confirmed — ${params.businessName}`,
    html,
    text,
  };
}

export function cancelledTemplate(params: {
  businessName: string;
  adminName: string;
}): BillingEmailTemplate {
  const manageUrl = billingSettingsUrl();
  const html = baseLayout({
    tagline: "Subscription cancelled",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        Your RouteFlow subscription for <strong>${escapeHtml(params.businessName)}</strong> has been cancelled.
        Your account will move to read-only access at the end of your current billing period.
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">
        Changed your mind? You can resubscribe any time.
      </p>
      ${ctaButtonHtml(manageUrl, "Resubscribe")}
    `,
  });
  const text = `Hi ${params.adminName},\n\nYour RouteFlow subscription for ${params.businessName} has been cancelled. Your account will move to read-only access at the end of your current billing period.\n\nResubscribe: ${manageUrl}`;
  return {
    subject: `Subscription cancelled — ${params.businessName}`,
    html,
    text,
  };
}

/** The `notifySuspended` reason of a suspension that follows a canceled Stripe subscription (not a payment problem). */
export const SUSPENDED_REASON_SUBSCRIPTION_CANCELED = "subscription canceled";

export function suspendedTemplate(params: {
  businessName: string;
  adminName: string;
  reason: string; // e.g. "overdue payment" | SUSPENDED_REASON_SUBSCRIPTION_CANCELED
}): BillingEmailTemplate {
  const manageUrl = billingSettingsUrl();
  // Lead ruling: a canceled subscription is not a payment problem. Its body says so and the CTA picks a plan
  // (the same "Choose a plan" wording and link as the trial notices); any other reason keeps the payment copy.
  const canceled = params.reason === SUSPENDED_REASON_SUBSCRIPTION_CANCELED;
  const canceledSentence = "Your subscription was canceled. Choose a plan to restore access.";
  const html = baseLayout({
    tagline: "Account suspended",
    bodyHtml: canceled
      ? `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        Your RouteFlow account for <strong>${escapeHtml(params.businessName)}</strong> has been suspended.
        ${canceledSentence}
      </p>
      ${ctaButtonHtml(manageUrl, "Choose a plan")}
    `
      : `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        Your RouteFlow account for <strong>${escapeHtml(params.businessName)}</strong> has been suspended
        (${escapeHtml(params.reason)}). Please update your payment details to restore access.
      </p>
      ${ctaButtonHtml(manageUrl, "Update payment details")}
    `,
  });
  const text = canceled
    ? `Hi ${params.adminName},

Your RouteFlow account for ${params.businessName} has been suspended. ${canceledSentence}

Choose a plan: ${manageUrl}`
    : `Hi ${params.adminName},

Your RouteFlow account for ${params.businessName} has been suspended (${params.reason}). Please update your payment details to restore access.

Update payment details: ${manageUrl}`;
  return {
    subject: `Account suspended — ${params.businessName}`,
    html,
    text,
  };
}

export function checkoutPlanNotAppliedTemplate(params: {
  businessName: string;
  adminName: string;
  requestedPlanKey: string;
}): BillingEmailTemplate {
  const manageUrl = billingSettingsUrl();
  const html = baseLayout({
    tagline: "Payment received, plan not changed",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        We received your payment for <strong>${escapeHtml(params.requestedPlanKey)}</strong> on
        <strong>${escapeHtml(params.businessName)}</strong>, but your plan was NOT changed: it was
        downgraded after you started that checkout, and we never override a newer plan choice.
        Please review your plan below or contact support and we will sort it out.
      </p>
      ${ctaButtonHtml(manageUrl, "Review your plan")}
    `,
  });
  const text = `Hi ${params.adminName},\n\nWe received your payment for ${params.requestedPlanKey} on ${params.businessName}, but your plan was NOT changed: it was downgraded after you started that checkout, and we never override a newer plan choice. Please review your plan or contact support.\n\nReview your plan: ${manageUrl}`;
  return {
    subject: `Payment received, plan not changed — ${params.businessName}`,
    html,
    text,
  };
}

// ─── RouteFlow's own invoice to a manual-pay tenant (manual invoices due, PR3) ─────────────────────────

/** Why the email goes out: the issue email, a d0/d7/d14 reminder, or a super-admin resend. */
export type RfInvoiceEmailKind = "manual" | "issue" | "d0" | "d7" | "d14";

/** The stored invoice fields the email shows. Amounts are the STORED ones: nothing here re-derives money. */
export interface RfInvoiceEmailInput {
  number: string;
  amount: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  dueDate: Date | null;
  lines: unknown;
  /** Whole UTC days past the due date; read by a `manual` resend and a late `issue` email (the stage kinds imply their own). */
  overdueDays?: number;
}

const rfDate = (d: Date | null, withYear: boolean): string =>
  d
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        ...(withYear ? { year: "numeric" } : {}),
        timeZone: "UTC",
      }).format(d)
    : "-";

/** Formats a STORED amount in its own currency; an unknown currency code falls back to "149.00 XYZ". */
function rfMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

interface RfEmailLine {
  label: string;
  quantity: number;
  amount: number;
}

function rfLines(raw: unknown): RfEmailLine[] {
  if (!Array.isArray(raw)) return [];
  const out: RfEmailLine[] = [];
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    out.push({
      label: typeof o.label === "string" ? o.label : typeof o.code === "string" ? o.code : "",
      quantity: Number(o.quantity ?? 1),
      amount: Number(o.amount ?? 0),
    });
  }
  return out;
}

function overdueDaysFor(kind: RfInvoiceEmailKind, inv: RfInvoiceEmailInput): number {
  if (kind === "d7") return 7;
  if (kind === "d14") return 14;
  // manual resend, or an issue email for an invoice issued after its due date: the days so far
  if (kind === "manual" || kind === "issue") return Math.max(0, Math.floor(inv.overdueDays ?? 0));
  return 0;
}

/** The invoice email: subject by kind, a period + line table + stored total, and how to pay. Never throws. */
export function rfInvoiceEmail(
  kind: RfInvoiceEmailKind,
  inv: RfInvoiceEmailInput,
  tenantName: string,
): BillingEmailTemplate {
  const overdue = overdueDaysFor(kind, inv);
  const total = rfMoney(inv.amount, inv.currency);
  const due = rfDate(inv.dueDate, false);
  const subject =
    kind === "d0"
      ? `Reminder: RouteFlow invoice ${inv.number} is due today`
      : overdue > 0
        ? `Reminder: RouteFlow invoice ${inv.number} is ${overdue} ${overdue === 1 ? "day" : "days"} overdue`
        : `RouteFlow invoice ${inv.number}: ${total} due ${due}`;

  const period = `${rfDate(inv.periodStart, true)} to ${rfDate(inv.periodEnd, true)}`;
  const lines = rfLines(inv.lines);
  const payLine = `Pay the way you usually do and include ${inv.number} as the reference. Questions? Reply to this email.`;
  const instructions = process.env.RF_INVOICE_PAY_INSTRUCTIONS?.trim() || "";

  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 0;font-size:14px;color:#374151;">${escapeHtml(l.label)}</td>` +
        `<td style="padding:6px 12px;font-size:14px;color:#374151;text-align:right;">${escapeHtml(String(l.quantity))}</td>` +
        `<td style="padding:6px 0;font-size:14px;color:#374151;text-align:right;">${escapeHtml(rfMoney(l.amount, inv.currency))}</td></tr>`,
    )
    .join("");
  const html = baseLayout({
    tagline: "Invoice",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Invoice <strong>${escapeHtml(inv.number)}</strong> for <strong>${escapeHtml(tenantName)}</strong></p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">Period: ${escapeHtml(period)}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-top:1px solid #f0f0f0;">
        <tr><th align="left" style="padding:6px 0;font-size:12px;color:#9ca3af;">Item</th><th align="right" style="padding:6px 12px;font-size:12px;color:#9ca3af;">Qty</th><th align="right" style="padding:6px 0;font-size:12px;color:#9ca3af;">Amount</th></tr>
        ${rows}
        <tr><td colspan="2" style="padding:10px 0;font-size:15px;font-weight:700;color:#111827;border-top:1px solid #f0f0f0;">Total</td><td style="padding:10px 0;font-size:15px;font-weight:700;color:#111827;text-align:right;border-top:1px solid #f0f0f0;">${escapeHtml(total)}</td></tr>
      </table>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">Due ${escapeHtml(due)}.</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">${escapeHtml(payLine)}</p>
      ${instructions ? `<p style="margin:0 0 16px;font-size:15px;color:#374151;">${escapeHtml(instructions)}</p>` : ""}
    `,
  });
  const text = [
    `Invoice ${inv.number} for ${tenantName}`,
    `Period: ${period}`,
    "",
    ...lines.map((l) => `${l.label}  x${l.quantity}  ${rfMoney(l.amount, inv.currency)}`),
    `Total: ${total}`,
    `Due ${due}.`,
    "",
    payLine,
    ...(instructions ? ["", instructions] : []),
  ].join("\n");
  const replyTo = process.env.PLATFORM_BILLING_REPLY_TO?.trim();
  return { subject, html, text, ...(replyTo ? { replyTo } : {}) };
}

// SA-733r7 PR-B3: the dunning emails (d0 / d3 / d6, the final read-only notice, and the paused notice). The copy is
// truthful for each BILLING_PAUSE_MODE: `d6` names no date (it is what `dark` sends); `final` and `paused` exist only
// in `enforced`. Wording is fixed - no ids, no amounts - and the pay link is the invoice's Stripe-hosted page.
export type DunningEmailKind = "d0" | "d3" | "d6" | "final" | "paused" | "paused_still_owed";

/** "$49.00": cents in the invoice's own currency (USD when Stripe sent none). */
function formatDunningAmount(cents: number, currency?: string | null): string {
  const code = (currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
      fromCents(cents),
    );
  } catch {
    return `${fromCents(cents).toFixed(2)} ${code}`;
  }
}

export function dunningTemplate(params: {
  kind: DunningEmailKind;
  businessName: string;
  adminName: string;
  /** Stripe's hosted invoice page; absent -> the billing settings page. */
  payUrl: string | null;
  /** `final` only: the tenant-local date the workspace becomes read-only. */
  readOnlyOn?: string;
  /**
   * `final` only (SA-775 rollout): the rollout pause holds the lock this notice would threaten, so the workspace will NOT
   * become read-only. The notice then asks for the payment without the deadline, the date or the words "read-only".
   */
  omitLockWarning?: boolean;
  /** `d6` (dark) only: the tenant-local date to update the card by. */
  byDate?: string;
  /** `paused_still_owed` and a never-attempted `d0`: the open invoice's number, amount still owed (cents), currency. */
  invoiceNumber?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  /** `d0` only: false when Stripe never ATTEMPTED the invoice (attempt_count 0, a discovery stamp). Absent = attempted. */
  attempted?: boolean;
  /** `d0` of a never-attempted invoice: the billed month ("October 2026"). */
  periodLabel?: string | null;
}): BillingEmailTemplate {
  const link = params.payUrl || billingSettingsUrl();
  const biz = params.businessName;
  const copy: Record<DunningEmailKind, { subject: string; tagline: string; body: string }> = {
    d0: {
      subject: `Payment failed — ${biz}`,
      tagline: "Payment failed",
      body: `We couldn't process your subscription payment for ${biz}. We'll try again automatically; paying the open invoice now avoids any interruption.`,
    },
    d3: {
      subject: `Your payment is still overdue — ${biz}`,
      tagline: "Payment overdue",
      body: `The subscription invoice for ${biz} is still unpaid. Please pay it or update your payment method to avoid an interruption to your service.`,
    },
    // dark's d6: nothing will happen, so it carries NO read-only threat (SA-733r7 r-note 2) - only the card ask + date.
    d6: {
      subject: `Your payment is still failing — ${biz}`,
      tagline: "Payment overdue",
      body: `The subscription payment for ${biz} is still failing. Please update your card${
        params.byDate ? ` by ${params.byDate}` : " today"
      } to keep your subscription in good standing.`,
    },
    final: {
      subject: `Your workspace becomes read-only tomorrow — ${biz}`,
      tagline: "Final notice",
      body: `The subscription invoice for ${biz} is still unpaid. Unless it is paid, your workspace becomes read-only${
        params.readOnlyOn ? ` on ${params.readOnlyOn}` : " tomorrow"
      }. Your data stays safe, and paying restores full access right away.`,
    },
    // SA G8: the workspace is ALREADY read-only, so this is plain information - no deadline, no alarm words.
    paused_still_owed: {
      subject: `Your workspace is still read-only — ${biz}`,
      tagline: "Workspace read-only",
      body: `${biz} is still read-only. ${
        params.invoiceNumber ? `Invoice ${params.invoiceNumber}` : "Your subscription invoice"
      }${
        typeof params.amountCents === "number" && params.amountCents > 0
          ? ` for ${formatDunningAmount(params.amountCents, params.currency)}`
          : ""
      } is open. Pay it to restore full access right away; your data stays safe.`,
    },
    paused: {
      subject: `Your workspace is now read-only — ${biz}`,
      tagline: "Workspace read-only",
      body: `Because the subscription invoice for ${biz} is unpaid, your workspace is now read-only. Your data is safe and exports still work. Pay the open invoice and full access returns right away.`,
    },
  };
  // A discovery-stamped invoice Stripe never tried must not read "we couldn't process your payment": its first
  // notice says the invoice is open and where to pay it (SA r-note 5 A1, truthful copy keyed by attempt state).
  if (params.kind === "d0" && params.attempted === false) {
    const what = params.periodLabel
      ? `Your ${params.periodLabel} invoice`
      : "Your subscription invoice";
    copy.d0 = {
      subject: `Your invoice is open — ${biz}`,
      tagline: "Invoice open",
      body: `${what}${
        typeof params.amountCents === "number" && params.amountCents > 0
          ? ` for ${formatDunningAmount(params.amountCents, params.currency)}`
          : ""
      } is open — pay it here.`,
    };
  }
  // SA-775: never threaten a lock the pause will not carry out. Same invoice, same milestone - only the wording changes.
  if (params.kind === "final" && params.omitLockWarning === true) {
    copy.final = {
      subject: `Your subscription invoice is still unpaid — ${biz}`,
      tagline: "Payment overdue",
      body: `The subscription invoice for ${biz} is still unpaid. Please pay it or update your payment method to keep your subscription in good standing.`,
    };
  }
  const c = copy[params.kind];
  const label =
    params.kind === "paused" || params.kind === "paused_still_owed"
      ? "Pay the open invoice"
      : "Pay now";
  const html = baseLayout({
    tagline: c.tagline,
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">${escapeHtml(c.body)}</p>
      ${ctaButtonHtml(link, label)}
    `,
  });
  const text = `Hi ${params.adminName},\n\n${c.body}\n\n${label}: ${link}`;
  return { subject: c.subject, html, text };
}

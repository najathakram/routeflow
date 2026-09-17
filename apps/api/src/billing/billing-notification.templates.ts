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

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:6px;background:#1a2033;">
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
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
  const html = baseLayout({
    tagline: "Plan upgraded",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        <strong>${escapeHtml(params.businessName)}</strong> has upgraded from <strong>${escapeHtml(params.fromPlanName)}</strong> to
        <strong>${escapeHtml(params.toPlanName)}</strong>. A prorated charge of
        <strong>${escapeHtml(amount)}</strong> has been applied for the remainder of this billing period.
      </p>
      ${ctaButtonHtml(manageUrl, "View your plan")}
    `,
  });
  const text = `Hi ${params.adminName},\n\n${params.businessName} has upgraded from ${params.fromPlanName} to ${params.toPlanName}. A prorated charge of ${amount} has been applied for the remainder of this billing period.\n\nView your plan: ${manageUrl}`;
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

export function suspendedTemplate(params: {
  businessName: string;
  adminName: string;
  reason: string; // e.g. "overdue payment"
}): BillingEmailTemplate {
  const manageUrl = billingSettingsUrl();
  const html = baseLayout({
    tagline: "Account suspended",
    bodyHtml: `
      <p style="margin:0 0 8px;font-size:15px;color:#6b7280;">Hi ${escapeHtml(params.adminName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;">
        Your RouteFlow account for <strong>${escapeHtml(params.businessName)}</strong> has been suspended
        (${escapeHtml(params.reason)}). Please update your payment details to restore access.
      </p>
      ${ctaButtonHtml(manageUrl, "Update payment details")}
    `,
  });
  const text = `Hi ${params.adminName},\n\nYour RouteFlow account for ${params.businessName} has been suspended (${params.reason}). Please update your payment details to restore access.\n\nUpdate payment details: ${manageUrl}`;
  return {
    subject: `Account suspended — ${params.businessName}`,
    html,
    text,
  };
}

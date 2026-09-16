/**
 * Shared HTML shell for messaging-engine EMAIL sends (N1) — visually matches
 * EmailService's `buildInvoiceEmail` chrome (navy header, white rounded card,
 * gray footer) without depending on that private method. `messaging.helpers.ts`'s
 * `renderTemplate()` has ALREADY substituted `{{vars}}` into `bodyText` by the
 * time this runs, so the WHOLE string is escaped uniformly here — there is no
 * way to tell substituted content from static template text at this point, and
 * escaping everything is a strict superset of "every interpolated value
 * escaped".
 */
export function buildNotificationEmailHtml(params: {
  title: string;
  bodyText: string;
  /** Tenant display name (EmailService.getTenantBusinessName(), "RouteFlow" when
   *  there's no tenant context) — sanitized here the same way EmailService's own
   *  sender-branding does, since this is buyer-facing HTML, not a header value. */
  brandName: string;
}): string {
  const escapedBody = escapeHtml(params.bodyText).replace(/\n/g, "<br/>");
  const escapedTitle = escapeHtml(params.title);
  const escapedBrand = escapeHtml(params.brandName);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr><td style="background:#1a2033;padding:28px 32px;">
          <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">${escapedBrand}</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.6);">${escapedTitle}</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0;font-size:15px;color:#374151;line-height:1.6;">${escapedBody}</p>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">This is an automated email from ${escapedBrand}.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Plain-text alternative (N1) — no HTML escaping needed, this is the text/plain part. */
export function buildNotificationEmailText(params: {
  title: string;
  bodyText: string;
  brandName: string;
}): string {
  return `${params.brandName}\n${params.title}\n\n${params.bodyText}`;
}

/** Exported for tests. Escapes the five characters that matter for HTML text content. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

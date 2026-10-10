import { escapeHtml } from "../common/html-escape";

/**
 * The buyer-portal invite email body (sendPortalInvite). Extracted from customers.service.ts
 * (B809) so escaping every value did not grow that ratcheted file. `sellerName` is the tenant's
 * own business name and `inviteUrl` the server-built accept link; both are HTML-escaped.
 */
export function portalInviteEmailHtml(sellerName: string, inviteUrl: string): string {
  const seller = escapeHtml(sellerName);
  const url = escapeHtml(inviteUrl);
  return `<p>Hi,</p>
<p><strong>${seller}</strong> has invited you to connect on the RouteFlow buyer portal — track orders, invoices, and statements in one place.</p>
<p style="margin:24px 0;">
  <a href="${url}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Accept Invite</a>
</p>
<p>Or paste this link into your browser:<br/><a href="${url}">${url}</a></p>
<p><em>This link expires in 7 days.</em></p>`;
}

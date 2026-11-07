import { emailParagraph, renderEmailLayout, type EmailLook } from "../email/email-layout";
import { escapeHtml } from "../common/html-escape";

/**
 * The buyer-portal invite email (sendPortalInvite). Extracted from customers.service.ts (B809) so
 * escaping every value did not grow that ratcheted file. `sellerName` is the tenant's own business
 * name and `inviteUrl` the server-built accept link; every value is escaped here.
 *
 * Two separate rulings: the LOOK is the tenant's (a business inviting its own buyer: its name,
 * logo and colour, "Sent with RouteFlow", never RouteFlow's mark), so the caller passes the
 * tenant look; the TRANSPORT stays the platform sender (#824: the link is a bearer account-link
 * token, so a copy must never sit in a tenant's mailbox or SMTP provider). The html is rendered
 * here, whole, because the platform path takes finished html and has no `layout` option.
 */
export function portalInviteEmail(
  sellerName: string,
  inviteUrl: string,
  look: EmailLook,
): { subject: string; html: string; text: string } {
  const invited =
    " has invited you to connect on the RouteFlow buyer portal — track orders, invoices, and statements in one place.";
  const expiry = "This link expires in 7 days.";
  const { html, text } = renderEmailLayout({
    look,
    heading: "You're invited to the buyer portal",
    bodyHtml:
      emailParagraph("Hi,") +
      emailParagraph(`<strong>${escapeHtml(sellerName)}</strong>${escapeHtml(invited)}`) +
      emailParagraph(expiry),
    bodyText: ["Hi,", `${sellerName}${invited}`, expiry],
    cta: { label: "Accept invite", url: inviteUrl },
    footerNote: `You are getting this because ${sellerName} invited this address to its buyer portal.`,
  });
  return { subject: `${sellerName} invited you to their RouteFlow buyer portal`, html, text };
}

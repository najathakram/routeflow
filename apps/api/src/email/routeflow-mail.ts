import { BRAND } from "../common/brand";
import { escapeHtml } from "../common/html-escape";
import { emailParagraph, htmlToPlainText, renderEmailLayout } from "./email-layout";

/**
 * The platform's OWN emails (as opposed to mail a tenant sends its people): each builder returns the
 * subject, the layout html and a matching plain-text part. A token link is the button's target
 * and the fallback link's target — never visible text — and the text part carries it in full.
 */
export type BuiltEmail = { subject: string; html: string; text: string };

/** "Save this for later" line: where to sign in and which Workspace ID to type. */
function signIn(webUrl: string, workspaceId: string) {
  const loginUrl = `${webUrl.replace(/\/$/, "")}/login`;
  return {
    html: emailParagraph(
      `Save this for later. To sign in, go to <a href="${escapeHtml(loginUrl)}" style="color:#087D76;">${escapeHtml(loginUrl)}</a> and enter your Workspace ID: <strong>${escapeHtml(workspaceId)}</strong>.`,
    ),
    text: `Save this for later. To sign in, go to ${loginUrl} and enter your Workspace ID: ${workspaceId}.`,
  };
}

/** The verify-your-email message sent when a business signs up, and again on "resend". */
export function verifyEmailMessage(p: {
  verifyUrl: string;
  webUrl: string;
  workspaceId: string;
  businessName: string;
  /** Set for a resend: addresses the person and says it is a new link. */
  resendFor?: { username: string };
}): BuiltEmail {
  const reminder = signIn(p.webUrl, p.workspaceId);
  const introHtml = p.resendFor
    ? `Hi ${escapeHtml(p.resendFor.username)}, here is a new verification link for your ${escapeHtml(BRAND.name)} account (<strong>${escapeHtml(p.businessName)}</strong>).`
    : `Thanks for signing up. Verify your email to open your 14-day ${escapeHtml(BRAND.name)} free trial for <strong>${escapeHtml(p.businessName)}</strong>.`;
  const introText = p.resendFor
    ? `Hi ${p.resendFor.username}, here is a new verification link for your ${BRAND.name} account (${p.businessName}).`
    : `Thanks for signing up. Verify your email to open your 14-day ${BRAND.name} free trial for ${p.businessName}.`;
  const { html, text } = renderEmailLayout({
    look: { kind: "routeflow" },
    heading: "Verify your email",
    preheader: `Verify your email to open your ${BRAND.name} account.`,
    bodyHtml: `${emailParagraph(introHtml)}${emailParagraph("The link works for 24 hours.")}${reminder.html}`,
    bodyText: [introText, "The link works for 24 hours.", reminder.text],
    cta: { label: "Verify my email", url: p.verifyUrl },
    footerNote: `You are getting this because this address was used to sign up for a ${BRAND.name} account. If that was not you, you can ignore this email.`,
  });
  return { subject: `Verify your email to activate ${BRAND.name}`, html, text };
}

/** The password-reset message. The link works for 15 minutes (the token's own expiry). */
export function passwordResetMessage(p: {
  resetUrl: string;
  tenantName?: string | null;
}): BuiltEmail {
  const account = `${BRAND.name} account`;
  const generic = `We received a request to reset the password for your ${account}.`;
  const introHtml = p.tenantName
    ? `We received a request to reset the password for your ${escapeHtml(account)} at <strong>${escapeHtml(p.tenantName)}</strong>.`
    : escapeHtml(generic);
  const introText = p.tenantName
    ? `We received a request to reset the password for your ${account} at ${p.tenantName}.`
    : generic;
  const { html, text } = renderEmailLayout({
    look: { kind: "routeflow" },
    heading: "Reset your password",
    preheader: `Choose a new password for your ${BRAND.name} account.`,
    bodyHtml: `${emailParagraph(introHtml)}${emailParagraph("The link works for 15 minutes.")}`,
    bodyText: [introText, "The link works for 15 minutes."],
    cta: { label: "Choose a new password", url: p.resetUrl },
    footerNote:
      "You are getting this because a password reset was requested for this address. If it was not you, ignore this email and your password will not change.",
  });
  return { subject: `Reset your ${BRAND.name} password`, html, text };
}

/** One line of a notice: plain text, or pieces where `{ b }` is shown bold. Always escaped. */
export type NoticePiece = string | { b: string };
export type NoticeLine = string | NoticePiece[];

const pieceHtml = (x: NoticePiece) =>
  typeof x === "string" ? escapeHtml(x) : `<strong>${escapeHtml(x.b)}</strong>`;
const lineHtml = (l: NoticeLine) =>
  typeof l === "string" ? escapeHtml(l) : l.map((x) => pieceHtml(x)).join("");
const lineText = (l: NoticeLine) =>
  typeof l === "string" ? l : l.map((x) => (typeof x === "string" ? x : x.b)).join("");

/**
 * A short platform notice: lines of plain text (escaped here, so a sender can pass any value),
 * an optional single button, and the true reason the person got it.
 */
export function routeflowNotice(p: {
  subject: string;
  heading: string;
  lines: NoticeLine[];
  cta?: { label: string; url: string };
  why: string;
}): BuiltEmail {
  const { html, text } = renderEmailLayout({
    look: { kind: "routeflow" },
    heading: p.heading,
    preheader: p.subject,
    bodyHtml: p.lines.map((l) => emailParagraph(lineHtml(l))).join(""),
    bodyText: p.lines.map(lineText),
    cta: p.cta,
    footerNote: p.why,
  });
  return { subject: p.subject, html, text };
}

/** "Sign in with {provider} was linked" — sent to the account holder after a link. */
export function signInLinkedMessage(p: {
  provider: "Google" | "Apple";
  address: string;
  portal: boolean;
}): BuiltEmail {
  const account = p.portal ? `${BRAND.name} portal account` : `${BRAND.name} account`;
  return routeflowNotice({
    subject: `${p.provider} Sign-In linked to your ${BRAND.name} account`,
    heading: `${p.provider} Sign-In linked`,
    lines: [
      [`Sign in with ${p.provider} (`, { b: p.address }, `) has been linked to your ${account}.`],
      "If you did not authorise this, please contact support immediately.",
    ],
    why: `You are getting this because a sign-in method was linked to your ${BRAND.name} account.`,
  });
}

/** The "new login detected" security notice. */
export function newLoginMessage(p: { device: string; ip: string; time: string }): BuiltEmail {
  return routeflowNotice({
    subject: `New login detected on your ${BRAND.name} account`,
    heading: "New login detected",
    lines: [
      `A new login was detected on your ${BRAND.name} account.`,
      [{ b: "Device: " }, p.device],
      [{ b: "IP address: " }, p.ip],
      [{ b: "Time: " }, p.time],
      "If this wasn't you, please contact support immediately and change your password.",
    ],
    why: `You are getting this because someone signed in to your ${BRAND.name} account from a device we had not seen before.`,
  });
}

/** The notice sent after a Google-only account (staff or portal) adds a password. */
export function passwordSetMessage(p: { portal: boolean; ip: string; time: string }): BuiltEmail {
  return routeflowNotice({
    subject: `A password was set on your ${BRAND.name} account`,
    heading: "Password set",
    lines: [
      `A password was just set on your ${BRAND.name} ${p.portal ? "portal " : ""}account, which previously signed in with Google only.`,
      [{ b: "Time: " }, p.time],
      [{ b: "IP address: " }, p.ip],
      `You can now sign in with your ${p.portal ? "email" : "username"} and this password as well as with Google. If this wasn't you, reset your password immediately and contact support.`,
    ],
    why: `You are getting this because a password was added to your ${BRAND.name} account.`,
  });
}

/** A platform notice whose body is html a sender already built (escaped there); text is derived. */
export function routeflowFragmentMail(p: {
  subject: string;
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  why: string;
}): BuiltEmail {
  const { html, text } = renderEmailLayout({
    look: { kind: "routeflow" },
    heading: p.heading,
    preheader: p.subject,
    bodyHtml: p.bodyHtml,
    bodyText: [htmlToPlainText(p.bodyHtml)],
    cta: p.cta,
    footerNote: p.why,
  });
  return { subject: p.subject, html, text };
}

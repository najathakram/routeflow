import { BRAND } from "../common/brand";
import { escapeHtml, safeLinkHref } from "../common/html-escape";

/**
 * Brand tokens from the brand guide: Navy header/heading, Teal for the one
 * CTA, Cloud footer band, Steel footer text. Signal Mint is unused (fails contrast on white).
 */
export const BRAND_NAVY = "#1D2A3D";
export const BRAND_TEAL = "#087D76";
export const BRAND_CLOUD = "#F3F7F8";
export const BRAND_STEEL = "#536579";
export const BRAND_WHITE = "#FFFFFF";

/** Absolute https URL (mail clients load neither `data:` nor relative paths): the mail logo under the brand's site. */
export const BRAND_LOGO_URL = `${BRAND.origin}${BRAND.emailLogo}`;
const BRAND_SITE_URL = BRAND.origin;

/**
 * Stamped on the `<body>` of every email this file renders. `EmailService` refuses to send html
 * without it as-is (it wraps it in the layout and logs an error), and
 * `email-layout-inventory.spec.ts` fails on any send path that does not build its html here.
 */
export const EMAIL_LAYOUT_MARKER = 'data-rf-layout="v1"';

/**
 * Whose look an email wears. The platform's own look: its mail (verify, reset, invites, billing,
 * platform alerts). `tenant`: mail a tenant sends its own people — the tenant's name, logo and
 * colour, plus a small "Sent with <platform>" line. `neutral`: no brand at all, for mail whose
 * sender is unknown — the layout never guesses the platform for a tenant's mail.
 */
export type EmailLook =
  | { kind: "routeflow" }
  | { kind: "tenant"; name: string; logoUrl?: string | null; color?: string | null }
  | { kind: "neutral" };

/** How a sender dresses a body fragment: see `EmailSendParams.layout`. */
export type EmailLayoutSpec = {
  heading: string;
  preheader?: string;
  /** The one action: a button, a short fallback link, and the full link in the text part. */
  cta?: { label: string; url: string };
  /** Why this person got the email, said in the footer. */
  footerNote: string;
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** A `#rrggbb` colour as given, otherwise the fallback: a colour never reaches a style attribute unchecked. */
const hexOr = (c: string, fallback: string) => (HEX_COLOR.test(c) ? c : fallback);

/** Relative luminance (0 dark … 1 light) of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * Header bar colour for a tenant's `primaryColor`: a valid `#rrggbb` as is, anything else Navy.
 * `fg` stays readable on it; `button` keeps a white button label readable.
 */
export function resolveBarColors(color?: string | null): {
  bg: string;
  fg: string;
  button: string;
} {
  const bg = color && HEX_COLOR.test(color.trim()) ? color.trim().toUpperCase() : BRAND_NAVY;
  const light = luminance(bg) > 0.4;
  return {
    bg,
    fg: light ? BRAND_NAVY : BRAND_WHITE,
    button: luminance(bg) > 0.3 ? BRAND_NAVY : bg,
  };
}

/** The platform's own logo + wordmark header row, both read from the brand. */
export function brandHeaderHtml(): string {
  // The mark asset is dark: a white chip keeps it visible on the Navy bar.
  return `<table cellpadding="0" cellspacing="0" role="presentation"><tr>
    <td style="vertical-align:middle;padding-right:10px;">
      <table cellpadding="0" cellspacing="0" role="presentation"><tr><td style="background:${BRAND_WHITE};border-radius:6px;padding:4px;" bgcolor="${BRAND_WHITE}">
        <img src="${escapeHtml(BRAND_LOGO_URL)}" width="${escapeHtml(String(BRAND.emailLogoWidth))}" height="${escapeHtml(String(BRAND.emailLogoHeight))}" alt="${escapeHtml(BRAND.name)}" style="display:block;border:0;outline:none;">
      </td></tr></table>
    </td>
    <td style="vertical-align:middle;">
      <span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:${BRAND_WHITE};letter-spacing:-0.3px;">${escapeHtml(BRAND.name.toLowerCase())}.</span>
    </td>
  </tr></table>`;
}

/** A business-name-only header row, in the bar's readable text colour. */
export function tenantHeaderHtml(businessName: string, fg: string = BRAND_WHITE): string {
  return `<span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:${hexOr(fg, BRAND_WHITE)};letter-spacing:-0.3px;">${escapeHtml(businessName)}</span>`;
}

/** A tenant's header: their logo (when they have one) beside their name, on their colour. */
function tenantLookHeaderHtml(
  name: string,
  logoUrl: string | null | undefined,
  fg: string,
): string {
  const src = logoUrl ? safeLinkHref(logoUrl, "tenantLookHeaderHtml") : null;
  if (!src) return tenantHeaderHtml(name, fg);
  return `<table cellpadding="0" cellspacing="0" role="presentation"><tr>
    <td style="vertical-align:middle;padding-right:10px;">
      <table cellpadding="0" cellspacing="0" role="presentation"><tr><td style="background:${BRAND_WHITE};border-radius:6px;padding:4px;" bgcolor="${BRAND_WHITE}">
        <img src="${escapeHtml(src)}" height="28" alt="${escapeHtml(name)}" style="display:block;border:0;outline:none;height:28px;width:auto;max-width:120px;">
      </td></tr></table>
    </td>
    <td style="vertical-align:middle;">${tenantHeaderHtml(name, fg)}</td>
  </tr></table>`;
}

/**
 * A closing sentence that ends in a tenant-typed name ("Sent by Acme Co."): the period is added
 * only when the text does not already end a sentence, so a business named "Acme Co." is not
 * signed "Acme Co.." (CQ-20).
 */
export function endSentence(text: string): string {
  const t = text.trimEnd();
  return /[.!?…]$/.test(t) ? t : `${t}.`; // . ! ? and the ellipsis character
}

/** A branded CTA button — a table cell with the colour on the cell (bulletproof), ≥44px tall. */
export function renderBrandButton(label: string, url: string, color: string = BRAND_TEAL): string {
  const bg = hexOr(color, BRAND_TEAL);
  // B809: a non-http(s) URL renders the button WITHOUT an href (logged and counted), so the
  // email still goes out but can never carry a javascript: or data: link.
  const href = safeLinkHref(url, "renderBrandButton");
  const style = `display:inline-block;padding:14px 28px;line-height:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:${BRAND_WHITE};text-decoration:none;`;
  const button = href
    ? `<a href="${escapeHtml(href)}" style="${style}">${escapeHtml(label)}</a>`
    : `<span style="${style}">${escapeHtml(label)}</span>`;
  return `<table cellpadding="0" cellspacing="0" role="presentation"><tr><td style="background:${bg};border-radius:6px;" bgcolor="${bg}">
    ${button}
  </td></tr></table>`;
}

/**
 * The short, readable text a link shows instead of itself: host and path, never the query string
 * or fragment (which is where a single-use token lives). The visible host is the href's host, so a
 * spam filter never sees link text pointing at a different site than the link.
 */
export function readableLinkText(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    const shown = `${u.host}${path}`;
    return shown.length > 48 ? `${u.host}/…` : shown;
  } catch {
    return "this link";
  }
}

/** The "button not working?" line: a short fallback link, never the raw URL as visible text. */
function fallbackLinkHtml(url: string): string {
  const href = safeLinkHref(url, "fallbackLinkHtml");
  if (!href) return "";
  return `<p style="margin:16px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:${BRAND_STEEL};">If the button does not work, use this link: <a href="${escapeHtml(href)}" style="color:${BRAND_TEAL};">${escapeHtml(readableLinkText(url))}</a></p>`;
}

/** The shell: header bar, heading, body, footer. Every email in the product is built by this. */
function shell(p: {
  headerHtml: string;
  barBg: string;
  heading: string;
  preheader?: string;
  bodyHtml: string;
  footerHtml: string;
}): string {
  const preheader = p.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND_CLOUD};">${escapeHtml(p.preheader)}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
</head>
<body ${EMAIL_LAYOUT_MARKER} style="margin:0;padding:0;background:${BRAND_CLOUD};font-family:Arial,Helvetica,sans-serif;">
${preheader}
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:${BRAND_CLOUD};" bgcolor="${BRAND_CLOUD}">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%;background:${BRAND_WHITE};border-radius:8px;overflow:hidden;" bgcolor="${BRAND_WHITE}">
      <tr><td style="background:${p.barBg};padding:24px 32px;" bgcolor="${p.barBg}">${p.headerHtml}</td></tr>
      <tr><td style="padding:32px;color:${BRAND_NAVY};font-family:Arial,Helvetica,sans-serif;" bgcolor="${BRAND_WHITE}">
        <h1 style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:21px;font-weight:700;color:${BRAND_NAVY};">${escapeHtml(p.heading)}</h1>
        ${p.bodyHtml}
      </td></tr>
      <tr><td style="background:${BRAND_CLOUD};padding:20px 32px;border-top:1px solid #e2e8ef;" bgcolor="${BRAND_CLOUD}">
        ${p.footerHtml}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * The platform's own footer names the previous name after a rename, so a person who knew it still
 * recognises the sender. Empty when the brand has no former name (both names equal).
 */
const hasFormerName = () => BRAND.name !== BRAND.formerly;
const formerlyHtml = () =>
  hasFormerName()
    ? `<p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:${BRAND_STEEL};text-align:center;">${escapeHtml(BRAND.name)}, formerly ${escapeHtml(BRAND.formerly)}</p>`
    : "";
const formerlyText = () => (hasFormerName() ? `\n${BRAND.name}, formerly ${BRAND.formerly}` : "");

const footerLine = (text: string) =>
  `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${BRAND_STEEL};text-align:center;">${escapeHtml(text)}</p>`;

/** What a look contributes to the shell: header row, bar and button colours, the "Sent with" line. */
function lookParts(look: EmailLook): {
  headerHtml: string;
  barBg: string;
  buttonColor: string;
  sentWith: string;
  /** The plain-text twin of `sentWith`, with its own leading line break. */
  sentWithText: string;
} {
  if (look.kind === "tenant") {
    const c = resolveBarColors(look.color);
    return {
      headerHtml: tenantLookHeaderHtml(look.name, look.logoUrl, c.fg),
      barBg: c.bg,
      buttonColor: c.button,
      sentWith: `<p style="margin:8px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:${BRAND_STEEL};text-align:center;">Sent with <a href="${escapeHtml(BRAND_SITE_URL)}" style="color:${BRAND_STEEL};">${escapeHtml(BRAND.name)}</a></p>`,
      sentWithText: `\nSent with ${BRAND.name}`,
    };
  }
  return {
    headerHtml:
      look.kind === "routeflow"
        ? brandHeaderHtml()
        : `<span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:${BRAND_WHITE};">&nbsp;</span>`,
    barBg: BRAND_NAVY,
    buttonColor: BRAND_TEAL,
    sentWith: look.kind === "routeflow" ? formerlyHtml() : "",
    sentWithText: look.kind === "routeflow" ? formerlyText() : "",
  };
}

/**
 * The shell for the older builders in `email.service.ts` and `render-order-receipt.ts`: their own
 * header row (Route Navy bar), or a tenant `look` (its header, colour and "Sent with" line).
 * Returns the HTML AND a plain-text alternative built from the SAME structured pieces the caller
 * supplies, never derived by stripping tags, which could drop a dollar figure or a link.
 */
export function renderBrandedEmail(params: {
  /** Used when no `look` is given. */
  headerHtml?: string;
  look?: EmailLook;
  heading: string;
  bodyHtml: string;
  /** Plain-text paragraphs — parallel content to `bodyHtml`, `\n\n`-joined in the output. */
  bodyText: string[];
  footerNote: string;
}): { html: string; text: string } {
  const parts = lookParts(params.look ?? { kind: "routeflow" });
  const html = shell({
    headerHtml: params.look ? parts.headerHtml : (params.headerHtml ?? parts.headerHtml),
    barBg: parts.barBg,
    heading: params.heading,
    bodyHtml: params.bodyHtml,
    footerHtml: `${footerLine(params.footerNote)}${parts.sentWith}`,
  });
  const sent = parts.sentWithText;
  const text = `${params.heading}\n\n${params.bodyText.join("\n\n")}\n\n--\n${params.footerNote}${sent}`;
  return { html, text };
}

/**
 * THE layout for an email that has a look (see {@link EmailLook}), a single call to action and a
 * "why you got this" line. The button is a table cell, the visible fallback link is short readable
 * text (never the token URL), and the plain-text part carries the full link — so a text-only
 * client still gets a working email. No `List-Unsubscribe`: this is transactional mail.
 */
export function renderEmailLayout(params: {
  look: EmailLook;
  heading: string;
  /** Hidden inbox-preview line. */
  preheader?: string;
  /** HTML paragraphs; every dynamic value in them must already be escaped. */
  bodyHtml: string;
  /** Plain-text paragraphs parallel to `bodyHtml`. */
  bodyText: string[];
  /** The one action. Its URL appears as a button and a short fallback link, and in full in text. */
  cta?: { label: string; url: string };
  /** Why this person got the email, said in the footer. */
  footerNote: string;
}): { html: string; text: string } {
  const { look } = params;
  const { headerHtml, barBg, buttonColor, sentWith, sentWithText } = lookParts(look);
  const cta = params.cta
    ? `<div style="margin:24px 0 0;">${renderBrandButton(params.cta.label, params.cta.url, buttonColor)}</div>${fallbackLinkHtml(params.cta.url)}`
    : "";
  const html = shell({
    headerHtml,
    barBg,
    heading: params.heading,
    preheader: params.preheader,
    bodyHtml: `${params.bodyHtml}${cta}`,
    footerHtml: `${footerLine(params.footerNote)}${sentWith}`,
  });
  const textParts = [params.heading, ...params.bodyText];
  if (params.cta) textParts.push(`${params.cta.label}: ${params.cta.url}`);
  const text = `${textParts.join("\n\n")}\n\n--\n${params.footerNote}${sentWithText}`;
  return { html, text };
}

/** Did this html come out of the layout above? */
export function isLayoutHtml(html: string): boolean {
  return html.includes(EMAIL_LAYOUT_MARKER);
}

/** One body paragraph in the layout's type. `innerHtml` must already be escaped. */
export function emailParagraph(innerHtml: string): string {
  return `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${BRAND_NAVY};">${innerHtml}</p>`;
}

/**
 * The safety net behind the send path: html that did not come out of this file is put inside the
 * layout so no bare mail leaves. It wears the tenant's look when the send belongs to a tenant and
 * a neutral look otherwise — never the platform's, which would be a false sender on a tenant's mail.
 * A full document is unwrapped to its `<body>` first. The text part is the caller's, untouched.
 */
export function wrapUnbrandedHtml(p: {
  look: EmailLook;
  subject: string;
  html: string;
  footerNote: string;
}): string {
  const inner = /<body[^>]*>([\s\S]*)<\/body>/i.exec(p.html)?.[1] ?? p.html;
  return renderEmailLayout({
    look: p.look,
    heading: p.subject,
    bodyHtml: inner,
    bodyText: [],
    footerNote: p.footerNote,
  }).html;
}

/**
 * A subject as ONE header line (B460). Every line break (CR, LF, NEL, LS, PS) with the spaces around it folds to a
 * single space, so a tenant-supplied name in a subject can never start a second header (`Bcc:`). The same rule
 * as the CR/LF fold EmailService applies to a From display name, applied once at the send seam, not per template.
 */
export function headerSafeSubject(subject: string): string {
  return subject.replace(/\s*[\r\n\u0085\u2028\u2029]+\s*/g, " ").trim();
}

/**
 * Plain text for a short html fragment a sender already built: paragraph breaks kept, tags
 * dropped, and every link written out as `text (url)` so a link is never lost from the text part.
 */
export function htmlToPlainText(html: string): string {
  const decode = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  return decode(
    html
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
      .replace(/<\/(p|blockquote|ul|ol|div|h[1-6])>/gi, "\n\n")
      .replace(/<\/li>|<\/tr>|<br\s*\/?>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

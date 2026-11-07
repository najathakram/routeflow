import { htmlToPlainText } from "../email/email-layout";

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The visible words of each `<p>` in an email's html (links keep their text, not their url).
 * `footer: false` leaves out the layout's small footer line, for a sender whose text part never
 * carried one.
 */
export function htmlParagraphs(html: string, opts: { footer?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)) {
    if (opts.footer === false && /font-size:12px/.test(m[0])) continue;
    const words = collapse(htmlToPlainText(m[0].replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, "$1")));
    // The fallback-link line carries the url in an href; its text part is the `label: url` line.
    if (words && !/use this link/i.test(words)) out.push(words);
  }
  return out;
}

/**
 * Every html paragraph that the text part does not say, word for word (empty = the two parts
 * agree). The text part is what a text-only client and a screen reader on some clients read.
 */
export function paragraphsMissingFromText(
  html: string,
  text: string,
  opts: { footer?: boolean } = {},
): string[] {
  const t = collapse(text);
  return htmlParagraphs(html, opts).filter((p) => !t.includes(p));
}

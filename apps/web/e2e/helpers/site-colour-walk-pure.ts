/**
 * The pure half of the T16 colour walk (SA-1203 A11): no browser, no Playwright import, so the rules that
 * judge a walk can be tested by Jest. The in-page reading lives in site-colour-walk.ts.
 */

/** One focusable element, as the page reports it. */
export type FocusInfo = {
  /** A short readable name for messages. */
  el: string;
  tag: string;
  /** The resolved href of a link (origin, path, query, hash), or null for anything else. */
  href: string | null;
  /** The accessible name: aria-label, then its text, then title, then value. */
  name: string;
  /** The form, aria-controls and data-track targets, joined with "|" (empty parts kept). */
  target: string;
};

/** A focusable element the walk did not measure, and why. */
export type Skip = FocusInfo & { reason: string; sizeOnly: boolean };

/**
 * An element that legitimately exists at one size only and has no counterpart at the other (for example a
 * desktop-only illustration link). One entry is page + size + selector + a one-line reason. The list starts
 * EMPTY, its length is pinned by a static test (site-colour-walk.static.test.ts), and every new entry is a
 * reviewed diff. It is never filled from a run (SA-1203 A11 C2).
 */
export type SizeOnly = { page: string; size: string; selector: string; reason: string };
export const T16_SIZE_ONLY: readonly SizeOnly[] = [];

/** The reasons a focusable element may go unmeasured with no further condition. */
export const ALLOWED_SKIPS = ["disabled", "inert", "closed-dialog"] as const;

/** A skip for "not-rendered" passes only through the equivalence rule (C1) or a T16_SIZE_ONLY entry. */
export const NOT_RENDERED = "not-rendered";

/** origin + path of a resolved href, and the hash (empty when it has none). Null when it is not a URL. */
export function hrefParts(href: string): { base: string; hash: string } | null {
  try {
    const u = new URL(href);
    return { base: `${u.origin}${u.pathname}`, hash: u.hash === "#" ? "" : u.hash };
  } catch {
    return null;
  }
}

/**
 * Two focusable elements are equivalent when:
 *   - both are links and their resolved hrefs match: origin and path, and the hash only if BOTH carry one; or
 *   - neither is a link, their accessible names match (and are not empty), and so does their
 *     form / aria-controls / data-track target.
 */
export function equivalent(a: FocusInfo, b: FocusInfo): boolean {
  if (a.href !== null || b.href !== null) {
    if (a.href === null || b.href === null) return false;
    const x = hrefParts(a.href);
    const y = hrefParts(b.href);
    if (!x || !y || x.base !== y.base) return false;
    return x.hash === "" || y.hash === "" || x.hash === y.hash;
  }
  return a.name !== "" && a.name === b.name && a.target === b.target;
}

/**
 * C1: every not-rendered skip must have an equivalent MEASURED element at the same page and size, or a
 * T16_SIZE_ONLY entry (already folded into `sizeOnly`). Returns the problems, and how many skips the rule
 * accepted through an equivalent (the counted skips of plant W2).
 */
export function notRenderedProblems(
  label: string,
  skipped: readonly Skip[],
  measured: readonly FocusInfo[],
): { problems: string[]; accepted: number } {
  const problems: string[] = [];
  let accepted = 0;
  for (const s of skipped) {
    if (s.reason !== NOT_RENDERED) continue;
    if (s.sizeOnly) continue;
    if (measured.some((m) => equivalent(s, m))) accepted++;
    else problems.push(`T16 ${label}: ${s.el} not rendered and no equivalent measured`);
  }
  return { problems, accepted };
}

/** Every reason other than the allowed ones and not-rendered is a red: "unsettled", "focus-refused", anything new. */
export function otherSkipProblems(label: string, skipped: readonly Skip[]): string[] {
  return skipped
    .filter(
      (s) => s.reason !== NOT_RENDERED && !(ALLOWED_SKIPS as readonly string[]).includes(s.reason),
    )
    .map((s) => `T16 ${label}: ${s.el} not measured: ${s.reason}`);
}

/** The length pin on the exemption list: an entry is added only by a reviewed diff that changes this number. */
export const T16_SIZE_ONLY_LENGTH = 0;
export const sizeOnlyLengthOk = (list: readonly SizeOnly[]): boolean =>
  list.length === T16_SIZE_ONLY_LENGTH;

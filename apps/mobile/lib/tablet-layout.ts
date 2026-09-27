/**
 * #2311 (iPad pass, PR 1): the ONE width rule every screen shares on a wide window, so a phone
 * layout is never stretched edge to edge on an 11- or 13-inch iPad, in portrait or landscape.
 *
 * Pure (window width in, layout out) so it is pinned in jest without rendering; the
 * `ContentWidth` component (components/ContentWidth.tsx) is its only React consumer.
 */

/** Below this window width the device is laid out as a phone: full width, one column. */
export const TABLET_MIN_WIDTH = 700;

/** The widest a single reading/form column ever gets — past this, lines get too long to scan. */
export const CONTENT_MAX_WIDTH = 760;

/** The widest a multi-column list/dashboard grid gets before it centres. */
export const WIDE_CONTENT_MAX_WIDTH = 1180;

export function isTabletWidth(windowWidth: number): boolean {
  return windowWidth >= TABLET_MIN_WIDTH;
}

/**
 * How many columns a list/card grid uses at this window width: 1 on a phone, 2 on a tablet in
 * portrait (an 11-inch iPad is 834pt wide), 3 once there is room (13-inch landscape is 1376pt).
 */
export function gridColumns(windowWidth: number): 1 | 2 | 3 {
  if (!isTabletWidth(windowWidth)) return 1;
  return windowWidth >= 1100 ? 3 : 2;
}

/** The content width a wrapper resolves to: the window itself on a phone, capped on a tablet. */
export function contentWidth(windowWidth: number, variant: "column" | "wide" = "column"): number {
  const cap = variant === "wide" ? WIDE_CONTENT_MAX_WIDTH : CONTENT_MAX_WIDTH;
  return Math.min(windowWidth, cap);
}

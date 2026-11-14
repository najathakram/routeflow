// The <head> block of the signed-out React pages (privacy, terms, sign-in, sign-up, password reset,
// buyer sign-in). Each of their layouts calls this, so the title, share block (`openGraph`),
// `icons`, `appleWebApp`, `metadataBase` and `themeColor` do not come from the root layout or from
// buyer/layout.tsx: Next replaces `openGraph`, `icons` and `appleWebApp` as whole units and takes
// `themeColor` from the deepest layout. Still inherited: `description` and `manifest` (the app's).
// The root layout lists `/favicon.ico` in its own `icons`; these layouts' `icons`
// replace that list. Name, host and icon paths come from the brand seam
// (packages/types/brand/brand.json); lane 2.6a, spec-delta rev 4 section 1.
import type { Metadata, Viewport } from "next";
import { BRAND } from "@routeflow/types/brand";

/** The tab title is "Page · Name" here. The ready-made pages use brand.json's titleSeparator. */
const TITLE_SEPARATOR = " · ";

/** The share description these pages have always carried (the root layout's). */
export const FRONT_DOOR_SHARE_DESCRIPTION = "Wholesale distribution, simplified.";

/** Sign-in side pages carry a white browser bar (the root's ink and the buyer layout's green are
 *  for the signed-in app). */
export const FRONT_DOOR_THEME_COLOR = "#ffffff";

export const frontDoorViewport: Viewport = { themeColor: FRONT_DOOR_THEME_COLOR };

export interface FrontDoorInput {
  /** The segment's own tab title, shown as "Page · Name". Omit for the bare label. */
  page?: string;
  /** What the tab says with no page, and the share title. Defaults to the name. */
  label?: string;
  /** The share description. Defaults to the one the site has always used. */
  shareDescription?: string;
  /** Search-engine rules for a form page that is not for finding. */
  robots?: Metadata["robots"];
}

export function frontDoorMetadata(input: FrontDoorInput = {}): Metadata {
  const label = input.label ?? BRAND.name;
  return {
    metadataBase: new URL(BRAND.origin),
    title: {
      default: input.page ? `${input.page}${TITLE_SEPARATOR}${BRAND.name}` : label,
      template: `%s${TITLE_SEPARATOR}${BRAND.name}`,
    },
    ...(input.robots !== undefined ? { robots: input.robots } : {}),
    openGraph: {
      title: label,
      description: input.shareDescription ?? FRONT_DOOR_SHARE_DESCRIPTION,
      siteName: BRAND.name,
      type: "website",
      images: [{ url: BRAND.icon["512"] }],
    },
    // Restated whole: Next replaces appleWebApp as a unit.
    appleWebApp: {
      capable: true,
      title: BRAND.name,
      statusBarStyle: "black-translucent",
      startupImage: BRAND.icon["192"],
    },
    icons: {
      icon: [{ url: BRAND.icon.favicon, type: "image/png", sizes: "64x64" }],
      apple: [{ url: BRAND.icon.apple, sizes: "180x180" }],
      shortcut: BRAND.icon.favicon,
    },
  };
}

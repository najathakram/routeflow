// One helper for every marketing page's <head> block (W8). A page that sets its own
// `openGraph` replaces the root layout's whole share block in Next, which is how all 11
// pages lost their share image. Every page calls this instead, so the image, the card and
// the canonical path can't be left out on one page. Words stay with each caller.

import type { Metadata } from "next";
import { site } from "./site";

/** The two lines on the share image. Words are from COPY.md section 8. */
export const SHARE_IMAGE_LINES = {
  name: "RouteFlow",
  line: "Wholesale software for orders and delivery.",
} as const;

/**
 * Served by `app/(marketing)/opengraph-image/route.tsx`. It is a route handler, not Next's
 * `opengraph-image.tsx` file convention, on purpose: the file convention serves the image at a
 * hashed path (`/opengraph-image-<hash>`) and only attaches it to the segment it sits in, so a
 * page that sets its own `openGraph` (all 11 do) can't name it. A route keeps one stable URL.
 */
export const SHARE_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: `${SHARE_IMAGE_LINES.name}. ${SHARE_IMAGE_LINES.line}`,
} as const;

export interface MarketingMetadataInput {
  /** Route path, e.g. "/pricing". Used for the canonical link and the share URL. */
  path: string;
  /** The tab title. `{ absolute }` skips the root "%s · RouteFlow" template (home only). */
  title?: string | { absolute: string };
  /** Search description. Leave out to inherit the root layout's. */
  description?: string;
  /** Share lines when they differ from the title and description. */
  share?: { title?: string; description?: string };
}

export function marketingMetadata(input: MarketingMetadataInput): Metadata {
  const titleText = typeof input.title === "string" ? input.title : input.title?.absolute;
  const shareTitle = input.share?.title ?? titleText;
  const shareDescription = input.share?.description ?? input.description;
  const images = [{ ...SHARE_IMAGE }];

  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    alternates: { canonical: input.path },
    openGraph: {
      ...(shareTitle !== undefined ? { title: shareTitle } : {}),
      ...(shareDescription !== undefined ? { description: shareDescription } : {}),
      url: input.path,
      siteName: site.name,
      type: "website",
      images,
    },
    twitter: {
      card: "summary_large_image",
      ...(shareTitle !== undefined ? { title: shareTitle } : {}),
      ...(shareDescription !== undefined ? { description: shareDescription } : {}),
      images,
    },
  };
}

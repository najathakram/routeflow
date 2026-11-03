import type { Metadata } from "next";
import sitemap from "../sitemap";
import robots from "../robots";
import { metadata as privacyMetadata } from "./privacy/page";
import { metadata as termsMetadata } from "./terms/page";

// Production SEO stance: permissive robots.ts pointing at the sitemap, a sitemap that lists the
// public pages once each, and the two React pages left in the site (Privacy, Terms) carrying their
// published title and description and the share image. Every other page is a ready-made file under
// public/site, whose head is pinned in static-site.test.ts. The old pages (/wholesalers,
// /retailers, /book-a-demo) redirect and are not listed (old-pages-redirect.static.test.ts).

const EXPECTED_ROUTE_METADATA: Record<string, { title: string; description: string }> = {
  privacy: {
    title: "Privacy Policy",
    description: "How RouteFlow collects, uses, and protects the information you share with us.",
  },
  terms: {
    title: "Terms of Service",
    description: "The terms that apply to accessing and using the RouteFlow platform.",
  },
};

const metadataByRoute: Record<string, Metadata> = {
  privacy: privacyMetadata,
  terms: termsMetadata,
};

// The share image is the code-built /opengraph-image.
const SHARE_IMAGE_PATH = "/opengraph-image";

function shareImageUrls(metadata: Metadata): string[] {
  const images = metadata.openGraph?.images;
  const list = images === undefined ? [] : Array.isArray(images) ? images : [images];
  return list.map((image) =>
    typeof image === "string" ? image : String((image as { url: unknown }).url),
  );
}

describe("marketing SEO", () => {
  it("the React pages name the share image and use the large-image card", () => {
    for (const [slug, metadata] of Object.entries(metadataByRoute)) {
      expect({ slug, images: shareImageUrls(metadata) }).toEqual({
        slug,
        images: [SHARE_IMAGE_PATH],
      });
      const twitter = metadata.twitter as { card?: string } | null | undefined;
      expect({ slug, card: twitter?.card }).toEqual({ slug, card: "summary_large_image" });
    }
  });

  it("sitemap.ts lists the 11 public URLs once each: the site's pages, Privacy and Terms", () => {
    const urls = sitemap()
      .map((entry) => entry.url)
      .sort();
    const expected = [
      "https://www.routeflow.info/",
      "https://www.routeflow.info/product",
      "https://www.routeflow.info/pricing",
      "https://www.routeflow.info/company",
      "https://www.routeflow.info/contact",
      "https://www.routeflow.info/privacy",
      "https://www.routeflow.info/terms",
      "https://www.routeflow.info/getting-started",
      "https://www.routeflow.info/does-and-doesnt",
      "https://www.routeflow.info/data-in-and-out",
      "https://www.routeflow.info/security",
    ].sort();
    expect(urls).toEqual(expected);
  });

  it("the sitemap lists none of the old addresses", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const gone of ["wholesalers", "retailers", "book-a-demo", "sign-in", "about", "demo"]) {
      expect(urls).not.toContain(`https://www.routeflow.info/${gone}`);
    }
  });

  it("robots.ts allows everything and points at the sitemap", () => {
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
    expect(result.sitemap).toBe("https://www.routeflow.info/sitemap.xml");
  });

  it.each(Object.keys(EXPECTED_ROUTE_METADATA))(
    "%s route metadata carries the published title and description",
    (slug) => {
      const expected = EXPECTED_ROUTE_METADATA[slug];
      expect(metadataByRoute[slug]?.title).toBe(expected.title);
      expect(metadataByRoute[slug]?.description).toBe(expected.description);
    },
  );

  it("privacy and terms do not opt out of indexing: they carry the real policy text", () => {
    const privacyRobots = privacyMetadata?.robots as { index?: boolean } | undefined;
    const termsRobots = termsMetadata?.robots as { index?: boolean } | undefined;
    expect(privacyRobots?.index).not.toBe(false);
    expect(termsRobots?.index).not.toBe(false);
  });
});

import type { Metadata } from "next";
import sitemap from "../sitemap";
import robots from "../robots";
import { metadata as productMetadata } from "./product/page";
import { metadata as wholesalersMetadata } from "./wholesalers/page";
import { metadata as retailersMetadata } from "./retailers/page";
import { metadata as pricingMetadata } from "./pricing/page";
import { metadata as companyMetadata } from "./company/page";
import { metadata as contactMetadata } from "./contact/page";
import { metadata as privacyMetadata } from "./privacy/page";
import { metadata as termsMetadata } from "./terms/page";
import { metadata as homeMetadata } from "./page";
import { metadata as bookADemoMetadata } from "./book-a-demo/page";
import { metadata as signInMetadata } from "./sign-in/page";
import Home from "./page";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// R-MKT T9 — production SEO stance: 9-URL sitemap, permissive robots.ts
// pointing at it, and per-route metadata carried verbatim from M1 §2
// (local-assets/handoff/2026-09-06/redesign/marketing-inventory-redesign.md,
// sourced from the redesign's lib/site.ts routes[] table — the plan's
// cited, implementation-independent oracle), except privacy/terms, whose
// title/description are the published legal pages' own copy (R9 follow-up
// — those two routes were interim placeholder shells, deliberately
// excluded from the sitemap and noindex'd, until the real policy text
// shipped; they are now ordinary indexable pages like the rest of the
// site — see SITEMAP_EXCLUDED_SLUGS in lib/site.ts).

const EXPECTED_ROUTE_METADATA: Record<string, { title: string; description: string }> = {
  product: {
    title: "Wholesale operations, connected",
    description:
      "See how RouteFlow connects ordering, dispatch, proof of delivery, and customer accounts.",
  },
  wholesalers: {
    title: "A clearer day for your distribution team",
    description:
      "Manage wholesale orders and delivery routes with shared context for the office, warehouse, and drivers.",
  },
  retailers: {
    title: "Restock with less back and forth",
    description:
      "Browse your connected suppliers, place orders, and keep track of purchases in the RouteFlow retailer portal.",
  },
  pricing: {
    title: "Find the right RouteFlow plan",
    description:
      "Talk through your order volume, team, and delivery workflow to choose a RouteFlow plan.",
  },
  company: {
    title: "For the people who keep shelves stocked",
    description: "Learn about the wholesale workflows and people at the center of RouteFlow.",
  },
  contact: {
    title: "See RouteFlow in action",
    // W6 (COPY.md 2j): the title stays for now, the description says the two ways in.
    description: "Email us or book a video call.",
  },
  privacy: {
    title: "Privacy Policy",
    description: "How RouteFlow collects, uses, and protects the information you share with us.",
  },
  terms: {
    title: "Terms of Service",
    description: "The terms that apply to accessing and using the RouteFlow platform.",
  },
};

// Next's `Metadata` types `title`/`description` as unions (TemplateString,
// null, …); this test only compares them to strings, so read them as `unknown`
// rather than widening to `any` (the repo's `next lint` config does not
// register the @typescript-eslint plugin, so a rule-specific disable comment
// for `no-explicit-any` is itself a lint error).
const metadataByRoute: Record<string, { title?: unknown; description?: unknown }> = {
  product: productMetadata,
  wholesalers: wholesalersMetadata,
  retailers: retailersMetadata,
  pricing: pricingMetadata,
  company: companyMetadata,
  contact: contactMetadata,
  privacy: privacyMetadata,
  terms: termsMetadata,
};

// W8 (S1-S4). The home title keeps "distributors" for search; the share image
// is the code-built /opengraph-image; the structured data sits on the home page.
const HOME_TITLE = "RouteFlow: order and delivery software for wholesale distributors";
const SHARE_IMAGE_PATH = "/opengraph-image";

const ALL_PAGE_METADATA: Record<string, Metadata> = {
  home: homeMetadata,
  product: productMetadata,
  wholesalers: wholesalersMetadata,
  retailers: retailersMetadata,
  pricing: pricingMetadata,
  company: companyMetadata,
  contact: contactMetadata,
  privacy: privacyMetadata,
  terms: termsMetadata,
  "book-a-demo": bookADemoMetadata,
  "sign-in": signInMetadata,
};

function shareImageUrls(metadata: Metadata): string[] {
  const images = metadata.openGraph?.images;
  const list = images === undefined ? [] : Array.isArray(images) ? images : [images];
  return list.map((image) =>
    typeof image === "string" ? image : String((image as { url: unknown }).url),
  );
}

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(pattern)) blocks.push(JSON.parse(match[1] ?? "null"));
  return blocks;
}

describe("marketing SEO — R-MKT T9", () => {
  it("S1: the home title is the full title, not the bare site name (W8)", () => {
    const title = homeMetadata.title as { absolute?: string } | string | undefined;
    const resolved = typeof title === "string" ? title : title?.absolute;
    expect(resolved).toBe(HOME_TITLE);
  });

  it("S1: home keeps its share lines as they were (W8 only carries them; W0 changes them)", () => {
    expect(homeMetadata.openGraph?.title).toBe(
      "Turn scattered orders into organized deliveries · RouteFlow",
    );
    expect(homeMetadata.openGraph?.description).toBe(
      "Connect wholesale orders, route planning, delivery confirmation, and customer accounts.",
    );
  });

  it("S2: every one of the 11 marketing pages names the share image (W8)", () => {
    const withImage = Object.entries(ALL_PAGE_METADATA)
      .filter(([, metadata]) => shareImageUrls(metadata).includes(SHARE_IMAGE_PATH))
      .map(([slug]) => slug);
    expect(withImage.sort()).toEqual(Object.keys(ALL_PAGE_METADATA).sort());
  });

  it("S2: the share card is the large-image card on every page (W8)", () => {
    for (const [slug, metadata] of Object.entries(ALL_PAGE_METADATA)) {
      const twitter = metadata.twitter as { card?: string } | null | undefined;
      expect({ slug, card: twitter?.card }).toEqual({ slug, card: "summary_large_image" });
    }
  });

  it("S4: the home page carries structured data for the organization and the software, with no ratings (W8)", () => {
    const blocks = jsonLdBlocks(renderToStaticMarkup(createElement(Home)));
    const nodes = blocks.flatMap((block) => {
      const graph = (block as { "@graph"?: unknown[] })["@graph"];
      return Array.isArray(graph) ? graph : [block];
    }) as Array<Record<string, unknown>>;
    const types = nodes.map((node) => node["@type"]);
    expect(types).toEqual(expect.arrayContaining(["Organization", "SoftwareApplication"]));
    const text = JSON.stringify(blocks);
    for (const banned of ["aggregateRating", "ratingValue", "reviewCount", '"review"', "offers"]) {
      expect(text).not.toContain(banned);
    }
    const org = nodes.find((node) => node["@type"] === "Organization");
    expect(org?.name).toBe("RouteFlow");
    expect(org?.url).toBe("https://www.routeflow.info");
  });

  it("sitemap.ts lists exactly the 10 public URLs, privacy/terms and the demo page included (R-MKT T9, W8 S3)", () => {
    const entries = sitemap();
    const urls = entries
      .map((entry) => entry.url)
      .slice()
      .sort();
    const expected = [
      "https://www.routeflow.info/",
      "https://www.routeflow.info/product",
      "https://www.routeflow.info/wholesalers",
      "https://www.routeflow.info/retailers",
      "https://www.routeflow.info/pricing",
      "https://www.routeflow.info/company",
      "https://www.routeflow.info/contact",
      "https://www.routeflow.info/privacy",
      "https://www.routeflow.info/terms",
      "https://www.routeflow.info/book-a-demo",
    ].sort();

    expect(urls).toEqual(expected);
  });

  it("robots.ts allows everything and points at the sitemap (R-MKT T9)", () => {
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
    expect(result.sitemap).toBe("https://www.routeflow.info/sitemap.xml");
  });

  it.each(Object.keys(EXPECTED_ROUTE_METADATA))(
    "%s route metadata carries the M1 title and description verbatim (R-MKT T9)",
    (slug) => {
      const expected = EXPECTED_ROUTE_METADATA[slug];
      const metadata = metadataByRoute[slug];
      expect(metadata?.title).toBe(expected?.title);
      expect(metadata?.description).toBe(expected?.description);
    },
  );

  it("no route title or description mentions the preview/redesign (R-MKT T9)", () => {
    for (const { title, description } of Object.values(EXPECTED_ROUTE_METADATA)) {
      expect(title.toLowerCase()).not.toContain("preview");
      expect(title.toLowerCase()).not.toContain("redesign");
      expect(description.toLowerCase()).not.toContain("preview");
      expect(description.toLowerCase()).not.toContain("redesign");
    }
  });

  it("privacy and terms do NOT opt out of indexing — they carry the real policy text now (R-MKT T9)", () => {
    // `Metadata["robots"]` is typed `string | Robots | ...`; these routes
    // don't declare a `robots` override at all now that they're ordinary
    // indexable pages, so narrow to the object shape only if one is present.
    const privacyRobots = privacyMetadata?.robots as { index?: boolean } | undefined;
    const termsRobots = termsMetadata?.robots as { index?: boolean } | undefined;
    expect(privacyRobots?.index).not.toBe(false);
    expect(termsRobots?.index).not.toBe(false);
  });
});

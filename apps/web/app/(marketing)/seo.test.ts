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

// R-MKT T9 — production SEO stance: 7-URL sitemap (legal shells excluded),
// permissive robots.ts pointing at it, and per-route metadata carried
// verbatim from M1 §2 (local-assets/handoff/2026-09-06/redesign/
// marketing-inventory-redesign.md, sourced from the redesign's lib/site.ts
// routes[] table — the plan's cited, implementation-independent oracle).

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
    description:
      "Request a focused walkthrough of wholesale orders, routes, and customer accounts.",
  },
  privacy: {
    title: "Privacy information",
    description:
      "How RouteFlow handles the information you share with us while the full privacy policy is finalised.",
  },
  terms: {
    title: "Terms information",
    description:
      "The terms that apply to using RouteFlow while the full terms of service are finalised.",
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

describe("marketing SEO — R-MKT T9", () => {
  it("sitemap.ts lists exactly the 7 public URLs and excludes the legal shells (R-MKT T9)", () => {
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
    ].sort();

    expect(urls).toEqual(expected);
    expect(urls).not.toContain("https://www.routeflow.info/privacy");
    expect(urls).not.toContain("https://www.routeflow.info/terms");
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

  it("privacy and terms opt out of indexing (R-MKT T9)", () => {
    // `Metadata["robots"]` is typed `string | Robots | ...`; these routes
    // must use the object form, so narrow to the object shape before reading
    // `.index`.
    const privacyRobots = privacyMetadata?.robots as { index?: boolean } | undefined;
    const termsRobots = termsMetadata?.robots as { index?: boolean } | undefined;
    expect(privacyRobots?.index).toBe(false);
    expect(termsRobots?.index).toBe(false);
  });
});

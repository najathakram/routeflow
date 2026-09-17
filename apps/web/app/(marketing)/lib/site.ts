// Single source of truth for marketing-site identity and per-route SEO
// metadata. One `routes` table drives the header/footer nav, the sitemap,
// and every route's <title>/description — never hand-mirror this shape
// elsewhere (lesson L-072: a hand-typed mirror is how bugs ship).
// Titles/descriptions are verbatim from the redesign's lib/site.ts
// (M1 §2 / marketing-inventory-redesign.md), except the two legal rows
// (privacy/terms), whose <title>/description match the published legal
// pages' own copy instead of the redesign's preview-only text.

import { Package, Route, Warehouse, type LucideIcon } from "lucide-react";

export const site = {
  name: "RouteFlow",
  origin: "https://www.routeflow.info",
  email: "hello@routeflow.info",
};

export interface MarketingRoute {
  slug: string;
  label: string;
  title: string;
  description: string;
}

export const routes: MarketingRoute[] = [
  {
    slug: "product",
    label: "Platform",
    title: "Wholesale operations, connected",
    description:
      "See how RouteFlow connects ordering, dispatch, proof of delivery, and customer accounts.",
  },
  {
    slug: "wholesalers",
    label: "Distributors",
    title: "A clearer day for your distribution team",
    description:
      "Manage wholesale orders and delivery routes with shared context for the office, warehouse, and drivers.",
  },
  {
    slug: "retailers",
    label: "Retailers",
    title: "Restock with less back and forth",
    description:
      "Browse your connected suppliers, place orders, and keep track of purchases in the RouteFlow retailer portal.",
  },
  {
    slug: "pricing",
    label: "Pricing",
    title: "Find the right RouteFlow plan",
    description:
      "Talk through your order volume, team, and delivery workflow to choose a RouteFlow plan.",
  },
  {
    slug: "company",
    label: "Company",
    title: "For the people who keep shelves stocked",
    description: "Learn about the wholesale workflows and people at the center of RouteFlow.",
  },
  {
    slug: "contact",
    label: "Contact",
    title: "See RouteFlow in action",
    description:
      "Request a focused walkthrough of wholesale orders, routes, and customer accounts.",
  },
  {
    slug: "privacy",
    label: "Privacy",
    title: "Privacy Policy",
    description: "How RouteFlow collects, uses, and protects the information you share with us.",
  },
  {
    slug: "terms",
    label: "Terms",
    title: "Terms of Service",
    description: "The terms that apply to accessing and using the RouteFlow platform.",
  },
];

/** The five primary-nav routes, in header/footer order. */
export const NAV_SLUGS = ["product", "wholesalers", "retailers", "pricing", "company"] as const;

/** Slugs excluded from the sitemap (legal shells, R9/T9). */
// privacy/terms were excluded while they were placeholder shells; now that they carry the
// real published policy they are ordinary indexable pages like the rest of the site.
export const SITEMAP_EXCLUDED_SLUGS = [] as const;

export interface PricingPlan {
  name: string;
  tag: string;
  text: string;
  icon: LucideIcon;
  items: string[];
}

/**
 * The three pricing plans — shared between /pricing (the full page) and the
 * home page's pricing teaser (owner layout ruling, 2026-09-16, PR-3: "3 real
 * cards from the real pricing data"). Single source so the two never drift.
 */
export const PLANS: PricingPlan[] = [
  {
    name: "Starter",
    tag: "GET YOUR WORKFLOW ORGANIZED",
    text: "For a smaller team bringing customer orders into one place.",
    icon: Package,
    items: ["Customer and product records", "Order management", "Retailer ordering portal"],
  },
  {
    name: "Growth",
    tag: "CONNECT YOUR DELIVERY OPERATION",
    text: "For teams coordinating orders, drivers, and regular delivery runs.",
    icon: Route,
    items: [
      "Order-to-delivery workflow",
      "Route planning and dispatch",
      "Delivery status and customer accounts",
    ],
  },
  {
    name: "Scale",
    tag: "DISCUSS A BROADER ROLLOUT",
    text: "For more complex operations with specific rollout and access needs.",
    icon: Warehouse,
    items: [
      "Review multiple locations",
      "Discuss team and access requirements",
      "Plan imports and implementation",
    ],
  },
];

export interface DemoFormValues {
  name: string;
  email: string;
  company: string;
  notes: string;
}

/** Builds the `mailto:` draft the DemoForm hands off to the visitor's mail app. */
export function demoEmail(values: DemoFormValues): string {
  const body = `Hello RouteFlow,\n\nI'd like a demo for ${values.company}.\n\nName: ${values.name}\nWork email: ${values.email}\nCompany: ${values.company}\n\nWorkflow to discuss:\n${
    values.notes || "Orders, delivery routes, and customer accounts."
  }\n\nPlease get in touch to arrange a walkthrough.`;
  return `mailto:${site.email}?subject=${encodeURIComponent(
    "RouteFlow demo request — " + values.company,
  )}&body=${encodeURIComponent(body)}`;
}

// Single source of truth for marketing-site identity and per-route SEO
// metadata. One `routes` table drives the header/footer nav, the sitemap,
// and every route's <title>/description — never hand-mirror this shape
// elsewhere (lesson L-072: a hand-typed mirror is how bugs ship).
// Titles/descriptions are verbatim from the redesign's lib/site.ts
// (M1 §2 / marketing-inventory-redesign.md), except the two legal rows
// (privacy/terms), whose <title>/description match the published legal
// pages' own copy instead of the redesign's preview-only text.

import { Package, Route, Warehouse, type LucideIcon } from "lucide-react";
import { BRAND, SITE_BRAND } from "@routeflow/types/brand";

// Name, host and mailbox come from packages/types/brand/brand.json (the brand seam, T35): nothing
// in this file types them. `site` is the site's view (the overlay: the new name and the main host).
// Terms and Privacy are contracts and read BRAND (today's name and host), never this table.
export const site = {
  name: SITE_BRAND.name,
  origin: SITE_BRAND.origin,
  email: SITE_BRAND.email,
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
    label: "Product",
    title: "Product",
    description: `What ${site.name} does for businesses that sell to stores: orders, bills, payments, stock, delivery, and counter sales. 14 days free, no card needed.`,
  },
  {
    slug: "pricing",
    label: "Pricing",
    title: "Pricing",
    description: `${site.name} plans from $99 a month. Starter, Growth, Scale, and Enterprise. 14 days free, no card needed. Pay for a year and get 2 months free.`,
  },
  {
    slug: "company",
    label: "Company",
    title: "Company",
    description: `We make wholesalers’ lives easier. Why we built ${site.name}, and who to write to.`,
  },
  {
    slug: "contact",
    label: "Contact",
    title: "Contact",
    description: `Write to ${site.email} and we reply within one business day.`,
  },
  {
    slug: "privacy",
    label: "Privacy",
    title: "Privacy Policy",
    description: `How ${BRAND.name} collects, uses, and protects the information you share with us.`,
  },
  {
    slug: "terms",
    label: "Terms",
    title: "Terms of Service",
    description: `The terms that apply to accessing and using the ${BRAND.name} platform.`,
  },
];

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
    tag: "Get your workflow organized",
    text: "For a smaller team bringing customer orders into one place.",
    icon: Package,
    items: ["Customer and product records", "Order management", "Retailer ordering portal"],
  },
  {
    name: "Growth",
    tag: "Connect your delivery operation",
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
    tag: "Discuss a broader rollout",
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
  const body = `Hello ${site.name},\n\nI'd like a demo for ${values.company}.\n\nName: ${values.name}\nWork email: ${values.email}\nCompany: ${values.company}\n\nWorkflow to discuss:\n${
    values.notes || "Orders, delivery routes, and customer accounts."
  }\n\nPlease get in touch to arrange a walkthrough.`;
  return `mailto:${site.email}?subject=${encodeURIComponent(
    `${site.name} demo request — ` + values.company,
  )}&body=${encodeURIComponent(body)}`;
}

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { AudienceCards, CTA, Eyebrow } from "./components/marketing";
import { FeatureCatalog, CapabilityStrip } from "./components/feature-catalog";
import { FAQ } from "./components/faq";
import { DeliveryDemo } from "./components/delivery-demo";
import { AISpotlight } from "./components/ai-spotlight";
import {
  ProblemSection,
  DifferenceSection,
  BuyingConfidence,
} from "./components/conversion-sections";
import { DEMO_CTA, PLANS, site } from "./lib/site";

// Layout ruling (owner, 2026-09-16, PR-3): reference order is hero ->
// capability bar -> flow tabs -> platform grid -> audience cards (with
// photos) -> pricing teaser -> FAQ -> CTA, with AISpotlight kept but moved
// to right after the platform grid. "Flow tabs" is satisfied by the hero's
// own embedded DeliveryDemo/OperationStory — the reference's separate 5-tab
// widget has no other equivalent in production and OperationStory already
// fills that role where it already sits, so the hero itself is unchanged.
// ProblemSection/DifferenceSection/BuyingConfidence are kept in full (every
// factual claim intact) but repositioned to read as part of the platform-
// grid/FAQ narrative rather than as standalone blocks scattered elsewhere:
// ProblemSection leads into the platform grid (unchanged position),
// DifferenceSection follows it directly (its payoff), and BuyingConfidence
// leads into FAQ (unchanged position, relative to FAQ). A new pricing
// teaser (3 real plans, PLANS from lib/site.ts) is inserted between
// AudienceCards and BuyingConfidence.

// Copy verbatim from the redesign's app/page.tsx (M1 §1). This route is not
// in the `routes[]` table (it's the index, not a slug), so its metadata is
// hand-set here rather than looked up — matching the redesign's own root
// page, which also inherits the root layout title/description and only
// overrides `alternates.canonical` and `openGraph`.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    title: "Wholesale software for orders and delivery · RouteFlow",
    description: "Take orders, plan routes, and send invoices in one system.",
    url: "/",
    type: "website",
    siteName: site.name,
  },
};

export default function Home() {
  return (
    <div className="glass-page">
      <section className="glass-hero wrap">
        <div className="glass-hero-copy">
          <h1>Wholesale software for orders and delivery.</h1>
          <p>Take orders, plan routes, and send invoices in one system.</p>
          <div className="hero-actions">
            <Link className="button" href="/book-a-demo">
              {DEMO_CTA} <ArrowUpRight size={18} />
            </Link>
            <Link className="text-link" href="#how-it-works">
              See how it works <ArrowRight size={17} />
            </Link>
          </div>
        </div>
        <div className="glass-hero-art">
          <DeliveryDemo />
        </div>
      </section>
      <CapabilityStrip />
      <ProblemSection />
      <section className="section proof-tour wrap" id="how-it-works">
        <div className="section-heading split-heading">
          <div>
            <Eyebrow>How RouteFlow solves it</Eyebrow>
            <h2>
              From stock to invoice.
              <br />
              One connected operation.
            </h2>
          </div>
          <p>
            Inventory, orders, routes, accounts, and the tools around them. Explore the features
            your team can bring into one workflow.
          </p>
        </div>
        <FeatureCatalog />
      </section>
      <DifferenceSection />
      <AISpotlight />
      <div className="surface">
        <AudienceCards />
      </div>
      <section className="section wrap pricing-teaser">
        <div className="section-heading split-heading">
          <div>
            <Eyebrow>Pricing</Eyebrow>
            <h2>
              Discuss the plan
              <br />
              for your operation.
            </h2>
          </div>
          <p>
            RouteFlow currently provides pricing by quote. Review the features, limits, and setup
            support you need.
          </p>
        </div>
        <div className="pricing-teaser-grid">
          {PLANS.map((plan) => (
            <article key={plan.name} className="pricing-teaser-card">
              <plan.icon size={24} />
              <p className="card-eyebrow caps">{plan.tag}</p>
              <h3>{plan.name}</h3>
              <p>{plan.text}</p>
              <Link className="text-link" href="/pricing">
                Discuss {plan.name} <ArrowRight size={17} />
              </Link>
            </article>
          ))}
        </div>
        <Link className="text-link below-link" href="/pricing">
          Review pricing details <ArrowRight size={17} />
        </Link>
      </section>
      <BuyingConfidence />
      <FAQ />
      <CTA />
    </div>
  );
}

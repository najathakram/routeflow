import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
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
import { PLANS } from "./lib/site";
import { marketingMetadata } from "./lib/metadata";
import { StructuredData } from "./lib/structured-data";

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

// This route is not in the `routes[]` table (it's the index, not a slug), so its metadata is
// hand-set here rather than looked up. W8: the title keeps "distributors" for search (absolute,
// so the root "%s · RouteFlow" template doesn't repeat the name), the description is inherited
// from the root layout, and the share lines are the ones the page already carried.
export const metadata: Metadata = marketingMetadata({
  path: "/",
  title: { absolute: "RouteFlow: order and delivery software for wholesale distributors" },
  share: {
    title: "Turn scattered orders into organized deliveries · RouteFlow",
    description:
      "Connect wholesale orders, route planning, delivery confirmation, and customer accounts.",
  },
});

export default function Home() {
  return (
    <div className="glass-page">
      <StructuredData />
      <section className="glass-hero wrap">
        <div className="glass-hero-copy">
          <Eyebrow>Wholesale order & delivery software</Eyebrow>
          <h1>
            Turn scattered orders <br />
            into{" "}
            <em>
              organized <br />
              deliveries.
            </em>
          </h1>
          <p>
            When orders live in messages and drivers work from separate lists, your team spends the
            day chasing details. Bring inventory, orders, delivery, and customer accounts together
            with RouteFlow.
          </p>
          <div className="hero-actions">
            <Link className="button" href="/book-a-demo">
              Book a workflow demo <ArrowUpRight size={18} />
            </Link>
            <Link className="text-link" href="#how-it-works">
              See how it works <ArrowRight size={17} />
            </Link>
          </div>
          <p className="hero-assurance">
            <Check size={15} /> For distributors and the retailers they serve
          </p>
          <Link className="hero-ai-link" href="#ai-heading">
            AI invoice scanning. Inventory and costing, simplified. <ArrowRight size={14} />
          </Link>
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

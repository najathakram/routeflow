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
import { site } from "./lib/site";

// Copy verbatim from the redesign's app/page.tsx (M1 §1). This route is not
// in the `routes[]` table (it's the index, not a slug), so its metadata is
// hand-set here rather than looked up — matching the redesign's own root
// page, which also inherits the root layout title/description and only
// overrides `alternates.canonical` and `openGraph`.
export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    title: "RouteFlow | Turn scattered orders into organized deliveries",
    description:
      "Connect wholesale orders, route planning, delivery confirmation, and customer accounts.",
    url: "/",
    type: "website",
    siteName: site.name,
  },
};

export default function Home() {
  return (
    <>
      <section className="glass-hero wrap">
        <div className="glass-hero-copy">
          <Eyebrow>WHOLESALE ORDER & DELIVERY SOFTWARE</Eyebrow>
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
      <AISpotlight />
      <section className="section proof-tour wrap" id="how-it-works">
        <div className="section-heading split-heading">
          <div>
            <Eyebrow>HOW ROUTEFLOW SOLVES IT</Eyebrow>
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
      <div className="surface">
        <AudienceCards />
      </div>
      <BuyingConfidence />
      <FAQ />
      <CTA />
    </>
  );
}

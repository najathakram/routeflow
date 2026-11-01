import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { DEMO_CTA, routes } from "../lib/site";
import { marketingMetadata } from "../lib/metadata";
import { CTA, Eyebrow } from "../components/marketing";
import { OrderLifecycle, WholesalerCapabilities } from "../components/order-lifecycle";
import { WorkflowTour } from "../components/workflow-tour";
import { DeliveryDemo } from "../components/delivery-demo";
import { FAQ } from "../components/faq";

// Copy verbatim from the redesign's app/[page]/page.tsx `Wholesalers()` (M1 §2b).

const route = routes.find((r) => r.slug === "wholesalers")!;

export const metadata: Metadata = marketingMetadata({
  path: "/wholesalers",
  title: route.title,
  description: route.description,
});

export default function WholesalersPage() {
  return (
    <div className="glass-page">
      <section className="distributor-hero">
        <div className="wrap split-hero">
          <div>
            <Eyebrow>For wholesalers & distributors</Eyebrow>
            <h1>
              One order, priced right, <br />
              on the right <em>truck, invoiced automatically.</em>
            </h1>
            <p className="lead">
              RouteFlow runs your order lifecycle in one system, so nothing gets re-typed,
              re-priced, or re-checked by hand between the phone call and the invoice.
            </p>
            <div className="hero-actions">
              <Link href="/book-a-demo" className="button button-lime">
                {DEMO_CTA} <ArrowUpRight size={18} />
              </Link>
            </div>
            <p className="hero-note">Orders, routes, and customer accounts in one workspace.</p>
          </div>
          <DeliveryDemo compact />
        </div>
      </section>
      <OrderLifecycle />
      <section className="section wrap">
        <div className="section-heading split-heading">
          <div>
            <Eyebrow>The part spreadsheets get wrong</Eyebrow>
            <h2>
              Pricing and payment,
              <br />
              handled the way you actually work.
            </h2>
          </div>
          <p>
            Boxed pricing, customer-tier rates, standing orders, and driver settlement — the details
            that make or lose money on a wholesale order.
          </p>
        </div>
        <WholesalerCapabilities />
      </section>
      <section className="section surface">
        <div className="wrap">
          <div className="section-heading">
            <Eyebrow>See your workflow in RouteFlow</Eyebrow>
            <h2>
              Follow an order
              <br />
              through the day.
            </h2>
          </div>
          <WorkflowTour />
        </div>
      </section>
      <FAQ />
      <CTA />
    </div>
  );
}

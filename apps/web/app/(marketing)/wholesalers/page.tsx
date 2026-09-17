import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { routes, site } from "../lib/site";
import { CTA, Eyebrow } from "../components/marketing";
import { FeatureCatalog } from "../components/feature-catalog";
import { WorkflowTour } from "../components/workflow-tour";
import { DeliveryDemo } from "../components/delivery-demo";

// Copy verbatim from the redesign's app/[page]/page.tsx `Wholesalers()` (M1 §2b).

const route = routes.find((r) => r.slug === "wholesalers")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/wholesalers" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/wholesalers",
    siteName: site.name,
    type: "website",
  },
};

const GETTING_STARTED: Array<[string, string]> = [
  [
    "Bring your current workflow",
    "Show how you take orders, plan routes, and answer customer questions.",
  ],
  [
    "Walk through the key handoffs",
    "Ask to see the points where your office, warehouse, and drivers share information.",
  ],
  [
    "Agree on the fit",
    "Confirm the plan, limits, import requirements, and available features before you commit.",
  ],
];

export default function WholesalersPage() {
  return (
    <div className="glass-page">
      <section className="distributor-hero">
        <div className="wrap split-hero">
          <div>
            <Eyebrow>FOR WHOLESALERS & DISTRIBUTORS</Eyebrow>
            <h1>
              Get your team out of <br />
              the daily <em>delivery scramble.</em>
            </h1>
            <p className="lead">
              Scattered order messages and separate driver lists create extra handoffs. Keep orders,
              dispatch, delivery records, and customer accounts in one place.
            </p>
            <div className="hero-actions">
              <Link href="/book-a-demo" className="button button-lime">
                Book a distributor demo <ArrowUpRight size={18} />
              </Link>
            </div>
            <p className="hero-note">Orders, routes, and customer accounts in one workspace.</p>
          </div>
          <DeliveryDemo compact />
        </div>
      </section>
      <section className="section wrap">
        <div className="section-heading split-heading">
          <div>
            <Eyebrow>LESS CHASING, MORE CONTEXT</Eyebrow>
            <h2>
              Keep the details
              <br />
              with the job.
            </h2>
          </div>
          <p>
            Your team should be able to answer a customer’s question without retracing the entire
            order.
          </p>
        </div>
        <FeatureCatalog />
      </section>
      <section className="section surface">
        <div className="wrap">
          <div className="section-heading">
            <Eyebrow>SEE YOUR WORKFLOW IN ROUTEFLOW</Eyebrow>
            <h2>
              Follow an order
              <br />
              through the day.
            </h2>
          </div>
          <WorkflowTour />
        </div>
      </section>
      <section className="section wrap getting-started">
        <div>
          <Eyebrow>START WITH YOUR OPERATION</Eyebrow>
          <h2>
            Make the demo
            <br />
            useful to your team.
          </h2>
        </div>
        <ol>
          {GETTING_STARTED.map(([title, text], i) => (
            <li key={title}>
              <span>0{i + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <CTA />
    </div>
  );
}

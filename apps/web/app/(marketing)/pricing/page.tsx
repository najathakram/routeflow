import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Package, Route, Store, Warehouse } from "lucide-react";
import { routes, site } from "../lib/site";
import { CTA, Eyebrow, CheckList } from "../components/marketing";

// Copy verbatim from the redesign's app/[page]/page.tsx `Pricing()` (M1 §2d).
// No numeric prices — deliberately deferred to a sales conversation.

const route = routes.find((r) => r.slug === "pricing")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/pricing",
    siteName: site.name,
    type: "website",
  },
};

const PLANS = [
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

export default function PricingPage() {
  return (
    <div className="glass-page">
      <section className="page-hero centered wrap">
        <Eyebrow>ROUTEFLOW PRICING</Eyebrow>
        <h1>
          A plan that fits <br />
          <em>your working day.</em>
        </h1>
        <p className="lead">
          Tell us about your order volume, team, and delivery routes. We’ll help you review the
          right fit.
        </p>
      </section>
      <section className="pricing-section wrap">
        <div className="pricing-note">
          <span className="pulse-dot" /> Start with your order volume, delivery routes, and team.
          Review the plan and limits that fit your operation.
        </div>
        <div className="pricing-grid">
          {PLANS.map((p, i) => (
            <article className={"pricing-card " + (i === 1 ? "featured" : "")} key={p.name}>
              {i === 1 && <span className="plan-ribbon">FOR GROWING DELIVERY TEAMS</span>}
              <p className="card-eyebrow">{p.tag}</p>
              <div className="plan-name">
                <h2>{p.name}</h2>
                <p.icon size={26} />
              </div>
              <p className="plan-description">{p.text}</p>
              <div className="plan-price">
                Let’s find your fit
                <span>Confirm pricing and limits in a conversation.</span>
              </div>
              <Link className={"button " + (i !== 1 ? "button-outline" : "")} href="/book-a-demo">
                Discuss {p.name} <ArrowUpRight size={17} />
              </Link>
              <h3>Topics for your walkthrough</h3>
              <CheckList items={p.items} />
            </article>
          ))}
        </div>
        <p className="pricing-footnote">
          Your quote should confirm included features, usage limits, and billing terms before you
          commit.
        </p>
      </section>
      <section className="retailer-price wrap">
        <Store size={30} />
        <div>
          <h2>Ordering as a retailer?</h2>
          <p>Use the retailer portal to order from your connected distributors.</p>
        </div>
        <Link className="text-link" href="/retailers">
          Explore the retailer portal <ArrowRight size={18} />
        </Link>
      </section>
      <section className="section wrap plan-check">
        <div>
          <Eyebrow>BEFORE YOU CHOOSE</Eyebrow>
          <h2>
            Get the details
            <br />
            up front.
          </h2>
        </div>
        <div>
          <CheckList
            items={[
              "Included users, customers, orders, and warehouses",
              "Delivery and driver features included in your plan",
              "Billing period, any usage charges, and cancellation terms",
              "Data imports, setup support, and native-app availability",
            ]}
          />
          <p>
            Ask for a written summary so you can compare the plan against your day-to-day needs.
          </p>
        </div>
      </section>
      <CTA />
    </div>
  );
}

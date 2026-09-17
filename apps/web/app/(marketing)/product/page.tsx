import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Route, Users, Warehouse, Store } from "lucide-react";
import { routes, site } from "../lib/site";
import { CTA, Eyebrow, CheckList } from "../components/marketing";
import { FAQ } from "../components/faq";
import { DeliveryDemo } from "../components/delivery-demo";
import { FeatureCatalog, CapabilityStrip } from "../components/feature-catalog";
import { AISpotlight } from "../components/ai-spotlight";
import { BrandSignature } from "@/components/brand";
import { DifferenceSection, BuyingConfidence } from "../components/conversion-sections";

// Copy verbatim from the redesign's app/[page]/page.tsx `Product()` (M1 §2a).

const route = routes.find((r) => r.slug === "product")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/product" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/product",
    siteName: site.name,
    type: "website",
  },
};

const CONNECTION_NODES: Array<[typeof Users, string]> = [
  [Users, "Office"],
  [Warehouse, "Warehouse"],
  [Route, "Drivers"],
  [Store, "Retailers"],
];

export default function ProductPage() {
  return (
    <div className="glass-page">
      <section className="page-hero centered wrap">
        <Eyebrow>CONNECTED OPERATIONS. AI INVOICE SCANNING.</Eyebrow>
        <h1>
          Orders. Deliveries. Accounts. <br />
          <em>Finally, connected.</em>
        </h1>
        <p className="lead">
          Inventory, orders, routes, invoices, accounts, and reporting. Bring the work into one
          platform, with a retailer portal, AI-assisted purchase-invoice scanning for inventory and
          costing, and dedicated tools for regulated goods.
        </p>
        <Link href="/book-a-demo" className="button">
          Book a workflow demo <ArrowUpRight size={18} />
        </Link>
      </section>
      <section className="platform-live-story wrap">
        <DeliveryDemo />
      </section>
      <CapabilityStrip />
      <AISpotlight />
      <section className="section surface">
        <div className="wrap">
          <div className="section-heading">
            <Eyebrow>THE FEATURES BEHIND THE FLOW</Eyebrow>
            <h2>
              Every part of the operation.
              <br />
              More of it connected.
            </h2>
          </div>
          <FeatureCatalog />
        </div>
      </section>
      <section className="section wrap connected-section">
        <div>
          <Eyebrow>KEEP YOUR TEAM CONNECTED</Eyebrow>
          <h2>
            Shared context.
            <br />
            Clearer handoffs.
          </h2>
          <p className="lead">
            Your office, warehouse, and drivers work on different parts of the day. Help them work
            from the same order and customer details.
          </p>
          <CheckList
            items={[
              "Find the record behind a customer question",
              "Follow an order from preparation through delivery",
            ]}
          />
        </div>
        <div
          className="connection-diagram"
          aria-label="Distributor workspace connects office, warehouse, drivers, and retailers"
        >
          <div className="connection-center">
            <BrandSignature />
            <span>Your distribution workspace</span>
          </div>
          <div className="connection-nodes">
            {CONNECTION_NODES.map(([Icon, label]) => (
              <div key={label}>
                <Icon size={22} />
                <span>{label}</span>
              </div>
            ))}
          </div>
          <p>Orders · Delivery details · Customer records</p>
        </div>
      </section>
      <DifferenceSection />
      <BuyingConfidence />
      <FAQ />
      <CTA />
    </div>
  );
}

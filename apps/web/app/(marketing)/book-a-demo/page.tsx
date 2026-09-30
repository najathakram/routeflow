import type { Metadata } from "next";
import { FileText, Route, Users } from "lucide-react";
import { site } from "../lib/site";
import { DemoScheduler } from "../components/demo-scheduler";

// The real booking page — replaces the design study's simulated calendar
// (business.js's hard-coded September 2026 grid) with DemoScheduler, which
// reads live availability from the RouteFlow API (backed by Google Calendar)
// and creates a real booking. Glass design system (glass.css/glass-pages.css)
// ported from the 2026-09-16 Codex study; layout follows its `.booking-layout`
// two-column split (`booking-copy` / `.glass.booking-panel`).

export const metadata: Metadata = {
  title: "Book a RouteFlow demo",
  description: "See how RouteFlow fits your operation — choose a time for a product walkthrough.",
  alternates: { canonical: "/book-a-demo" },
  openGraph: {
    title: "Book a RouteFlow demo",
    description: "Choose a time for a product walkthrough.",
    url: "/book-a-demo",
    siteName: site.name,
    type: "website",
  },
};

const AGENDA: Array<[typeof Route, string, string]> = [
  [
    FileText,
    "Review your current process",
    "How you manage stock, orders, deliveries, and accounts.",
  ],
  [Route, "Walk through RouteFlow", "See the tools relevant to your team and ask questions."],
  [Users, "Discuss pricing and setup", "Review requirements, imports, and the next steps."],
];

export default function BookADemoPage() {
  return (
    <section className="glass-page g-section">
      <div className="g-wrap booking-layout">
        <div className="glass booking-copy">
          <span className="g-eyebrow">BOOK A ROUTEFLOW DEMO</span>
          <h1>
            See how RouteFlow fits
            <br />
            your operation.
          </h1>
          <p>
            Review the features your team needs and discuss pricing and setup. Bring an example of
            an order, from intake through delivery and payment.
          </p>
          <ul className="agenda-list">
            {AGENDA.map(([Icon, title, text]) => (
              <li key={title}>
                <Icon aria-hidden="true" />
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ul>
          <figure className="photo">
            {/* Plain <img>, not next/image (ruling B1, matching company/page.tsx). */}
            {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
            <img
              src="/marketing/warehouse.webp"
              alt="Two warehouse workers carrying stock through an aisle."
              width={1400}
              height={933}
              loading="lazy"
              decoding="async"
            />
          </figure>
        </div>

        <DemoScheduler />
      </div>
    </section>
  );
}

import type { Metadata } from "next";
import { FileText, Route, Users } from "lucide-react";
import { DEMO_CTA } from "../lib/site";
import { marketingMetadata } from "../lib/metadata";
import { DemoScheduler } from "../components/demo-scheduler";

// The real booking page — replaces the design study's simulated calendar
// (business.js's hard-coded September 2026 grid) with DemoScheduler, which
// reads live availability from the RouteFlow API (backed by Google Calendar)
// and creates a real booking. Glass design system (glass.css/glass-pages.css)
// ported from the 2026-09-16 Codex study; layout follows its `.booking-layout`
// two-column split (`booking-copy` / `.glass.booking-panel`).

export const metadata: Metadata = marketingMetadata({
  path: "/book-a-demo",
  title: DEMO_CTA,
  description: "Pick a time for a video call with the RouteFlow team.",
  share: { description: "Pick a time for a video call with the RouteFlow team." },
});

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
          <span className="g-eyebrow caps">{DEMO_CTA}</span>
          <h1>See RouteFlow with your own orders.</h1>
          <p>It’s a 30-minute video call. We show you RouteFlow and you ask questions.</p>
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

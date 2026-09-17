import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, MessageSquare, Route, Users } from "lucide-react";
import { routes, site } from "../lib/site";
import { Eyebrow } from "../components/marketing";

// Copy verbatim from the redesign's app/[page]/page.tsx `Contact()` (M1 §2f).
// Inside the marketing chrome; the old `app/contact/page.tsx` is deleted
// (spec.md R8).
//
// Layout ruling (owner, 2026-09-16, PR-3): retire the email-draft DemoForm —
// the PR-2 booking page (real Google-Calendar availability) replaces it.
// Two cards instead, matching the reference study's contact() exactly:
// "Product demos & pricing" links to /book-a-demo, "General enquiries" is a
// mailto. `direct-contact` (the old "Prefer to email?" link) is dropped as
// now-duplicative of the General Enquiries card. `demo-agenda` is kept —
// unique, useful content the reference page never had, no reason to drop it.
// components/demo-form.tsx is left in place, unused — not deleted, since
// nothing here asked for that; flagged separately as a dead-code candidate.

const route = routes.find((r) => r.slug === "contact")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/contact" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/contact",
    siteName: site.name,
    type: "website",
  },
};

const AGENDA: Array<[typeof Route, string, string]> = [
  [
    MessageSquare,
    "Start with your process",
    "The orders, handoffs, and customer questions you handle.",
  ],
  [Route, "See the connected workflow", "From order intake through dispatch and delivery."],
  [
    CalendarDays,
    "Discuss the next step",
    "Review pricing, setup, and the details you need to decide.",
  ],
];

export default function ContactPage() {
  return (
    <div className="glass-page">
      <section className="contact-section wrap">
        <div className="contact-copy">
          <Eyebrow>SEE ROUTEFLOW IN ACTION</Eyebrow>
          <h1>
            Let’s talk about <br />
            <em>your delivery day.</em>
          </h1>
          <p className="lead">
            Bring your workflow and your questions. Explore how RouteFlow could fit the way your
            team takes orders and runs deliveries.
          </p>
          <div className="demo-agenda">
            <h2>Make the walkthrough yours.</h2>
            {AGENDA.map(([Icon, title, text]) => (
              <div key={title}>
                <Icon size={23} />
                <span>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="contact-grid">
          <article className="contact-card">
            <span className="g-tile">
              <CalendarDays size={22} />
            </span>
            <h2>Product demos &amp; pricing</h2>
            <p>
              Review your orders, delivery process, and customer accounts. Ask about features,
              setup, and the price for your operation.
            </p>
            <Link className="button" href="/book-a-demo">
              Book a demo <ArrowUpRight size={18} />
            </Link>
          </article>
          <article className="contact-card">
            <span className="g-tile">
              <Users size={22} />
            </span>
            <h2>General enquiries</h2>
            <p>
              For product questions, account help, or partnership enquiries, email the RouteFlow
              team. Include your company and a short description of what you need.
            </p>
            <a className="button button-outline" href={`mailto:${site.email}`}>
              {site.email} <ArrowUpRight size={18} />
            </a>
          </article>
        </div>
      </section>
    </div>
  );
}

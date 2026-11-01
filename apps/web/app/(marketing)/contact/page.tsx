import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, MessageSquare, Route, Users } from "lucide-react";
import { DEMO_CTA, routes, site } from "../lib/site";
import { marketingMetadata } from "../lib/metadata";
import { Eyebrow } from "../components/marketing";

// Words: COPY.md 2j (W6). Email stays the way in (Q4): no phone, hours or street address. The one
// promise is the reply time the owner set (SA-1075 A-5): "We reply within one business day."
// Inside the marketing chrome; the old `app/contact/page.tsx` is deleted
// (spec.md R8).
//
// Layout ruling (owner, 2026-09-16, PR-3): retire the email-draft DemoForm —
// the PR-2 booking page (real Google-Calendar availability) replaces it.
// Two cards instead, matching the reference study's contact() exactly:
// "Product demos & pricing" links to /book-a-demo, "General inquiries" is a
// mailto. `direct-contact` (the old "Prefer to email?" link) is dropped as
// now-duplicative of the General Enquiries card. `demo-agenda` is kept —
// unique, useful content the reference page never had, no reason to drop it.
// components/demo-form.tsx is left in place, unused — not deleted, since
// nothing here asked for that; flagged separately as a dead-code candidate.

const route = routes.find((r) => r.slug === "contact")!;

export const metadata: Metadata = marketingMetadata({
  path: "/contact",
  title: route.title,
  description: route.description,
});

const AGENDA: Array<[typeof Route, string, string]> = [
  [
    MessageSquare,
    "Show us your orders",
    "How orders, deliveries, and customer questions work today.",
  ],
  [Route, "See RouteFlow", "From the order to the delivery."],
  [CalendarDays, "Talk about next steps", "Ask about price and setup."],
];

export default function ContactPage() {
  return (
    <div className="glass-page">
      <section className="contact-section wrap">
        <div className="contact-copy">
          <Eyebrow>Contact RouteFlow</Eyebrow>
          <h1>
            Email us or <br />
            <em>book a video call.</em>
          </h1>
          <p className="lead">
            Email a question and include your company name. We reply within one business day.
          </p>
          <div className="demo-agenda">
            <h2>What we do on the call.</h2>
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
            <h2>Book a video call</h2>
            <p>Look at your orders, deliveries, and customers. Ask about features and setup.</p>
            <Link className="button" href="/book-a-demo">
              {DEMO_CTA} <ArrowUpRight size={18} />
            </Link>
          </article>
          <article className="contact-card">
            <span className="g-tile">
              <Users size={22} />
            </span>
            <h2>Other questions</h2>
            <p>Email us about your account or anything else. Include your company name.</p>
            <a className="button button-outline" href={`mailto:${site.email}`}>
              {site.email} <ArrowUpRight size={18} />
            </a>
          </article>
        </div>
      </section>
    </div>
  );
}

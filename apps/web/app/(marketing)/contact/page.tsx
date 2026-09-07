import type { Metadata } from "next";
import { ArrowUpRight, CalendarDays, MessageSquare, Route } from "lucide-react";
import { routes, site } from "../lib/site";
import { Eyebrow } from "../components/marketing";
import { DemoForm } from "../components/demo-form";

// Copy verbatim from the redesign's app/[page]/page.tsx `Contact()` (M1 §2f).
// Inside the marketing chrome; the old `app/contact/page.tsx` is deleted
// (spec.md R8).

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
    <section className="contact-section wrap">
      <div className="contact-copy">
        <Eyebrow>SEE ROUTEFLOW IN ACTION</Eyebrow>
        <h1>
          Let’s talk about <br />
          <em>your delivery day.</em>
        </h1>
        <p className="lead">
          Bring your workflow and your questions. Explore how RouteFlow could fit the way your team
          takes orders and runs deliveries.
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
        <div className="direct-contact">
          <span>Prefer to email?</span>
          <a href={`mailto:${site.email}`}>
            {site.email} <ArrowUpRight size={17} />
          </a>
        </div>
      </div>
      <DemoForm />
    </section>
  );
}

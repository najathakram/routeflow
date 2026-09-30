import type { Metadata } from "next";
import {
  ArrowUpRight,
  BookOpen,
  Link2,
  Mail,
  Target,
  MessageCircle,
  Rocket,
  Users2,
} from "lucide-react";
import { routes, site } from "../lib/site";
import { CTA, Eyebrow, CheckList } from "../components/marketing";

// Copy verbatim from the redesign's app/[page]/page.tsx `Company()` (M1 §2e).
//
// Layout ruling (owner, 2026-09-16, PR-3): combine the hero text and photo
// into one section (matching the design study's `company()` — a single
// `.audience-hero` with text + photo side by side, not two stacked
// sections), and use a 3-card grid instead of the numbered PRINCIPLES list.
// The three principles' own copy is unchanged — this only changes their
// layout shape, not their content, so no factual claim is lost.

const route = routes.find((r) => r.slug === "company")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/company" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/company",
    siteName: site.name,
    type: "website",
  },
};

const PRINCIPLES: Array<[typeof BookOpen, string, string]> = [
  [
    BookOpen,
    "Useful context",
    "Keep order details, delivery notes, and customer history within reach of the people doing the job.",
  ],
  [
    Link2,
    "Connected handoffs",
    "Help the office, warehouse, and driver follow the same order through its next step.",
  ],
  [
    Target,
    "Clear expectations",
    "Start a buying conversation with the workflow, the available features, and the scope of the plan.",
  ],
];

const HOW_WE_BUILD: Array<[typeof MessageCircle, string, string]> = [
  [
    MessageCircle,
    "Direct access",
    "We talk to the businesses using RouteFlow directly — no support queue that disappears into a ticket system.",
  ],
  [
    Rocket,
    "Ships fast",
    "We fix what's wrong in days, not quarters, because the team that hears about a problem is the team that can change the code.",
  ],
  [
    Users2,
    "Small by design",
    "We're a small team on purpose — it's what makes the first two true.",
  ],
];

export default function CompanyPage() {
  return (
    <div className="glass-page">
      <section className="company-intro wrap split-hero">
        <div>
          <Eyebrow>ABOUT ROUTEFLOW</Eyebrow>
          <h1>
            For the people who <br />
            keep local shelves <br />
            <em>stocked.</em>
          </h1>
          <p className="lead">
            Behind a stocked shelf, someone took an order, checked a product, loaded a van, and made
            the delivery.
          </p>
          <p>
            RouteFlow focuses on that everyday work. We bring ordering, delivery operations, and
            customer records into a connected workspace for distributors and the retailers they
            serve.
          </p>
        </div>
        <figure className="company-photo">
          {/* Plain <img>, not next/image (ruling B1); below the fold, so lazy. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
          <img
            src="/marketing/warehouse.webp"
            alt="Two warehouse workers carrying stock through an aisle."
            width={1400}
            height={933}
            loading="lazy"
            decoding="async"
          />
          <figcaption>
            <span>THE WORK BEHIND THE DELIVERY</span>
            <p>
              Stock to move.
              <br />
              Customers to look after.
            </p>
          </figcaption>
        </figure>
      </section>
      <p className="photo-credit wrap">
        Illustrative industry photography.{" "}
        <a
          href="https://www.pexels.com/photo/men-working-in-a-warehouse-4487362/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Tiger Lily / Pexels
        </a>
        .
      </p>
      <section className="section wrap company-principles">
        <div>
          <Eyebrow>OUR PRODUCT FOCUS</Eyebrow>
          <h2>
            Keep it close
            <br />
            to the work.
          </h2>
        </div>
        <div className="feature-grid three">
          {PRINCIPLES.map(([Icon, title, text]) => (
            <article key={title}>
              <Icon size={26} />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="section wrap company-principles">
        <div>
          <Eyebrow>HOW WE BUILD</Eyebrow>
          <h2>
            Small, direct,
            <br />
            and fast.
          </h2>
        </div>
        <div className="feature-grid three">
          {HOW_WE_BUILD.map(([Icon, title, text]) => (
            <article key={title}>
              <Icon size={26} />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="section wrap">
        <div>
          <Eyebrow>THE FACTS</Eyebrow>
          <h2>
            Who’s actually
            <br />
            behind this.
          </h2>
        </div>
        <CheckList
          items={[
            "Founded 2026",
            "Legal entity: Routeflow Solutions LLC, registered in Wyoming",
            "Offices in Stafford, TX",
          ]}
        />
      </section>
      <section className="section wrap">
        <div>
          <Eyebrow>DATA & SECURITY</Eyebrow>
          <h2>
            Your data
            <br />
            stays yours.
          </h2>
          <p>
            Your orders, pricing, and customer data belong to you. RouteFlow keeps every business’s
            data isolated from every other tenant on the platform, and we don’t sell or share it.
            Full detail is in our{" "}
            <a className="text-link" href="/privacy">
              Privacy Policy
            </a>{" "}
            and{" "}
            <a className="text-link" href="/terms">
              Terms of Service
            </a>
            .
          </p>
        </div>
      </section>
      <section className="company-contact wrap">
        <Mail size={27} />
        <div>
          <h2>Tell us about your delivery day.</h2>
          <p>Start with the part that takes more time or coordination than it should.</p>
        </div>
        <a className="text-link" href={`mailto:${site.email}`}>
          {site.email}
          <ArrowUpRight size={17} />
        </a>
      </section>
      <CTA />
    </div>
  );
}

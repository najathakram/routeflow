import type { Metadata } from "next";
import { ArrowUpRight, Mail } from "lucide-react";
import { routes, site } from "../lib/site";
import { CTA, Eyebrow } from "../components/marketing";

// Copy verbatim from the redesign's app/[page]/page.tsx `Company()` (M1 §2e).

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

const PRINCIPLES: Array<[string, string]> = [
  [
    "Useful context",
    "Keep order details, delivery notes, and customer history within reach of the people doing the job.",
  ],
  [
    "Connected handoffs",
    "Help the office, warehouse, and driver follow the same order through its next step.",
  ],
  [
    "Clear expectations",
    "Start a buying conversation with the workflow, the available features, and the scope of the plan.",
  ],
];

export default function CompanyPage() {
  return (
    <div className="glass-page">
      <section className="page-hero company-intro wrap">
        <Eyebrow>ABOUT ROUTEFLOW</Eyebrow>
        <h1>
          For the people who <br />
          keep local shelves <br />
          <em>stocked.</em>
        </h1>
        <div>
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
      </section>
      <section className="company-image wrap">
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
        <div>
          <span>THE WORK BEHIND THE DELIVERY</span>
          <p>
            Stock to move.
            <br />
            Customers to look after.
          </p>
        </div>
        <p className="photo-credit">
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
      </section>
      <section className="section wrap company-principles">
        <div>
          <Eyebrow>OUR PRODUCT FOCUS</Eyebrow>
          <h2>
            Keep it close
            <br />
            to the work.
          </h2>
        </div>
        <div>
          {PRINCIPLES.map(([title, text], i) => (
            <article key={title}>
              <span>0{i + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </article>
          ))}
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

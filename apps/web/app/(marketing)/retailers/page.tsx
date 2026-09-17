import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Globe, Package, FileText, ShoppingBag } from "lucide-react";
import { routes, site } from "../lib/site";
import { CTA, Eyebrow } from "../components/marketing";
import { FAQ } from "../components/faq";
import { RetailerArt, RetailerDetail } from "../components/technology-art";
import { authLinks } from "../components/auth-links";

// Copy verbatim from the redesign's app/[page]/page.tsx `Retailers()` (M1 §2c).

const route = routes.find((r) => r.slug === "retailers")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/retailers" },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/retailers",
    siteName: site.name,
    type: "website",
  },
};

const BENEFITS: Array<[typeof Package, string, string]> = [
  [
    ShoppingBag,
    "Browse your suppliers",
    "Find the catalogs and prices available through your supplier connections.",
  ],
  [
    Package,
    "Put your order together",
    "Select the products you need and review the order before placing it.",
  ],
  [
    FileText,
    "Find your order history",
    "Look back at previous purchases when you plan your next restock.",
  ],
];

export default function RetailersPage() {
  return (
    <div className="retailer-page glass-page">
      <section className="retailer-hero">
        <div className="wrap split-hero">
          <div>
            <Eyebrow>FOR RETAILERS</Eyebrow>
            <h1>
              Restock your shelves. <br />
              <em>
                Skip the back <br />
                and forth.
              </em>
            </h1>
            <p className="lead">
              Browse your connected suppliers, place orders, and find your purchase history in one
              retailer portal.
            </p>
            <div className="hero-actions">
              <Link className="button button-green" href={authLinks.retailerSignUp}>
                Create a retailer account <ArrowUpRight size={18} />
              </Link>
            </div>
            <p className="hero-note">
              <Globe size={16} /> Use the web portal. No app download required.
            </p>
            <Link className="retailer-login text-link" href={authLinks.retailerSignIn}>
              Already have an account? Sign in <ArrowRight size={16} />
            </Link>
          </div>
          <RetailerArt />
        </div>
      </section>
      <section className="section wrap">
        <div className="section-heading">
          <Eyebrow>YOUR SUPPLIERS, WITHIN REACH</Eyebrow>
          <h2>
            Order with the details
            <br />
            in front of you.
          </h2>
        </div>
        <div className="benefit-grid">
          {BENEFITS.map(([Icon, title, text]) => (
            <article key={title}>
              <Icon size={28} />
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="retailer-start wrap">
        <div>
          <Eyebrow>BEFORE YOUR FIRST ORDER</Eyebrow>
          <h2>
            Connect with
            <br />
            your distributor.
          </h2>
          <p>
            Your supplier connection determines the catalogs, pricing, and ordering options
            available to you. Ask your distributor how to get connected.
          </p>
        </div>
        <ol>
          <li>
            <span>01</span>
            <div>
              <h3>Create your retailer account</h3>
              <p>Use the retailer registration page.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <h3>Connect to your supplier</h3>
              <p>Follow your distributor’s connection instructions.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <h3>Place your first order</h3>
              <p>Browse the available catalog and review your items.</p>
            </div>
          </li>
        </ol>
      </section>
      <RetailerDetail />
      <FAQ retail />
      <CTA retailer />
    </div>
  );
}

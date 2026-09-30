import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Globe,
  Package,
  ShoppingBag,
  Users,
  ReceiptText,
  MapPin,
  CreditCard,
} from "lucide-react";
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
    Users,
    "One login, every supplier",
    "Order from every distributor you buy from on RouteFlow with a single account — switch between sellers from the same portal.",
  ],
  [
    Package,
    "Put your order together",
    "Select the products you need and review the order before placing it.",
  ],
  [ReceiptText, "See what you owe", "Every invoice, itemized against exactly what was delivered."],
  [
    MapPin,
    "Track your delivery",
    "Know your order's status, driver, and how many stops are ahead, plus your scheduled delivery window.",
  ],
  [
    CreditCard,
    "Pay your way",
    "Pay by card right in the portal when your seller has that turned on, or settle up with them directly the way you always have.",
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
              Order from every supplier you buy from with one login, see what you owe, and track
              your deliveries — without a single call to their order desk.
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
        {/* Plain <img>, not next/image (ruling B1, matching warehouse.webp usage
            elsewhere in the marketing port); below the fold, so lazy. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
        <img
          src="/marketing/invoice-detail.webp"
          alt="RouteFlow buyer-portal invoice detail showing itemized line items, balance due, and a Pay this invoice card-payment button."
          width={1400}
          height={933}
          loading="lazy"
          decoding="async"
          className="invoice-screenshot"
        />
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

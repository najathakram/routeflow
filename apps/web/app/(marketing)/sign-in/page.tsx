import type { Metadata } from "next";
import { ArrowRight, Package, Store } from "lucide-react";
import { site } from "../lib/site";
import { authLinks } from "../components/auth-links";

// The account chooser (glass design, 2026-09-16 Codex study). Both buttons
// route straight to the existing, unchanged sign-in pages — this page
// collects no credentials itself, matching the study's own disclosure.

export const metadata: Metadata = {
  title: "Sign in to RouteFlow",
  description: "Choose the RouteFlow account you use for your business.",
  alternates: { canonical: "/sign-in" },
  openGraph: {
    title: "Sign in to RouteFlow",
    description: "Choose the RouteFlow account you use for your business.",
    url: "/sign-in",
    siteName: site.name,
    type: "website",
  },
};

export default function SignInPage() {
  return (
    <div className="glass-page">
      <section className="g-wrap glass page-intro">
        <span className="g-eyebrow">SIGN IN TO ROUTEFLOW</span>
        <h1>Choose your account.</h1>
        <p>
          Wholesalers and retailers use separate sign-in pages. Select the account you use for your
          business.
        </p>
      </section>

      <section className="g-wrap g-section signin-grid">
        <article className="glass login-choice">
          <span className="g-tile">
            <Package aria-hidden="true" />
          </span>
          <h2>Wholesaler or distributor</h2>
          <p>
            For your operations team managing products, orders, deliveries, and customer accounts.
          </p>
          <a className="g-btn g-btn-primary g-btn-block" href={authLinks.distributorSignIn}>
            Wholesaler sign in <ArrowRight aria-hidden="true" />
          </a>
          <a className="g-link" href={authLinks.distributorSignUp}>
            Create a wholesaler account <ArrowRight aria-hidden="true" />
          </a>
        </article>

        <article className="glass login-choice">
          <span className="g-tile">
            <Store aria-hidden="true" />
          </span>
          <h2>Retailer</h2>
          <p>For stores ordering stock from connected suppliers and reviewing their purchases.</p>
          <a className="g-btn g-btn-primary g-btn-block" href={authLinks.retailerSignIn}>
            Retailer sign in <ArrowRight aria-hidden="true" />
          </a>
          <a className="g-link" href={authLinks.retailerSignUp}>
            Create a retailer account <ArrowRight aria-hidden="true" />
          </a>
        </article>
      </section>

      <p className="g-wrap g-note" style={{ paddingBottom: 60, textAlign: "center" }}>
        These links open the RouteFlow sign-in pages. This page does not collect passwords.
      </p>
    </div>
  );
}

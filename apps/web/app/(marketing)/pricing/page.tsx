import type { Metadata } from "next";
import { PricingTiers } from "../components/pricing-tiers";
import { PricingFaq } from "../components/pricing-faq";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "One clear price. Distributors pay a flat monthly fee. Retailers use the app for free. No per-order charges, no per-driver upcharges, no surprises.",
};

export default function PricingPage() {
  return (
    <>
      <section style={{ padding: "80px 0 32px", textAlign: "center" }}>
        <div className="wrap-narrow">
          <div
            className="eyebrow"
            style={{ display: "inline-flex", justifyContent: "center", marginBottom: 16 }}
          >
            <span className="dot" /> Pricing
          </div>
          <h1 className="display" style={{ fontSize: 80, margin: 0 }}>
            One clear price.
            <br />
            No <em>seat games.</em>
          </h1>
          <p
            style={{
              fontSize: 18,
              color: "var(--rf-ink-3)",
              maxWidth: 540,
              margin: "24px auto 0",
              lineHeight: 1.55,
            }}
          >
            Distributors pay a flat monthly fee. Retailers use the app for free. No per-order
            charges, no per-driver upcharges, no surprises on the bill.
          </p>
        </div>
      </section>

      <PricingTiers />
      <PricingFaq />
    </>
  );
}

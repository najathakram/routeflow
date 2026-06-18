import type { Metadata } from "next";
import Link from "next/link";
import { AudienceSplit } from "./components/audience-split";
import { FlowSpotlight } from "./components/flow-spotlight";
import { GetAppSection } from "./components/get-app-section";
import { IndustriesMarquee } from "./components/industries-marquee";
import { Testimonial } from "./components/testimonial";
import {
  ArrowIcon,
  CartIcon,
  RouteIcon,
  ReceiptIcon,
  UsersIcon,
  ChartIcon,
  ShieldIcon,
} from "./components/icons";

export const metadata: Metadata = {
  // The root layout adds " · RouteFlow" via template, so set just the tagline.
  // `absolute` overrides the template when we want full control.
  title: { absolute: "RouteFlow — Move stock. Move money. Move forward." },
  description:
    "RouteFlow connects wholesalers, distributors and jobbers with the corner stores, bodegas and small businesses they serve — orders, routes, drivers, invoices and payments on one shared rail.",
};

const PILLARS = [
  {
    Icon: CartIcon,
    title: "Order intake",
    body: "Phone, walk-in, portal, mobile app — every order lands in one inbox, deduplicated and ready to confirm.",
  },
  {
    Icon: RouteIcon,
    title: "Route planning",
    body: "Auto-optimised stops, live driver tracking, proof of delivery and instant customer notifications.",
  },
  {
    Icon: ReceiptIcon,
    title: "Smart invoicing",
    body: "Invoices generate the moment a delivery is signed off. Send by email, track payments, manage credit notes.",
  },
  {
    Icon: UsersIcon,
    title: "Customer portal",
    body: "Every retailer gets their own branded portal with their tier pricing, favourites, statement and reorder lists.",
  },
  {
    Icon: ChartIcon,
    title: "Finance & books",
    body: "Bookkeeping that mirrors the real world. Payments reconcile to invoices, expenses tie to runs, taxes filed cleanly.",
  },
  {
    Icon: ShieldIcon,
    title: "Run your way",
    body: "Multi-warehouse, multi-currency, role-based access. RouteFlow flexes to how your business already works.",
  },
];

export default function MarketingHome() {
  return (
    <>
      {/* Hero */}
      <section
        style={{ position: "relative", overflow: "hidden", paddingTop: 72, paddingBottom: 40 }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -240,
            right: -160,
            width: 520,
            height: 520,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(11,110,107,0.16), transparent 70%)",
            filter: "blur(40px)",
            pointerEvents: "none",
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -100,
            left: -160,
            width: 460,
            height: 460,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(199,90,61,0.12), transparent 70%)",
            filter: "blur(50px)",
            pointerEvents: "none",
          }}
        />

        <div className="wrap" style={{ position: "relative", textAlign: "center" }}>
          <div
            className="eyebrow"
            style={{ marginBottom: 22, justifyContent: "center", display: "inline-flex" }}
          >
            <span className="dot" />
            The operating system for distribution
          </div>

          <h1
            className="display"
            style={{
              fontSize: "clamp(54px, 7vw, 104px)",
              margin: 0,
              maxWidth: 1040,
              marginInline: "auto",
              lineHeight: 1.0,
            }}
          >
            One platform for the people who <em>move stock</em>
            <br />
            and the people who <em>stock shelves.</em>
          </h1>

          <p
            style={{
              fontSize: 19,
              lineHeight: 1.55,
              color: "var(--rf-ink-2)",
              maxWidth: 720,
              margin: "28px auto 0",
            }}
          >
            RouteFlow connects wholesalers, distributors and jobbers with the corner stores, bodegas
            and small businesses they serve — orders, routes, drivers, invoices and payments on one
            shared rail.
          </p>

          <div style={{ marginTop: 18, fontSize: 13, color: "var(--rf-ink-3)" }}>
            Pick your side below to see how it works for you.
          </div>
        </div>
      </section>

      <AudienceSplit />

      {/* Pillars */}
      <section className="sect">
        <div className="wrap">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              marginBottom: 48,
              gap: 32,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div className="eyebrow" style={{ marginBottom: 16 }}>
                <span className="dot" /> What&apos;s inside
              </div>
              <h2 className="display" style={{ fontSize: 56, margin: 0, maxWidth: 600 }}>
                Six modules.
                <br />
                One <em>continuous</em> flow.
              </h2>
            </div>
            <p
              style={{
                fontSize: 16,
                color: "var(--rf-ink-3)",
                maxWidth: 360,
                lineHeight: 1.55,
              }}
            >
              We didn&apos;t bolt features together. RouteFlow was designed end-to-end so the order
              you take this morning becomes a paid invoice by tonight.
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 20,
            }}
          >
            {PILLARS.map(({ Icon, title, body }) => (
              <div key={title} className="card" style={{ padding: 28 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: "var(--rf-teal-50)",
                    color: "var(--rf-teal-deep)",
                    display: "grid",
                    placeItems: "center",
                    marginBottom: 18,
                  }}
                >
                  <Icon />
                </div>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    marginBottom: 6,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {title}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: "var(--rf-ink-3)",
                    lineHeight: 1.55,
                  }}
                >
                  {body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <FlowSpotlight />
      <GetAppSection />

      {/* Numbers — these are product-design targets, not metric claims */}
      <section className="sect-sm" style={{ background: "var(--rf-paper)" }}>
        <div className="wrap">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 0,
              borderTop: "1px solid var(--rf-line)",
              borderBottom: "1px solid var(--rf-line)",
            }}
          >
            {[
              ["3 min", "Avg time to confirm an order"],
              ["28%", "Lift in on-time delivery rate"],
              ["$0", "Reconciliation errors per month"],
              ["12 hrs", "Saved per week, per dispatcher"],
            ].map(([n, l], i) => (
              <div
                key={n}
                style={{
                  padding: "40px 24px",
                  borderRight: i < 3 ? "1px solid var(--rf-line)" : "none",
                  textAlign: "center",
                }}
              >
                <div className="display" style={{ fontSize: 56, color: "var(--rf-teal)" }}>
                  {n}
                </div>
                <div style={{ fontSize: 13, color: "var(--rf-ink-3)", marginTop: 8 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Testimonial />
      <IndustriesMarquee />

      {/* Big CTA */}
      <section className="sect-lg">
        <div className="wrap-narrow" style={{ textAlign: "center" }}>
          <h2
            className="display"
            style={{ fontSize: 80, margin: "0 0 24px", letterSpacing: "-0.03em" }}
          >
            Try it on a<br />
            <em>real route.</em>
          </h2>
          <p
            style={{
              fontSize: 18,
              color: "var(--rf-ink-3)",
              maxWidth: 480,
              margin: "0 auto 36px",
              lineHeight: 1.55,
            }}
          >
            Spin up an account in 4 minutes. Bring your customer list and your first order is live
            the same day.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/signup" className="btn btn-primary btn-lg">
              Start free trial <ArrowIcon />
            </Link>
            <Link href="/contact" className="btn btn-ghost btn-lg">
              Talk to sales
            </Link>
          </div>
          <div style={{ marginTop: 24, fontSize: 13, color: "var(--rf-ink-4)" }}>
            14-day trial · No credit card · Cancel anytime
          </div>
        </div>
      </section>
    </>
  );
}

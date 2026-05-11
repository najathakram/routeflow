import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon } from "../components/icons";
import { PhoneShell } from "../components/mocks/phone-shell";
import { PhoneRetailerHome } from "../components/mocks/phone-retailer-home";
import { PhoneShop } from "../components/mocks/phone-shop";

export const metadata: Metadata = {
  title: "For Retailers — Order stock between customers",
  description:
    "Free forever for corner stores, bodegas, salons, restaurants and small businesses. Voice it. Tap it. Done. The RouteFlow Shop app.",
};

const FEATURES = [
  {
    icon: "🎤",
    title: "Voice ordering",
    body: "Just say it. Your dialect, your speed. English & Spanish supported.",
    chips: ["English", "Español", "Voice", "Hands-free"],
  },
  {
    icon: "📦",
    title: "Reorder in 2 taps",
    body: "Last week's order, last month's order, your favourites — all one tap away.",
    chips: ["Last order", "Favourites", "Top 10"],
  },
  {
    icon: "📍",
    title: "Live tracking",
    body: "Know exactly when your stock arrives. ETAs that actually update.",
    chips: ["ETA 11:42", "Driver: Ramesh", "On route"],
  },
  {
    icon: "💸",
    title: "Pay your way",
    body: "ACH, card, check or cash. Statement of account always up to date.",
    chips: ["ACH", "Card", "Cash"],
  },
  {
    icon: "🧾",
    title: "Every bill in one place",
    body: "All your supplier invoices and receipts. PDF on demand.",
    chips: ["Search bills", "Tax view", "Export"],
  },
  {
    icon: "🌐",
    title: "Multiple suppliers",
    body: "Connect to all the distributors you buy from. One app for all of them.",
    chips: ["Add supplier", "Compare prices"],
  },
];

export default function RetailersPage() {
  return (
    <>
      <section
        style={{
          padding: "80px 0 48px",
          background: "linear-gradient(180deg, var(--rf-cream) 0%, #F4ECDB 100%)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div className="wrap">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 64,
              alignItems: "center",
            }}
          >
            <div>
              <div className="eyebrow" style={{ marginBottom: 16 }}>
                <span className="dot" /> For retailers
              </div>
              <h1 className="display" style={{ fontSize: 80, margin: 0 }}>
                Order stock
                <br />
                <em>between customers.</em>
              </h1>
              <p
                style={{
                  fontSize: 18,
                  color: "var(--rf-ink-2)",
                  maxWidth: 500,
                  margin: "24px 0 32px",
                  lineHeight: 1.55,
                }}
              >
                For corner store shops, salons, restaurants, hardware stores — any business that
                orders supplies from a wholesaler. Voice it. Tap it. Done.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link href="/buyer/register" className="btn btn-primary btn-lg">
                  Sign up <ArrowIcon />
                </Link>
                <Link href="/buyer/login" className="btn btn-ghost btn-lg">
                  Sign in
                </Link>
              </div>
              <div style={{ marginTop: 16, fontSize: 13, color: "var(--rf-ink-3)" }}>
                Free forever — no fees, no card.
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                position: "relative",
                height: 580,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: "10%",
                  transform: "rotate(-6deg)",
                  zIndex: 1,
                  opacity: 0.85,
                }}
              >
                <PhoneShell>
                  <PhoneShop />
                </PhoneShell>
              </div>
              <div
                style={{
                  position: "absolute",
                  right: "10%",
                  top: 30,
                  transform: "rotate(6deg)",
                  zIndex: 2,
                }}
              >
                <PhoneShell>
                  <PhoneRetailerHome />
                </PhoneShell>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why retailers love it */}
      <section className="sect">
        <div className="wrap">
          <div style={{ textAlign: "center", marginBottom: 56 }}>
            <h2 className="display" style={{ fontSize: 56, margin: 0 }}>
              Built for the
              <br />
              <em>way you actually shop.</em>
            </h2>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 20,
            }}
          >
            {FEATURES.map((it) => (
              <div key={it.title} className="card" style={{ padding: 24 }}>
                <div style={{ fontSize: 28, marginBottom: 12 }}>{it.icon}</div>
                <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}>{it.title}</div>
                <div
                  style={{
                    fontSize: 14,
                    color: "var(--rf-ink-3)",
                    lineHeight: 1.5,
                    marginBottom: 12,
                  }}
                >
                  {it.body}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {it.chips.map((c) => (
                    <span key={c} className="chip" style={{ fontSize: 11 }}>
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Sign up CTA — replaces the old "Get the RouteFlow Shop app" section
          since the standalone mobile app isn't shipped yet and the real
          action for retailers is to create a free portal account. */}
      <section className="sect" style={{ background: "var(--rf-ink)", color: "var(--rf-cream)" }}>
        <div className="wrap-narrow" style={{ textAlign: "center" }}>
          <h2
            className="display"
            style={{ fontSize: 64, margin: "0 0 20px", color: "var(--rf-cream)" }}
          >
            Create your free
            <br />
            <em style={{ color: "var(--rf-teal-bright)" }}>retailer account.</em>
          </h2>
          <p
            style={{
              fontSize: 17,
              color: "rgba(250,246,238,0.7)",
              lineHeight: 1.55,
              marginBottom: 32,
              maxWidth: 520,
              marginInline: "auto",
            }}
          >
            Free forever for retailers. Your suppliers pay for the platform — you just get the
            convenience. Sign up takes under a minute.
          </p>
          <div
            style={{
              display: "flex",
              gap: 12,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            <Link
              href="/buyer/register"
              className="btn btn-lg"
              style={{ background: "var(--rf-cream)", color: "var(--rf-ink)" }}
            >
              Sign up <ArrowIcon />
            </Link>
            <Link
              href="/buyer/login"
              className="btn btn-ghost btn-lg"
              style={{
                borderColor: "rgba(250,246,238,0.2)",
                color: "var(--rf-cream)",
              }}
            >
              Already have an account? Sign in
            </Link>
          </div>
          <div style={{ marginTop: 20, fontSize: 13, color: "rgba(250,246,238,0.5)" }}>
            Mobile app for iOS &amp; Android — coming soon.
          </div>
        </div>
      </section>
    </>
  );
}

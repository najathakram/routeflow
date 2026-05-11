import type { Metadata } from "next";
import Link from "next/link";
import { AppleIcon, AndroidIcon } from "../components/icons";
import { PhoneShell } from "../components/mocks/phone-shell";
import { PhoneRetailerHome } from "../components/mocks/phone-retailer-home";
import { PhoneShop } from "../components/mocks/phone-shop";
import { InstallAppButton } from "@/components/InstallAppButton";

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
                <InstallAppButton
                  variant="buyer"
                  className="btn btn-primary btn-lg"
                >
                  <AppleIcon /> Get the retailer app
                </InstallAppButton>
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

      {/* Get the app */}
      <section className="sect" style={{ background: "var(--rf-ink)", color: "var(--rf-cream)" }}>
        <div className="wrap">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 80,
              alignItems: "center",
            }}
          >
            <div>
              <h2
                className="display"
                style={{ fontSize: 64, margin: "0 0 20px", color: "var(--rf-cream)" }}
              >
                Get the
                <br />
                <em style={{ color: "var(--rf-teal-bright)" }}>RouteFlow Shop</em> app.
              </h2>
              <p
                style={{
                  fontSize: 16,
                  color: "rgba(250,246,238,0.7)",
                  lineHeight: 1.55,
                  marginBottom: 28,
                  maxWidth: 460,
                }}
              >
                Free forever for retailers. Your suppliers pay for the platform — you just get the
                convenience.
              </p>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 32 }}>
                <a
                  href="#"
                  className="btn"
                  style={{ background: "var(--rf-cream)", color: "var(--rf-ink)" }}
                >
                  <AppleIcon /> App Store
                </a>
                <a
                  href="#"
                  className="btn"
                  style={{ background: "var(--rf-cream)", color: "var(--rf-ink)" }}
                >
                  <AndroidIcon /> Google Play
                </a>
              </div>

              <div
                style={{
                  padding: 16,
                  background: "rgba(255,255,255,0.05)",
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.1)",
                  maxWidth: 420,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: "rgba(250,246,238,0.75)",
                    marginBottom: 4,
                    fontWeight: 600,
                  }}
                >
                  Already have an account?
                </div>
                <div style={{ fontSize: 13, color: "rgba(250,246,238,0.6)" }}>
                  <Link
                    href="/buyer/login"
                    style={{ color: "var(--rf-teal-bright)", textDecoration: "underline" }}
                  >
                    Sign in to your retailer portal →
                  </Link>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "center" }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 24,
                }}
              >
                <div
                  style={{
                    width: 200,
                    height: 200,
                    background: "var(--rf-cream)",
                    borderRadius: 16,
                    padding: 16,
                    position: "relative",
                  }}
                >
                  {/* Decorative QR-ish artwork */}
                  <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
                    {Array.from({ length: 100 }).map((_, i) => {
                      const x = (i % 10) * 10;
                      const y = Math.floor(i / 10) * 10;
                      const fill = (i * 17 + 3) % 5 < 2;
                      return fill ? (
                        <rect key={i} x={x} y={y} width="10" height="10" fill="var(--rf-ink)" />
                      ) : null;
                    })}
                    {[
                      [0, 0],
                      [70, 0],
                      [0, 70],
                    ].map(([cx, cy]) => (
                      <g key={`${cx}-${cy}`}>
                        <rect x={cx} y={cy} width="30" height="30" fill="var(--rf-ink)" />
                        <rect x={cx + 5} y={cy + 5} width="20" height="20" fill="var(--rf-cream)" />
                        <rect
                          x={cx + 10}
                          y={cy + 10}
                          width="10"
                          height="10"
                          fill="var(--rf-ink)"
                        />
                      </g>
                    ))}
                  </svg>
                  <div
                    style={{
                      position: "absolute",
                      inset: "40% 40%",
                      background: "var(--rf-cream)",
                      display: "grid",
                      placeItems: "center",
                      borderRadius: 6,
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        background: "var(--rf-teal)",
                        borderRadius: 6,
                      }}
                    />
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "rgba(250,246,238,0.7)",
                    textAlign: "center",
                  }}
                >
                  Scan with your camera
                  <br />
                  <span style={{ color: "rgba(250,246,238,0.5)", fontSize: 11 }}>
                    iOS 14+ · Android 8+
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

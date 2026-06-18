"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowIcon } from "./icons";
import { PhoneShell } from "./mocks/phone-shell";
import { PhoneRetailerHome } from "./mocks/phone-retailer-home";
import { MockOrdersTable } from "./mocks/orders-table";

type Hover = "retailer" | "wholesaler" | null;

export function AudienceSplit() {
  const [hover, setHover] = useState<Hover>(null);
  return (
    <section style={{ paddingBottom: 80 }}>
      <div className="wrap">
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div className="eyebrow" style={{ justifyContent: "center", display: "inline-flex" }}>
            <span className="dot" />
            Pick your side
          </div>
          <h2
            className="display"
            style={{ fontSize: 44, margin: "10px 0 0", maxWidth: 720, marginInline: "auto" }}
          >
            Two sides of the same trade.
            <br />
            <em>Tap into yours.</em>
          </h2>
        </div>

        <div
          className="audience-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 18,
            perspective: 1400,
          }}
        >
          {/* RETAILER half */}
          <Link
            href="/retailers"
            onMouseEnter={() => setHover("retailer")}
            onMouseLeave={() => setHover(null)}
            style={{
              position: "relative",
              borderRadius: 28,
              overflow: "hidden",
              minHeight: 560,
              background: "linear-gradient(155deg, #FFEAC9 0%, #F4C9A0 55%, #E89A6F 100%)",
              boxShadow:
                hover === "retailer"
                  ? "0 50px 90px -30px rgba(199,90,61,0.5)"
                  : "0 30px 60px -30px rgba(199,90,61,0.3)",
              transform:
                hover === "retailer" ? "translateY(-6px) rotateX(0.5deg)" : "translateY(0)",
              transition: "transform 0.4s cubic-bezier(.2,.9,.3,1.2), box-shadow 0.4s",
              display: "flex",
              flexDirection: "column",
              padding: 36,
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: -120,
                right: -100,
                width: 360,
                height: 360,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, rgba(255,228,185,0.85), rgba(199,90,61,0) 65%)",
                transition: "transform 0.5s",
                transform: hover === "retailer" ? "scale(1.15)" : "scale(1)",
              }}
            />

            <div
              style={{
                position: "relative",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                zIndex: 2,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#5A2412" }}>
                  Corner stores · Bodegas · Cafés · Salons · Convenience
                </div>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: "#5A2412",
                  color: "#FFEAC9",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}
              >
                Free forever
              </span>
            </div>

            <div style={{ position: "relative", zIndex: 2, marginTop: 28 }}>
              <h3
                className="display"
                style={{
                  fontSize: 64,
                  margin: 0,
                  color: "#3D1808",
                  lineHeight: 0.95,
                  maxWidth: "55%",
                }}
              >
                I&apos;m a
                <br />
                <em style={{ color: "#A8401E" }}>retailer.</em>
              </h3>
              <p
                style={{
                  fontSize: 15,
                  color: "#5A2412",
                  lineHeight: 1.55,
                  marginTop: 18,
                  maxWidth: "54%",
                  fontWeight: 500,
                }}
              >
                I order stock between customers. I want my suppliers&apos; catalogs in my pocket —
                at <em>my</em> price.
              </p>
            </div>

            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                bottom: -30,
                right: -50,
                width: 200,
                transform:
                  hover === "retailer" ? "rotate(-4deg) translateY(-10px)" : "rotate(-2deg)",
                transition: "transform 0.5s cubic-bezier(.2,.9,.3,1.2)",
                filter: "drop-shadow(0 30px 30px rgba(95,35,12,0.35))",
                zIndex: 2,
              }}
            >
              <PhoneShell>
                <PhoneRetailerHome />
              </PhoneShell>
            </div>

            <div
              style={{
                marginTop: "auto",
                position: "relative",
                zIndex: 3,
                paddingTop: 28,
                maxWidth: "60%",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
                {["📦 Reorder", "🎤 Voice search", "🚚 Live ETAs", "💳 Pay invoices"].map((c) => (
                  <span
                    key={c}
                    style={{
                      padding: "5px 10px",
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "#5A2412",
                      background: "rgba(255,255,255,0.65)",
                      borderRadius: 999,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "14px 22px",
                  background: "#3D1808",
                  color: "#FFEAC9",
                  borderRadius: 999,
                  fontSize: 15,
                  fontWeight: 600,
                  transform: hover === "retailer" ? "translateX(4px)" : "translateX(0)",
                  transition: "transform 0.3s",
                }}
              >
                Enter retailer site <ArrowIcon />
              </div>
            </div>
          </Link>

          {/* WHOLESALER half */}
          <Link
            href="/wholesalers"
            onMouseEnter={() => setHover("wholesaler")}
            onMouseLeave={() => setHover(null)}
            style={{
              position: "relative",
              borderRadius: 28,
              overflow: "hidden",
              minHeight: 560,
              background: "linear-gradient(155deg, #0E1F36 0%, #073F3D 60%, #0B6E6B 100%)",
              boxShadow:
                hover === "wholesaler"
                  ? "0 50px 90px -30px rgba(11,110,107,0.6)"
                  : "0 30px 60px -30px rgba(11,110,107,0.4)",
              transform:
                hover === "wholesaler" ? "translateY(-6px) rotateX(0.5deg)" : "translateY(0)",
              transition: "transform 0.4s cubic-bezier(.2,.9,.3,1.2), box-shadow 0.4s",
              display: "flex",
              flexDirection: "column",
              padding: 36,
              color: "var(--rf-cream)",
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: -120,
                right: -100,
                width: 360,
                height: 360,
                borderRadius: "50%",
                background:
                  "radial-gradient(circle, rgba(125,220,216,0.4), rgba(20,163,159,0) 65%)",
                transition: "transform 0.5s",
                transform: hover === "wholesaler" ? "scale(1.15)" : "scale(1)",
              }}
            />

            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                opacity: 0.18,
                backgroundImage:
                  "linear-gradient(to right, rgba(125,220,216,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(125,220,216,0.5) 1px, transparent 1px)",
                backgroundSize: "32px 32px",
                maskImage: "radial-gradient(ellipse at top right, black, transparent 65%)",
                WebkitMaskImage: "radial-gradient(ellipse at top right, black, transparent 65%)",
              }}
            />

            <div
              style={{
                position: "relative",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                zIndex: 2,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(250,246,238,0.85)" }}>
                  Distributors · Wholesalers · Jobbers · FMCG
                </div>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: "#7DDCD8",
                  color: "#073F3D",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}
              >
                14-day trial
              </span>
            </div>

            <div style={{ position: "relative", zIndex: 2, marginTop: 28 }}>
              <h3
                className="display"
                style={{
                  fontSize: 64,
                  margin: 0,
                  color: "var(--rf-cream)",
                  lineHeight: 0.95,
                  maxWidth: "55%",
                }}
              >
                I&apos;m a
                <br />
                <em style={{ color: "#7DDCD8" }}>wholesaler.</em>
              </h3>
              <p
                style={{
                  fontSize: 15,
                  color: "rgba(250,246,238,0.78)",
                  lineHeight: 1.55,
                  marginTop: 18,
                  maxWidth: "54%",
                  fontWeight: 500,
                }}
              >
                I run trucks and routes. I want every order, route and invoice on one rail — and my
                cash collected.
              </p>
            </div>

            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                bottom: 180,
                right: -140,
                width: 260,
                transform:
                  hover === "wholesaler" ? "rotate(-3deg) translateY(-10px)" : "rotate(-1deg)",
                transition: "transform 0.5s cubic-bezier(.2,.9,.3,1.2)",
                filter: "drop-shadow(0 30px 40px rgba(0,0,0,0.4))",
                borderRadius: 14,
                overflow: "hidden",
                zIndex: 2,
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <MockOrdersTable />
            </div>

            <div
              style={{
                marginTop: "auto",
                position: "relative",
                zIndex: 3,
                paddingTop: 28,
                maxWidth: "60%",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
                {["🗺 Route opt.", "📋 Dispatch", "🧾 Auto-invoice", "💰 Collections"].map((c) => (
                  <span
                    key={c}
                    style={{
                      padding: "5px 10px",
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "rgba(250,246,238,0.9)",
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 999,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "14px 22px",
                  background: "#7DDCD8",
                  color: "#073F3D",
                  borderRadius: 999,
                  fontSize: 15,
                  fontWeight: 700,
                  transform: hover === "wholesaler" ? "translateX(4px)" : "translateX(0)",
                  transition: "transform 0.3s",
                }}
              >
                Enter wholesaler site <ArrowIcon />
              </div>
            </div>
          </Link>
        </div>

        <div style={{ textAlign: "center", marginTop: 24, fontSize: 13, color: "var(--rf-ink-3)" }}>
          Already use RouteFlow? Pick your side above to sign in.
        </div>
      </div>
    </section>
  );
}

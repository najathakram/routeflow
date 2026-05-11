"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowIcon, CheckIcon } from "./icons";

type Billing = "monthly" | "yearly";

interface Tier {
  name: string;
  monthly: number | null; // null = custom pricing ("Let's talk")
  yearly: number | null;
  desc: string;
  features: string[];
  cta: string;
  ctaHref: string;
  ctaTone: "primary" | "ghost";
  featured?: boolean;
}

const TIERS: Tier[] = [
  {
    name: "Starter",
    monthly: 49,
    yearly: 41,
    desc: "For small distributors getting off paper.",
    features: [
      "Up to 200 customers",
      "Up to 1,000 orders / month",
      "1 warehouse",
      "2 user seats",
      "Email support",
      "Mobile retailer app included",
    ],
    cta: "Start free trial",
    ctaHref: "/signup",
    ctaTone: "ghost",
  },
  {
    name: "Growth",
    monthly: 129,
    yearly: 108,
    desc: "For growing operations with multiple drivers.",
    features: [
      "Up to 1,000 customers",
      "Up to 8,000 orders / month",
      "3 warehouses",
      "10 user seats",
      "Route optimisation",
      "Driver app + live tracking",
      "Priority support",
    ],
    cta: "Start free trial",
    ctaHref: "/signup",
    ctaTone: "primary",
    featured: true,
  },
  {
    name: "Scale",
    monthly: null,
    yearly: null,
    desc: "For distributors running real operations.",
    features: [
      "Unlimited customers & orders",
      "Unlimited warehouses",
      "Unlimited seats",
      "Custom roles & SSO",
      "Dedicated account manager",
      "Custom integrations",
      "99.9% uptime SLA",
      "On-site training",
    ],
    cta: "Talk to sales",
    ctaHref: "/contact",
    ctaTone: "ghost",
  },
];

function formatPrice(tier: Tier, billing: Billing): { price: string; suffix: string | null } {
  const v = billing === "monthly" ? tier.monthly : tier.yearly;
  if (v === null) return { price: "Let's talk", suffix: null };
  return { price: `$${v}`, suffix: "/mo" };
}

export function PricingTiers() {
  const [billing, setBilling] = useState<Billing>("monthly");

  return (
    <>
      {/* Billing toggle */}
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            display: "inline-flex",
            marginTop: 32,
            padding: 4,
            background: "var(--rf-paper)",
            border: "1px solid var(--rf-line)",
            borderRadius: 999,
            gap: 4,
          }}
        >
          {(
            [
              ["monthly", "Monthly"],
              ["yearly", "Yearly · save 16%"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              className="btn"
              style={{
                background: billing === k ? "var(--rf-ink)" : "transparent",
                color: billing === k ? "var(--rf-cream)" : "var(--rf-ink-3)",
                padding: "8px 16px",
                fontSize: 13,
              }}
              onClick={() => setBilling(k)}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <section style={{ paddingBottom: 64, paddingTop: 48 }}>
        <div className="wrap">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 20,
            }}
          >
            {TIERS.map((t) => {
              const { price, suffix } = formatPrice(t, billing);
              return (
                <div
                  key={t.name}
                  style={{
                    padding: 32,
                    background: t.featured ? "var(--rf-ink)" : "var(--rf-paper)",
                    color: t.featured ? "var(--rf-cream)" : "var(--rf-ink)",
                    border: t.featured ? "none" : "1px solid var(--rf-line)",
                    borderRadius: 18,
                    position: "relative",
                    transform: t.featured ? "scale(1.02)" : "none",
                    boxShadow: t.featured ? "0 30px 60px -20px rgba(14,31,54,0.4)" : "none",
                  }}
                >
                  {t.featured && (
                    <div
                      style={{
                        position: "absolute",
                        top: -12,
                        left: 32,
                        padding: "4px 12px",
                        background: "var(--rf-teal-bright)",
                        color: "var(--rf-ink)",
                        fontSize: 11,
                        fontWeight: 700,
                        borderRadius: 999,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                      }}
                    >
                      Most popular
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: t.featured ? "var(--rf-teal-bright)" : "var(--rf-teal)",
                      marginBottom: 8,
                    }}
                  >
                    {t.name}
                  </div>
                  <div
                    className="display"
                    style={{
                      fontSize: 56,
                      lineHeight: 1,
                      color: t.featured ? "var(--rf-cream)" : "var(--rf-ink)",
                    }}
                  >
                    {price}
                    {suffix && (
                      <span
                        style={{
                          fontSize: 14,
                          color: t.featured
                            ? "rgba(250,246,238,0.5)"
                            : "var(--rf-ink-4)",
                          fontFamily: "var(--rf-sans)",
                          fontWeight: 400,
                        }}
                      >
                        {suffix}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      color: t.featured ? "rgba(250,246,238,0.7)" : "var(--rf-ink-3)",
                      marginTop: 12,
                      marginBottom: 24,
                    }}
                  >
                    {t.desc}
                  </div>
                  <Link
                    href={t.ctaHref}
                    className="btn btn-lg"
                    style={{
                      width: "100%",
                      justifyContent: "center",
                      background: t.featured
                        ? "var(--rf-cream)"
                        : t.ctaTone === "primary"
                        ? "var(--rf-ink)"
                        : "transparent",
                      color: t.featured
                        ? "var(--rf-ink)"
                        : t.ctaTone === "primary"
                        ? "var(--rf-cream)"
                        : "var(--rf-ink)",
                      border:
                        t.ctaTone === "ghost" && !t.featured
                          ? "1px solid var(--rf-line-2)"
                          : "none",
                      marginBottom: 24,
                    }}
                  >
                    {t.cta} <ArrowIcon />
                  </Link>
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: 0,
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    {t.features.map((f) => (
                      <li
                        key={f}
                        style={{
                          display: "flex",
                          gap: 10,
                          fontSize: 14,
                          color: t.featured ? "rgba(250,246,238,0.85)" : "var(--rf-ink-2)",
                        }}
                      >
                        <CheckIcon
                          style={{
                            color: t.featured ? "var(--rf-teal-bright)" : "var(--rf-teal)",
                            flexShrink: 0,
                            marginTop: 2,
                          }}
                        />{" "}
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          {/* Always-included */}
          <div
            style={{
              marginTop: 48,
              padding: 32,
              background: "var(--rf-cream-2)",
              borderRadius: 18,
              border: "1px solid var(--rf-line)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--rf-ink-3)",
                marginBottom: 16,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Included on every plan
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                flexWrap: "wrap",
                gap: 16,
              }}
            >
              {[
                "Mobile retailer app (free for your customers)",
                "Unlimited products",
                "Unlimited delivery runs",
                "Bookkeeping & tax exports",
                "Bank-grade security",
                "iOS & Android apps",
                "API access",
              ].map((f) => (
                <span
                  key={f}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 13,
                    color: "var(--rf-ink-2)",
                  }}
                >
                  <CheckIcon style={{ color: "var(--rf-teal)" }} /> {f}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

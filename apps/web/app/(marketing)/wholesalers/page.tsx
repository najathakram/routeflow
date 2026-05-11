import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon } from "../components/icons";
import { MockOrdersTable } from "../components/mocks/orders-table";

export const metadata: Metadata = {
  title: "For Wholesalers — Run your routes like clockwork",
  description:
    "For wholesale distributors, jobbers and supply businesses. Take the chaos out of order taking, route planning, dispatch and collection.",
};

const PAINS = [
  {
    pain: "Orders coming in on phone calls, walk-ins, and three sales reps' notebooks",
    fix: "All channels into one queue. Auto-priced, auto-deduplicated, ready to confirm.",
  },
  {
    pain: "Drivers calling dispatch every 20 minutes asking what's next",
    fix: "Driver app shows the optimised route + customer notes. Dispatch sees live location.",
  },
  {
    pain: "End-of-day three hours of typing invoices into QuickBooks",
    fix: "Invoices generate from PODs and post to your books in real time.",
  },
  {
    pain: "You don't know which routes are profitable until the accountant tells you",
    fix: "Real-time P&L by route, van, customer and SKU.",
  },
  {
    pain: "$25,000 sitting in 'follow-up later' from people who said the cheque is coming",
    fix: "Auto-reminder cadence, statement of account, payment links — collections become a system.",
  },
  {
    pain: "When a key staffer leaves, half the customer relationships go with them",
    fix: "Every customer interaction lives in RouteFlow, not in someone's head.",
  },
];

const TARGETS: Array<[string, string]> = [
  ["+34%", "Orders processed per dispatcher per day"],
  ["−42%", "Time from order placed to invoice paid"],
  ["+18%", "Customers ordering at least weekly"],
  ["12 hrs", "Saved each week on bookkeeping"],
];

export default function WholesalersPage() {
  return (
    <>
      <section
        style={{
          padding: "80px 0 64px",
          background: "linear-gradient(180deg, var(--rf-cream) 0%, var(--rf-paper) 100%)",
        }}
      >
        <div className="wrap">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.1fr 1fr",
              gap: 64,
              alignItems: "center",
            }}
          >
            <div>
              <div className="eyebrow" style={{ marginBottom: 16 }}>
                <span className="dot" /> For wholesalers
              </div>
              <h1 className="display" style={{ fontSize: 80, margin: 0 }}>
                Run your
                <br />
                routes <em>like clockwork.</em>
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
                For wholesale distributors, jobbers and supply businesses. Take the chaos out of
                order taking, route planning, dispatch and collection.
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Link href="/signup" className="btn btn-primary btn-lg">
                  Start free trial <ArrowIcon />
                </Link>
                <Link href="/contact" className="btn btn-ghost btn-lg">
                  Book a demo
                </Link>
              </div>
            </div>

            <div style={{ position: "relative", height: 460 }}>
              <div
                style={{
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  width: "85%",
                  transform: "rotate(2deg)",
                  boxShadow: "0 30px 60px -20px rgba(14,31,54,0.3)",
                }}
              >
                <MockOrdersTable />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pain → fix */}
      <section className="sect" style={{ background: "var(--rf-paper)" }}>
        <div className="wrap">
          <div style={{ textAlign: "center", marginBottom: 56 }}>
            <h2 className="display" style={{ fontSize: 56, margin: 0 }}>
              If this sounds familiar,
              <br />
              RouteFlow is <em>for you.</em>
            </h2>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 20,
            }}
          >
            {PAINS.map((it) => (
              <div
                key={it.pain}
                style={{
                  padding: 24,
                  background: "var(--rf-cream)",
                  borderRadius: 16,
                  border: "1px solid var(--rf-line)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--rf-rust)",
                    fontWeight: 600,
                    marginBottom: 4,
                    fontFamily: "var(--rf-mono)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  The pain
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: "var(--rf-ink)",
                    marginBottom: 16,
                    lineHeight: 1.5,
                    fontWeight: 500,
                  }}
                >
                  {it.pain}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--rf-teal)",
                    fontWeight: 600,
                    marginBottom: 4,
                    fontFamily: "var(--rf-mono)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  The fix
                </div>
                <div style={{ fontSize: 14, color: "var(--rf-ink-2)", lineHeight: 1.5 }}>
                  {it.fix}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Targets — softened from "Distributors on RouteFlow, on average" */}
      <section className="sect" style={{ background: "var(--rf-ink)", color: "var(--rf-cream)" }}>
        <div className="wrap">
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <h2
              className="display"
              style={{ fontSize: 56, color: "var(--rf-cream)", margin: 0 }}
            >
              What we&apos;re building toward,
              <br />
              <em style={{ color: "var(--rf-teal-bright)" }}>per route:</em>
            </h2>
            <p
              style={{
                fontSize: 14,
                color: "rgba(250,246,238,0.6)",
                marginTop: 16,
                fontFamily: "var(--rf-mono)",
                letterSpacing: "0.04em",
              }}
            >
              Targets from internal pilots — numbers refresh as we scale.
            </p>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 24,
              marginTop: 40,
            }}
          >
            {TARGETS.map(([n, l]) => (
              <div
                key={n}
                style={{
                  padding: 24,
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 16,
                  borderLeft: "2px solid var(--rf-teal-bright)",
                }}
              >
                <div
                  className="display"
                  style={{ fontSize: 56, color: "var(--rf-teal-bright)", lineHeight: 1 }}
                >
                  {n}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "rgba(250,246,238,0.7)",
                    marginTop: 12,
                    lineHeight: 1.4,
                  }}
                >
                  {l}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="sect-lg" style={{ textAlign: "center" }}>
        <div className="wrap-narrow">
          <h2 className="display" style={{ fontSize: 64, margin: "0 0 20px" }}>
            Ready to <em>tighten</em> the wheel?
          </h2>
          <p
            style={{ fontSize: 17, color: "var(--rf-ink-3)", marginBottom: 32 }}
          >
            Free 14-day trial. We&apos;ll help you migrate your customer list and product catalog.
          </p>
          <div
            style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}
          >
            <Link href="/signup" className="btn btn-primary btn-lg">
              Start free trial <ArrowIcon />
            </Link>
            <Link href="/login" className="btn btn-ghost btn-lg">
              Sign in
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon } from "../components/icons";
import { FeatureBlock } from "../components/feature-block";
import { MockOrdersTable } from "../components/mocks/orders-table";
import { MockRouteMap } from "../components/mocks/route-map";
import { MockInvoice } from "../components/mocks/invoice";
import { Spark } from "../components/mocks/spark";
import { StatTile } from "../components/mocks/stat-tile";
import { PhoneShell } from "../components/mocks/phone-shell";
import { PhoneShop } from "../components/mocks/phone-shop";

export const metadata: Metadata = {
  title: "Product",
  description:
    "One platform for the whole distribution flow — order intake, route planning, smart invoicing, customer portal, finance & books, and an open API.",
};

export default function ProductPage() {
  return (
    <>
      {/* Header */}
      <section style={{ padding: "80px 0 40px", textAlign: "center" }}>
        <div className="wrap-narrow">
          <div
            className="eyebrow"
            style={{ justifyContent: "center", display: "inline-flex", marginBottom: 20 }}
          >
            <span className="dot" /> Product
          </div>
          <h1 className="display" style={{ fontSize: 80, margin: 0 }}>
            One platform.
            <br />
            The <em>whole</em> distribution flow.
          </h1>
          <p
            style={{
              fontSize: 18,
              color: "var(--rf-ink-3)",
              maxWidth: 560,
              margin: "24px auto 0",
              lineHeight: 1.55,
            }}
          >
            Everything that used to live in spreadsheets, paper books and three different apps —
            now in a single, connected workspace.
          </p>
        </div>
      </section>

      <FeatureBlock
        eyebrow="Order intake"
        title={
          <>
            Every order,
            <br />
            <em>one inbox.</em>
          </>
        }
        body={{
          intro:
            "Customers can place orders through their portal, the mobile app, or you can key in phone orders. RouteFlow normalises them all into one queue your team works from.",
          points: [
            ["Smart deduplication", "If the same retailer orders via two channels, we merge it. No double picks."],
            ["Tier pricing applied automatically", "The right price for the right customer, every time."],
            ["Credit limit & overdue checks", "Confirm with confidence — risky orders are flagged before they ship."],
          ],
        }}
        mock={
          <div style={{ transform: "rotate(-2deg)" }}>
            <MockOrdersTable />
          </div>
        }
      />

      <FeatureBlock
        reverse
        eyebrow="Route planning"
        title={
          <>
            <em>Optimised</em> stops.
            <br />
            Live tracking.
          </>
        }
        body={{
          intro:
            "Build routes in minutes, not hours. Auto-stitch stops by capacity, geography and time windows. Drivers see what's next; you see where they are.",
          points: [
            ["One-click route building", "Just pick the stops — RouteFlow sequences them for you."],
            ["Driver app with offline mode", "Works in deep rural areas where signal drops."],
            ["Live ETA to every customer", "Notifications with photo proof on delivery."],
          ],
        }}
        mock={<MockRouteMap />}
      />

      <FeatureBlock
        eyebrow="Smart invoicing"
        title={
          <>
            Invoices that
            <br />
            <em>write themselves.</em>
          </>
        }
        body={{
          intro:
            "The moment a delivery is signed off, the invoice is generated, sent and reconciled — in your books and in your customer's portal. No more end-of-day data entry.",
          points: [
            ["Auto-generate from POD", "Pickers can swap items at the door — invoice matches what was actually delivered."],
            ["Multi-channel send", "Email or SMS. Customers click and pay via ACH."],
            ["Credit notes & part-payments", "All the messy reality of trade, handled cleanly."],
          ],
        }}
        mock={
          <div style={{ transform: "rotate(2deg)" }}>
            <MockInvoice />
          </div>
        }
      />

      <FeatureBlock
        reverse
        eyebrow="Customer portal & app"
        title={
          <>
            Your shop window,
            <br />
            open <em>24/7.</em>
          </>
        }
        body={{
          intro:
            "Every retailer gets their own branded ordering experience — web portal and a native iOS/Android app. They reorder when they're stocking shelves at midnight; you see it in the morning.",
          points: [
            ["Branded with your colors & logo", "Looks like your business, not a generic SaaS."],
            ["Voice search in English & Spanish", "Built for North America. The clerk just says \"Cheerios, two boxes\"."],
            ["Reorder lists & favourites", "Their last order, ready in two taps."],
          ],
        }}
        mock={
          <div style={{ display: "flex", justifyContent: "center" }}>
            <div style={{ transform: "rotate(-3deg)" }}>
              <PhoneShell>
                <PhoneShop />
              </PhoneShell>
            </div>
          </div>
        }
      />

      <FeatureBlock
        eyebrow="Finance & books"
        title={
          <>
            Books that
            <br />
            <em>match reality.</em>
          </>
        }
        body={{
          intro:
            "Bookkeeping is the byproduct of running RouteFlow, not a separate job. Every payment ties to an invoice; every expense ties to a run; every tax line is filing-ready.",
          points: [
            ["ACH & card reconciliation", "Match payments to invoices automatically. Flag the rest for review."],
            ["Tax-ready exports", "Sales tax & 1099, e-invoicing — generated, not assembled."],
            ["Real-time P&L by route", "Know which van, which territory, which customer is profitable."],
          ],
        }}
        mock={
          <div className="card" style={{ padding: 24, transform: "rotate(-1.5deg)" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 13, color: "var(--rf-ink-3)", fontWeight: 600 }}>
                Cash collected · Last 30 days
              </div>
              <div className="chip chip-teal">Trending up</div>
            </div>
            <div
              style={{
                fontSize: 36,
                fontWeight: 600,
                fontFamily: "var(--rf-display)",
                marginBottom: 4,
              }}
            >
              $184,200
            </div>
            <Spark />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginTop: 16,
              }}
            >
              <StatTile label="Outstanding" value="$28,400" delta="6%" deltaPositive={false} />
              <StatTile label="Avg DSO" value="11.3 days" delta="2.1d" deltaPositive />
            </div>
          </div>
        }
      />

      <FeatureBlock
        reverse
        eyebrow="Run your way"
        title={
          <>
            Bend it to
            <br />
            your <em>business.</em>
          </>
        }
        body={{
          intro:
            "Multi-warehouse, multi-currency, multi-brand, role-based access. Whether you run one van or fifty, RouteFlow flexes around how you already work.",
          points: [
            ["Custom roles & permissions", "Pickers, drivers, dispatchers, finance — each sees exactly what they need."],
            ["Multi-warehouse stock", "Per-warehouse inventory with smart fulfilment routing."],
            ["Open API & webhooks", "Push to QuickBooks, pull from your e-commerce, integrate anything."],
          ],
        }}
        mock={
          <div
            className="card"
            style={{
              padding: 24,
              fontFamily: "var(--rf-mono)",
              fontSize: 11,
              background: "var(--rf-ink)",
              color: "var(--rf-cream)",
              lineHeight: 1.6,
            }}
          >
            <div style={{ color: "var(--rf-teal-bright)", marginBottom: 8 }}>
              POST /api/orders
            </div>
            <pre
              style={{
                opacity: 0.8,
                margin: 0,
                fontFamily: "inherit",
                whiteSpace: "pre-wrap",
              }}
            >
{`{
  "customer_id": "cust_4abc",
  "items": [
    { "sku": "PG-800", "qty": 24 },
    { "sku": "MG-2M",  "qty": 18 }
  ],
  "deliver_by": "2026-05-12",
  "warehouse": "austin-01"
}`}
            </pre>
            <div style={{ color: "var(--rf-teal-bright)", marginTop: 12 }}>
              → 200 OK · order confirmed in 84ms
            </div>
          </div>
        }
      />

      {/* CTA strip */}
      <section
        className="sect"
        style={{ background: "var(--rf-ink)", color: "var(--rf-cream)", textAlign: "center" }}
      >
        <div className="wrap-narrow">
          <h2
            className="display"
            style={{ fontSize: 56, color: "var(--rf-cream)", margin: "0 0 20px" }}
          >
            See it on{" "}
            <em style={{ color: "var(--rf-teal-bright)" }}>your data.</em>
          </h2>
          <p
            style={{
              fontSize: 16,
              color: "rgba(250,246,238,0.7)",
              marginBottom: 32,
            }}
          >
            Bring your customer list. We&apos;ll show you a working RouteFlow seeded with your real
            business in 30 minutes.
          </p>
          <div
            style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}
          >
            <Link
              href="/signup"
              className="btn"
              style={{ background: "var(--rf-cream)", color: "var(--rf-ink)" }}
            >
              Start free trial <ArrowIcon />
            </Link>
            <Link
              href="/contact"
              className="btn btn-ghost"
              style={{ borderColor: "rgba(250,246,238,0.2)", color: "var(--rf-cream)" }}
            >
              Book a guided demo
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

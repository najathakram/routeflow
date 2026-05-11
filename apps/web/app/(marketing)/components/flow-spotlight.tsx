import { MockOrdersTable } from "./mocks/orders-table";
import { MockRouteMap } from "./mocks/route-map";
import { MockInvoice } from "./mocks/invoice";

const STEPS: Array<[string, string]> = [
  ["Retailer orders via app", "Order lands in your inbox, priced and ready"],
  ["You confirm & assign a route", "Auto-optimised based on capacity & geography"],
  ["Driver delivers & signs off", "Proof of delivery captured with photo"],
  ["Invoice generates instantly", "Sent by email, paid via ACH, reconciled in books"],
];

export function FlowSpotlight() {
  return (
    <section
      className="sect"
      style={{
        background: "var(--rf-cream-2)",
        borderTop: "1px solid var(--rf-line)",
        borderBottom: "1px solid var(--rf-line)",
      }}
    >
      <div className="wrap">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "0.8fr 1.2fr",
            gap: 64,
            alignItems: "center",
          }}
        >
          <div>
            <div className="eyebrow" style={{ marginBottom: 16 }}>
              <span className="dot" /> The flow
            </div>
            <h2 className="display" style={{ fontSize: 52, margin: "0 0 20px" }}>
              From order
              <br />
              to <em>cash</em>.<br />
              Without friction.
            </h2>
            <p
              style={{
                fontSize: 16,
                color: "var(--rf-ink-2)",
                lineHeight: 1.6,
                marginBottom: 28,
              }}
            >
              The traditional distribution stack is a relay race of phone calls and paperwork —
              each handoff loses time and money. RouteFlow turns that relay into a single
              uninterrupted current.
            </p>
            <div style={{ display: "grid", gap: 14 }}>
              {STEPS.map(([t, b], i) => (
                <div
                  key={t}
                  style={{
                    display: "flex",
                    gap: 14,
                    padding: 12,
                    background: "var(--rf-paper)",
                    borderRadius: 12,
                    border: "1px solid var(--rf-line)",
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: "var(--rf-ink)",
                      color: "var(--rf-cream)",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      fontFamily: "var(--rf-mono)",
                      flexShrink: 0,
                    }}
                  >
                    0{i + 1}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{t}</div>
                    <div style={{ fontSize: 13, color: "var(--rf-ink-3)" }}>{b}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Stacked surfaces */}
          <div style={{ position: "relative", height: 600 }}>
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 60,
                width: 320,
                transform: "rotate(-2deg)",
                boxShadow: "0 20px 40px -20px rgba(14,31,54,0.2)",
              }}
            >
              <MockOrdersTable />
            </div>
            <div
              style={{
                position: "absolute",
                top: 200,
                left: 0,
                width: "85%",
                transform: "rotate(2deg)",
                boxShadow: "0 20px 40px -20px rgba(14,31,54,0.25)",
                borderRadius: 16,
                overflow: "hidden",
              }}
            >
              <MockRouteMap />
            </div>
            <div
              style={{
                position: "absolute",
                bottom: 0,
                right: 0,
                width: 300,
                transform: "rotate(-2deg)",
                boxShadow: "0 20px 40px -20px rgba(14,31,54,0.25)",
              }}
            >
              <MockInvoice />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

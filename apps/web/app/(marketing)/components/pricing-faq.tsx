// FAQ accordion using native <details>/<summary> — no JS needed.
// Lives in its own component just to keep the pricing page tidy.

const FAQS: Array<[string, string]> = [
  [
    "Do my retailers pay anything?",
    "No. The mobile app and web portal for retailers is always free. Distributors pay the platform fee.",
  ],
  [
    "What if I have more than 8,000 orders a month?",
    "Talk to us about Scale. We work with distributors processing 100,000+ orders a month — flat-rate pricing, no per-order fees.",
  ],
  [
    "Can I import my data from QuickBooks / Zoho / Excel?",
    "Yes. We have direct importers for QuickBooks, Zoho, and any CSV. The migration takes a few hours and we can run it for you.",
  ],
  [
    "What about sales tax filing?",
    "RouteFlow generates Sales tax & 1099 exports natively. Your accountant will love it.",
  ],
  [
    "Can I cancel anytime?",
    "Yes. Month-to-month, no contracts. Yearly plans pro-rate refunds.",
  ],
  [
    "Will the price go up later?",
    "We honour your launch price for life. The price you sign up at is the price you keep.",
  ],
];

export function PricingFaq() {
  return (
    <section className="sect">
      <div className="wrap-narrow">
        <h2
          className="display"
          style={{ fontSize: 48, margin: "0 0 32px", textAlign: "center" }}
        >
          Common <em>questions.</em>
        </h2>
        <div style={{ display: "grid", gap: 12 }}>
          {FAQS.map(([q, a]) => (
            <details
              key={q}
              style={{
                padding: "20px 24px",
                background: "var(--rf-paper)",
                borderRadius: 12,
                border: "1px solid var(--rf-line)",
              }}
            >
              <summary
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  listStyle: "none",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                {q}
                <span style={{ color: "var(--rf-ink-4)", fontSize: 18, fontWeight: 300 }}>+</span>
              </summary>
              <div
                style={{
                  marginTop: 12,
                  fontSize: 14,
                  color: "var(--rf-ink-3)",
                  lineHeight: 1.6,
                }}
              >
                {a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

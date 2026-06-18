// Anonymized testimonial — softened from the original's named quote per the
// "no unverifiable social proof" rule. Replace with a real attributed quote
// once a customer signs off on it.

export function Testimonial() {
  return (
    <section className="sect">
      <div className="wrap-narrow" style={{ textAlign: "center" }}>
        <svg
          width="40"
          height="32"
          viewBox="0 0 40 32"
          fill="var(--rf-teal)"
          style={{ opacity: 0.4, marginBottom: 24 }}
          aria-hidden="true"
        >
          <path d="M0 32V18C0 8 6 2 16 0v6c-5 1-8 5-8 10h8v16zm22 0V18C22 8 28 2 38 0v6c-5 1-8 5-8 10h8v16z" />
        </svg>
        <p
          className="display"
          style={{
            fontSize: 36,
            lineHeight: 1.25,
            margin: "0 0 32px",
            color: "var(--rf-ink)",
          }}
        >
          &ldquo;We replaced a whiteboard, two group chats and a separate accounting tool with one
          tab open on RouteFlow. <em>Our drivers leave 40 minutes earlier every morning.</em>&rdquo;
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "linear-gradient(135deg, #C75A3D, #4B2C5E)",
            }}
          />
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>A wholesaler we work with</div>
            <div style={{ fontSize: 13, color: "var(--rf-ink-3)" }}>Central Texas</div>
          </div>
        </div>
      </div>
    </section>
  );
}

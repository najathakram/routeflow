// Retailer app home screen mock — appears inside <PhoneShell>.

export function PhoneRetailerHome() {
  return (
    <div style={{ padding: "8px 14px 14px" }}>
      <div style={{ fontSize: 11, color: "var(--rf-ink-3)" }}>Tuesday, May 12</div>
      <div
        style={{
          fontFamily: "var(--rf-display)",
          fontSize: 22,
          letterSpacing: "-0.02em",
          marginTop: 2,
        }}
      >
        Hello, Sam.
      </div>
      <div
        style={{
          marginTop: 10,
          padding: 12,
          background: "var(--rf-ink)",
          color: "var(--rf-cream)",
          borderRadius: 14,
        }}
      >
        <div
          style={{
            fontSize: 10,
            opacity: 0.6,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Outstanding
        </div>
        <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>$1,890</div>
        <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>across 3 suppliers</div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginTop: 10,
        }}
      >
        {[
          ["Buy stock", "var(--rf-teal)"],
          ["Pay supplier", "#C75A3D"],
          ["Track order", "#4B2C5E"],
          ["My money", "#2A6B4D"],
        ].map(([l, c]) => (
          <div
            key={l}
            style={{
              background: c,
              color: "white",
              padding: "10px 11px",
              borderRadius: 12,
              fontSize: 12,
              fontWeight: 600,
              height: 56,
              display: "flex",
              alignItems: "flex-end",
            }}
          >
            {l}
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          padding: 10,
          background: "var(--rf-paper)",
          border: "1px solid var(--rf-line)",
          borderRadius: 12,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: "var(--rf-ink-3)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Tonight&apos;s order
        </div>
        <div style={{ fontSize: 12, fontWeight: 500, marginTop: 4 }}>Cascade Wholesale</div>
        <div style={{ fontSize: 11, color: "var(--rf-ink-3)", marginTop: 1 }}>
          Out for delivery · ETA 8:30 PM
        </div>
      </div>
    </div>
  );
}

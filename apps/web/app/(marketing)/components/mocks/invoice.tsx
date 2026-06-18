// Stylized invoice mock — shown as proof inside the Product page.

export function MockInvoice() {
  return (
    <div className="card" style={{ padding: 18, fontSize: 11.5 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 14,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--rf-display)",
              fontSize: 22,
              letterSpacing: "-0.02em",
            }}
          >
            Invoice
          </div>
          <div style={{ color: "var(--rf-ink-3)", marginTop: 2 }}>INV-04821 · Apr 12</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: "var(--rf-ink-3)" }}>Total due</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--rf-ink)" }}>$4,820</div>
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--rf-line)", paddingTop: 10 }}>
        {(
          [
            ["Cheerios Family Pack", "24 box", "$1,840"],
            ["Tropicana OJ 64oz", "12 box", "$840"],
            ["Kraft Mac & Cheese", "18 box", "$1,460"],
            ["Morton Salt 26oz", "30 pack", "$680"],
          ] as const
        ).map(([name, qty, amt]) => (
          <div
            key={name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "5px 0",
              color: "var(--rf-ink-2)",
            }}
          >
            <span style={{ flex: 1 }}>{name}</span>
            <span style={{ width: 60, color: "var(--rf-ink-3)", fontSize: 11 }}>{qty}</span>
            <span style={{ width: 70, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              {amt}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 12,
          paddingTop: 12,
          borderTop: "1px solid var(--rf-line)",
        }}
      >
        <div className="chip chip-teal">Auto-generated</div>
        <div className="chip">Sent · 2 hrs ago</div>
      </div>
    </div>
  );
}

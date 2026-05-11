// Retailer app "Shop" screen mock — appears inside <PhoneShell>.
// USD prices throughout (the original design had ₹ prices left over from
// the Indian-context iteration).

export function PhoneShop() {
  return (
    <div style={{ padding: "8px 14px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: 1,
            padding: "8px 12px",
            background: "var(--rf-paper)",
            border: "1px solid var(--rf-line)",
            borderRadius: 12,
            fontSize: 12,
            color: "var(--rf-ink-3)",
          }}
        >
          Search Cascade…
        </div>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: "var(--rf-teal)",
            color: "white",
            display: "grid",
            placeItems: "center",
            fontSize: 14,
          }}
        >
          🎤
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginTop: 12,
        }}
      >
        {[
          ["Cheerios", "$2.40/box", "var(--rf-teal-50)"],
          ["Kraft", "$6.40/box", "#F4ECDB"],
          ["Morton", "$1.92/pk", "#FBE4DC"],
          ["Tropicana", "$5.60/box", "#E8E0F0"],
        ].map(([n, p, bg]) => (
          <div
            key={n}
            style={{
              padding: 10,
              background: "var(--rf-paper)",
              border: "1px solid var(--rf-line)",
              borderRadius: 12,
            }}
          >
            <div style={{ aspectRatio: "1", background: bg, borderRadius: 8, marginBottom: 6 }} />
            <div style={{ fontSize: 11, fontWeight: 600 }}>{n}</div>
            <div style={{ fontSize: 10, color: "var(--rf-ink-3)" }}>{p}</div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 12,
          padding: 10,
          background: "var(--rf-ink)",
          color: "white",
          borderRadius: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 10, opacity: 0.6 }}>4 items · $48.20</div>
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 1 }}>Review order</div>
        </div>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "var(--rf-teal-bright)",
            display: "grid",
            placeItems: "center",
            fontSize: 14,
          }}
        >
          →
        </div>
      </div>
    </div>
  );
}

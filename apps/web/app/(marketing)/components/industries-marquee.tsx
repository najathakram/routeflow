const INDUSTRIES = [
  "FMCG distribution",
  "Beverage routes",
  "Cold chain & dairy",
  "Pharmacy supply",
  "Stationery & books",
  "Hardware & paint",
  "Salon supplies",
  "Restaurant supply",
  "Agri-inputs",
  "Building materials",
];

export function IndustriesMarquee() {
  // Duplicate the list so the marquee animation loops seamlessly
  const items = [...INDUSTRIES, ...INDUSTRIES];

  return (
    <section
      className="sect-sm"
      style={{
        background: "var(--rf-cream-2)",
        overflow: "hidden",
        borderTop: "1px solid var(--rf-line)",
        borderBottom: "1px solid var(--rf-line)",
      }}
    >
      <div className="wrap" style={{ marginBottom: 24 }}>
        <div
          style={{
            fontSize: 12,
            color: "var(--rf-ink-4)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            textAlign: "center",
          }}
        >
          Made for the wholesale trade
        </div>
      </div>
      <div className="marquee">
        {items.map((n, i) => (
          <div
            key={`${n}-${i}`}
            style={{
              fontFamily: "var(--rf-display)",
              fontSize: 38,
              color: "var(--rf-ink-2)",
              whiteSpace: "nowrap",
            }}
          >
            {n}{" "}
            <span style={{ color: "var(--rf-teal)", margin: "0 16px" }}>✦</span>
          </div>
        ))}
      </div>
    </section>
  );
}

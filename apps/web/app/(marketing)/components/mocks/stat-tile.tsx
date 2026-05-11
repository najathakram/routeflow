// Small stat tile used in dashboard mocks (e.g. the finance card on Product page).

export function StatTile({
  label,
  value,
  delta,
  deltaPositive = true,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaPositive?: boolean;
}) {
  return (
    <div
      style={{
        padding: 14,
        background: "var(--rf-paper)",
        border: "1px solid var(--rf-line)",
        borderRadius: 14,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--rf-ink-3)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, letterSpacing: "-0.02em" }}>
        {value}
      </div>
      {delta && (
        <div
          style={{
            fontSize: 11,
            color: deltaPositive ? "var(--rf-teal)" : "var(--rf-rust)",
            marginTop: 2,
            fontWeight: 500,
          }}
        >
          {deltaPositive ? "↑" : "↓"} {delta}
        </div>
      )}
    </div>
  );
}

// Mini orders table — shown as "real product" proof inside the wholesaler card
// of the audience splitter. Stylized, not connected to live data.

type Tone = "teal" | "cream" | "rust";
const TONES: Record<Tone, { bg: string; fg: string }> = {
  teal: { bg: "var(--rf-teal-50)", fg: "var(--rf-teal-deep)" },
  cream: { bg: "#F4ECDB", fg: "#7A5C1F" },
  rust: { bg: "#FBE4DC", fg: "#7A2914" },
};

function OrderMiniRow({
  tone,
  label,
  sub,
  status,
  statusTone,
}: {
  tone: Tone;
  label: string;
  sub: string;
  status: string;
  statusTone?: "teal";
}) {
  const t = TONES[tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderBottom: "1px solid var(--rf-line)",
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          background: t.bg,
          color: t.fg,
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {label.slice(0, 2).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--rf-ink)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--rf-ink-3)" }}>{sub}</div>
      </div>
      <div
        className={`chip ${statusTone === "teal" ? "chip-teal" : ""}`}
        style={{ fontSize: 10.5 }}
      >
        {status}
      </div>
    </div>
  );
}

export function MockOrdersTable() {
  return (
    <div className="card" style={{ width: "100%" }}>
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--rf-line)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>Today&apos;s orders</div>
        <div className="chip chip-teal">8 new</div>
      </div>
      <OrderMiniRow
        tone="teal"
        label="Maple Grocery"
        sub="ORD-2451 · $1,580"
        status="Picking"
        statusTone="teal"
      />
      <OrderMiniRow tone="cream" label="Karim Market" sub="ORD-2450 · $1,040" status="Confirmed" />
      <OrderMiniRow
        tone="rust"
        label="Hayes &amp; Sons"
        sub="ORD-2449 · $3,090"
        status="On route"
        statusTone="teal"
      />
      <OrderMiniRow tone="teal" label="Riverside Deli" sub="ORD-2448 · $594" status="New" />
    </div>
  );
}

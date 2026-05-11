// Stylized route map — shown as proof inside the Product page.

export function MockRouteMap() {
  return (
    <div
      className="card"
      style={{
        padding: 16,
        background: "linear-gradient(135deg, #F2EBDD 0%, #E8E0CD 100%)",
        height: 240,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <svg
        viewBox="0 0 320 200"
        width="100%"
        height="100%"
        style={{
          position: "absolute",
          inset: 16,
          width: "calc(100% - 32px)",
          height: "calc(100% - 32px)",
        }}
        aria-hidden="true"
      >
        {/* Roads */}
        <path
          d="M10 100 Q 80 60, 150 80 T 310 60"
          stroke="#FFF"
          strokeWidth="6"
          fill="none"
          opacity="0.7"
        />
        <path
          d="M40 180 L 100 130 L 200 150 L 280 110"
          stroke="#FFF"
          strokeWidth="5"
          fill="none"
          opacity="0.6"
        />
        <path
          d="M180 20 L 180 200"
          stroke="#FFF"
          strokeWidth="5"
          fill="none"
          opacity="0.5"
        />
        {/* Optimised route */}
        <path
          d="M30 160 L 80 130 L 130 145 L 180 100 L 230 110 L 280 70"
          stroke="var(--rf-teal)"
          strokeWidth="2.5"
          fill="none"
        />
        {/* Stops */}
        {(
          [
            [30, 160, "1", "var(--rf-teal)"],
            [80, 130, "2", "var(--rf-teal)"],
            [130, 145, "3", "var(--rf-teal)"],
            [180, 100, "4", "var(--rf-ink)"],
            [230, 110, "5", "var(--rf-ink-3)"],
            [280, 70, "6", "var(--rf-ink-3)"],
          ] as const
        ).map(([x, y, n, c]) => (
          <g key={n}>
            <circle cx={x} cy={y} r="11" fill="white" stroke={c} strokeWidth="2" />
            <text
              x={x}
              y={y + 3.5}
              textAnchor="middle"
              fontSize="10"
              fontWeight="700"
              fill={c}
            >
              {n}
            </text>
          </g>
        ))}
        {/* Truck */}
        <g transform="translate(125, 140)">
          <rect x="-12" y="-9" width="24" height="14" rx="3" fill="var(--rf-ink)" />
          <text x="0" y="1" textAnchor="middle" fontSize="10" fill="white">
            🚚
          </text>
        </g>
      </svg>
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          padding: "6px 10px",
          background: "rgba(255,255,255,0.9)",
          backdropFilter: "blur(8px)",
          WebkitBackdropFilter: "blur(8px)",
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        Route 04 · Austin · 6 stops
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          padding: "6px 10px",
          background: "var(--rf-ink)",
          color: "var(--rf-cream)",
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        ETA 11:42
      </div>
    </div>
  );
}

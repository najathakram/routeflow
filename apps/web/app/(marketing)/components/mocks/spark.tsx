// Simple sparkline used inside the finance stat card.

export function Spark({
  height = 38,
  color = "var(--rf-teal)",
}: {
  height?: number;
  color?: string;
}) {
  const pts = [12, 18, 15, 24, 22, 30, 28, 36, 32, 42, 40, 48];
  const max = Math.max(...pts);
  const w = 180;
  const path = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = height - (p / max) * (height - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  const area = `${path} L${w},${height} L0,${height} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <path d={area} fill={color} opacity="0.12" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.8" />
    </svg>
  );
}

interface LogoProps {
  size?: number;
  dark?: boolean;
}

// RouteFlow brand mark — "LogoLoop". Two nodes joined by a leaf-shaped loop:
// top arc = stock outbound (ink/cream), bottom arc = money return (teal).
// Solid origin + ringed destination encode the bidirectional, two-sided rail
// between wholesaler and retailer. Inline SVG so the marketing chunk stays
// tiny. Tenant logos (uploaded via branding.logoKey) are unaffected — this
// component only renders the RouteFlow brand mark.
export function Logo({ size = 28, dark = false }: LogoProps) {
  const arc = dark ? "#FAF6EE" : "#0E1F36";
  const accent = "#14a39f";
  const origin = dark ? "#FAF6EE" : "#0E1F36";
  const destFill = dark ? "#0E1F36" : "#FAF6EE";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 14 14 C 40 10, 56 24, 50 50"
        stroke={arc}
        strokeWidth="3.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 14 14 C 8 40, 24 54, 50 50"
        stroke={accent}
        strokeWidth="3.2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="14" cy="14" r="5.5" fill={origin} />
      <circle cx="50" cy="50" r="5.5" fill={destFill} stroke={accent} strokeWidth="3" />
    </svg>
  );
}

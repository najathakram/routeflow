interface LogoProps {
  size?: number;
  dark?: boolean;
}

// RouteFlow brand mark — inline SVG so the marketing chunk stays tiny.
export function Logo({ size = 28, dark = false }: LogoProps) {
  const fg = dark ? "#FAF6EE" : "#0E1F36";
  const bg = dark ? "#FAF6EE" : "#0E1F36";
  const ring = dark ? "#0E1F36" : "#FAF6EE";
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect width="28" height="28" rx="7" fill={bg} />
      <path d="M7 17 C 7 11, 11 7, 17 7" stroke={ring} strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M14 21 L 21 14" stroke={ring} strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.5" />
      <circle cx="21" cy="7" r="3" fill="#14a39f" stroke={fg} strokeWidth="1.5" />
    </svg>
  );
}

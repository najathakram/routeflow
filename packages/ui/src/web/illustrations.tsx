import * as React from "react";

interface IllustrationProps {
  className?: string;
  size?: number;
}

// Shared palette — navy at low opacity for structure, brand-600 as accent
const STROKE = "#1B3A5C";
const ACCENT = "#2563eb";
const MUTED = 0.18; // opacity for secondary strokes

function Svg({
  size = 80,
  className,
  children,
}: {
  size?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function IllustrationNoOrders({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Clipboard body */}
      <rect x="18" y="16" width="44" height="52" rx="5" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      {/* Clipboard clip */}
      <rect x="30" y="12" width="20" height="10" rx="3" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2"/>
      {/* Content lines — dashed to show emptiness */}
      <line x1="28" y1="36" x2="52" y2="36" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3"/>
      <line x1="28" y1="46" x2="46" y2="46" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3"/>
      <line x1="28" y1="56" x2="40" y2="56" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3"/>
      {/* Accent — plus icon at bottom-right */}
      <circle cx="58" cy="58" r="10" fill={ACCENT} fillOpacity="0.12"/>
      <line x1="54" y1="58" x2="62" y2="58" stroke={ACCENT} strokeWidth="2" strokeLinecap="round"/>
      <line x1="58" y1="54" x2="58" y2="62" stroke={ACCENT} strokeWidth="2" strokeLinecap="round"/>
    </Svg>
  );
}

export function IllustrationNoRoutes({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Origin node */}
      <circle cx="22" cy="24" r="7" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      <circle cx="22" cy="24" r="3" fill={STROKE} fillOpacity={MUTED}/>
      {/* Disconnected dashed route line */}
      <path d="M22 31 C22 44 58 36 58 49" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round" strokeDasharray="5 4"/>
      {/* Destination node */}
      <circle cx="58" cy="56" r="7" stroke={ACCENT} strokeWidth="2.5" strokeOpacity="0.6"/>
      <circle cx="58" cy="56" r="3" fill={ACCENT} fillOpacity="0.5"/>
      {/* Question mark — route not planned */}
      <text x="18" y="66" fontFamily="Inter, sans-serif" fontSize="11" fontWeight="600" fill={STROKE} fillOpacity="0.25">?</text>
    </Svg>
  );
}

export function IllustrationNoCustomers({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Person head */}
      <circle cx="40" cy="27" r="12" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      {/* Person body */}
      <path d="M16 68 C16 52 64 52 64 68" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5" strokeLinecap="round"/>
      {/* Accent — plus */}
      <circle cx="60" cy="20" r="9" fill={ACCENT} fillOpacity="0.12"/>
      <line x1="56.5" y1="20" x2="63.5" y2="20" stroke={ACCENT} strokeWidth="2" strokeLinecap="round"/>
      <line x1="60" y1="16.5" x2="60" y2="23.5" stroke={ACCENT} strokeWidth="2" strokeLinecap="round"/>
    </Svg>
  );
}

export function IllustrationNoProducts({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Box front face */}
      <path d="M14 38 L40 24 L66 38 L66 58 L40 72 L14 58 Z" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5" strokeLinejoin="round"/>
      {/* Box top fold lines */}
      <line x1="40" y1="24" x2="40" y2="44" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3"/>
      <line x1="14" y1="38" x2="40" y2="44" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3"/>
      <line x1="66" y1="38" x2="40" y2="44" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round" strokeDasharray="4 3"/>
    </Svg>
  );
}

export function IllustrationNoInvoices({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Document */}
      <rect x="16" y="10" width="40" height="52" rx="4" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      {/* Folded corner */}
      <path d="M44 10 L56 22 L44 22 Z" fill={STROKE} fillOpacity="0.08"/>
      <path d="M44 10 L56 22" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2"/>
      {/* Dollar sign */}
      <text x="32" y="48" fontFamily="Inter, sans-serif" fontSize="20" fontWeight="700" fill={ACCENT} fillOpacity="0.25">$</text>
      {/* Lines */}
      <line x1="24" y1="30" x2="48" y2="30" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round"/>
      <line x1="24" y1="38" x2="42" y2="38" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2" strokeLinecap="round"/>
    </Svg>
  );
}

export function IllustrationNoDrivers({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Van/truck body */}
      <rect x="8" y="32" width="52" height="24" rx="4" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      {/* Cab */}
      <path d="M50 32 L60 32 L68 44 L68 56 L60 56" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5" strokeLinejoin="round"/>
      {/* Windscreen */}
      <path d="M52 33 L60 33 L66 43 L52 43 Z" fill={STROKE} fillOpacity="0.06"/>
      {/* Wheels */}
      <circle cx="22" cy="58" r="7" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      <circle cx="22" cy="58" r="3" fill={STROKE} fillOpacity="0.1"/>
      <circle cx="56" cy="58" r="7" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      <circle cx="56" cy="58" r="3" fill={STROKE} fillOpacity="0.1"/>
    </Svg>
  );
}

export function IllustrationNoReturns({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Circle arrow */}
      <path
        d="M56 40 A18 18 0 1 1 46 22"
        stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5" strokeLinecap="round"
      />
      {/* Arrowhead */}
      <polyline points="40,14 46,22 38,26" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
      {/* Box in center */}
      <rect x="30" y="33" width="18" height="14" rx="2" stroke={ACCENT} strokeWidth="2" strokeOpacity="0.5"/>
      <line x1="30" y1="40" x2="48" y2="40" stroke={ACCENT} strokeWidth="1.5" strokeOpacity="0.5" strokeLinecap="round"/>
    </Svg>
  );
}

export function IllustrationInboxZero({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Envelope body */}
      <rect x="10" y="22" width="60" height="40" rx="5" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5"/>
      {/* Envelope flap open */}
      <path d="M10 22 L40 44 L70 22" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2.5" strokeLinejoin="round"/>
      {/* Checkmark — inbox zero! */}
      <circle cx="56" cy="56" r="13" fill={ACCENT} fillOpacity="0.12"/>
      <polyline points="49,56 54,62 63,50" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </Svg>
  );
}

export function IllustrationNoData({ size, className }: IllustrationProps) {
  return (
    <Svg size={size} className={className}>
      {/* Bar chart */}
      <rect x="12" y="44" width="12" height="20" rx="2" fill={STROKE} fillOpacity="0.1" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2"/>
      <rect x="30" y="30" width="12" height="34" rx="2" fill={STROKE} fillOpacity="0.1" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2"/>
      <rect x="48" y="18" width="12" height="46" rx="2" fill={STROKE} fillOpacity="0.1" stroke={STROKE} strokeOpacity={MUTED} strokeWidth="2"/>
      {/* Slash — no data */}
      <line x1="62" y1="14" x2="18" y2="66" stroke={ACCENT} strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round"/>
    </Svg>
  );
}

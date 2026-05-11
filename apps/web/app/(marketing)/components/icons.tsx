import type { SVGProps } from "react";

// Marketing-only inline SVG icon set. Kept here (not lucide-react) so the
// marketing chunk stays small and the visual style matches the design.

const stroked = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ArrowIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroked} {...props}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3 8.5l3 3 7-7.5" />
    </svg>
  );
}

export function AppleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...props}>
      <path d="M11.6 8.5c0-1.7 1.4-2.5 1.4-2.6-.8-1.1-2-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.2-.6c-1.1 0-2.2.7-2.8 1.7-1.2 2.1-.3 5.2.9 6.9.6.8 1.3 1.7 2.2 1.7s1.2-.6 2.3-.6 1.4.6 2.3.6c1 0 1.6-.8 2.2-1.6.7-.9 1-1.8 1-1.9-.1 0-1.9-.7-2-2.9zM10 3.5c.5-.6.8-1.4.7-2.2-.7 0-1.5.5-2 1.1-.4.5-.8 1.3-.7 2.1.8.1 1.6-.4 2-1z" />
    </svg>
  );
}

export function AndroidIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...props}>
      <path d="M3.5 7v4.5c0 .3.2.5.5.5h.5v1.5c0 .6.4 1 1 1s1-.4 1-1V12h2v1.5c0 .6.4 1 1 1s1-.4 1-1V12h.5c.3 0 .5-.2.5-.5V7H3.5zm-1 0c-.6 0-1 .4-1 1v3c0 .6.4 1 1 1s1-.4 1-1V8c0-.6-.4-1-1-1zm11 0c-.6 0-1 .4-1 1v3c0 .6.4 1 1 1s1-.4 1-1V8c0-.6-.4-1-1-1zm-2-1.5c0-1.5-1-2.7-2.4-3.2l.7-1.2c.1-.1 0-.3-.1-.3s-.3 0-.3.1l-.7 1.2C7.9 2 7 2 6.3 2.1l-.7-1.2c-.1-.1-.2-.2-.3-.1s-.2.2-.1.3l.7 1.2C4.5 2.8 3.5 4 3.5 5.5h9zM6 4.5c-.3 0-.5-.2-.5-.5s.2-.5.5-.5.5.2.5.5-.2.5-.5.5zm4 0c-.3 0-.5-.2-.5-.5s.2-.5.5-.5.5.2.5.5-.2.5-.5.5z" />
    </svg>
  );
}

export function CartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...stroked} {...props}>
      <path d="M3 4h2l2.5 11h11l2-8H7" />
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="17" cy="20" r="1.5" />
    </svg>
  );
}

export function ReceiptIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...stroked} {...props}>
      <path d="M5 3v18l3-2 3 2 3-2 3 2 3-2V3z" />
      <path d="M9 8h8M9 12h8M9 16h5" />
    </svg>
  );
}

export function RouteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...stroked} {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8 6h6a4 4 0 0 1 0 8H10a4 4 0 0 0 0 8h6" />
    </svg>
  );
}

export function ChartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...stroked} {...props}>
      <path d="M4 20V8M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

export function UsersIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...stroked} {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M22 19c0-2.5-2-4.5-5-4.5" />
    </svg>
  );
}

export function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...stroked} {...props}>
      <path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function LinkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...stroked} {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

import { ImageIcon } from "lucide-react";

// A visible, honest stand-in for a real product screenshot that hasn't been
// captured yet. Never render a stock photo here as a substitute (owner
// ruling 2026-09-17) — a separate ticket tracks capturing the real
// screenshots from the demo tenant.
export function ScreenshotPlaceholder({
  label,
  aspect = "16 / 10",
}: {
  label: string;
  aspect?: string;
}) {
  return (
    <div className="screenshot-placeholder" style={{ aspectRatio: aspect }}>
      <ImageIcon size={26} aria-hidden="true" />
      <p>{label}</p>
      <span>Screenshot pending — real product capture tracked separately</span>
    </div>
  );
}

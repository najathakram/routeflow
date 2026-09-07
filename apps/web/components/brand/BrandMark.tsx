import Link from "next/link";
import { cn } from "@routeflow/ui/web";

// The one shared brand mark — replaces every per-site logo treatment (marketing
// nav/footer inline SVG, the login page's duplicated inline SVG, the 404 "RF"
// monogram, the platform-admin Shield icon, and every legacy per-brand static
// <img> site). See ux-spec.md §2.
export const BRAND_MARK_SRC = "/brand/routeflow-mark-192.png";

/**
 * Surface tone the mark sits on. The shipped PNG is dark-navy ink on
 * transparency, so it reads at ~2:1 on the dark shells (login panel, buyer
 * portal / platform-admin sidebars). `"light"` inverts the ink to white
 * instead of shipping a second binary — see fix-round-3 ruling B2.
 */
export type BrandTone = "dark" | "light";

interface BrandMarkProps {
  /** Pixel size of the square mark. Defaults to the marketing header size. */
  size?: number;
  className?: string;
  /** `"light"` = white ink, for dark surfaces. Defaults to `"dark"`. */
  tone?: BrandTone;
}

export function BrandMark({ size = 34, className, tone = "dark" }: BrandMarkProps = {}) {
  return (
    // Deliberately a plain <img>, NOT next/image: apps/web builds with
    // `output: "standalone"` and ships no `images` config, so a next/image
    // render would emit `/_next/image?...` optimizer requests the production
    // image was never built to serve (fix-round-3 ruling B1). The static guard
    // `apps/web/components/no-next-image.test.ts` keeps it that way.
    // eslint-disable-next-line @next/next/no-img-element -- see above; alt="" decorative
    <img
      src={BRAND_MARK_SRC}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      className={cn(
        "brand-mark",
        // brightness(0) collapses the navy ink to black, invert(1) lifts it to
        // white; the alpha channel is untouched, so the mark still composites.
        // `brand-mark--light` carries NO styles of its own — it exists purely as
        // a selector hook for marketing.css's
        // `.rf-marketing .brand-mark:not(.brand-mark--light)` multiply scoping
        // (globals.css stays byte-identical to the branch base — MKT-PIN T7).
        tone === "light" && "brand-mark--light brightness-0 invert",
        className,
      )}
    />
  );
}

interface BrandSignatureProps {
  size?: number;
  className?: string;
  markClassName?: string;
  /**
   * Accent color for the trailing period. Left unset by default so the
   * stylesheet owns it — inside `.rf-marketing` that is the ported
   * `.brand-period` cascade (ux-spec §2), elsewhere the period simply
   * inherits its wrapper's color. Pass an explicit color only where no rule
   * covers the surface and the inherited one would have low contrast
   * (e.g. the login page's teal/navy panel).
   */
  periodColor?: string;
  /**
   * Opt in to the marketing header's type metrics on surfaces that do NOT
   * load the `.rf-marketing` cascade (login, signup, 404, platform admin…),
   * so the signature is self-contained there. Left off inside
   * `.rf-marketing`, where the stylesheet's own `.brand` / `.passport-brand`
   * sizes must keep winning by inheritance (ux-spec §2).
   */
  standalone?: boolean;
  /**
   * `"light"` inverts the mark to white ink AND paints the wordmark cream, for
   * the dark shells (login panel, buyer/platform-admin sidebars). `periodColor`
   * still wins for the trailing period. Defaults to `"dark"` (ruling B2).
   */
  tone?: BrandTone;
}

export function BrandSignature({
  size,
  className,
  markClassName,
  periodColor,
  standalone = false,
  tone = "dark",
}: BrandSignatureProps = {}) {
  return (
    <span
      className={cn(
        // Layout is unconditional and value-identical to
        // `.rf-marketing .brand-signature`, so marketing surfaces are unchanged.
        "brand-signature inline-flex items-center gap-[9px]",
        standalone && "text-[1.48rem] font-[650] leading-none tracking-[-0.065em]",
        className,
      )}
    >
      <BrandMark size={size} className={markClassName} tone={tone} />
      <span className={cn("brand-wordmark", tone === "light" && "text-[#FAF6EE]")}>
        routeflow
        <span className="brand-period" style={periodColor ? { color: periodColor } : undefined}>
          .
        </span>
      </span>
    </span>
  );
}

interface BrandProps {
  size?: number;
  className?: string;
  /** Forwarded to `BrandSignature` — `"light"` for dark surfaces (ruling B2). */
  tone?: BrandTone;
}

export function Brand({ size, className, tone = "dark" }: BrandProps = {}) {
  return (
    <Link href="/" aria-label="RouteFlow home" className={className}>
      <BrandSignature size={size} tone={tone} />
    </Link>
  );
}

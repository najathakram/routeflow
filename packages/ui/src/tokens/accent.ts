/**
 * The per-surface accent ramp, shared by web and native (#2330).
 *
 * Web's `TenantProvider` derives `--primary-strong/deep/soft` from a tenant's brand colour with
 * `shadeHex`; native's theme derives the same ramp from the same function, so a re-branded tenant
 * looks the same on both. Plain data and math only: no platform code.
 */
import { ledgerAccents, type LedgerAccent, type LedgerSurface } from "./ledger";

const HEX6 = /^#?[0-9a-f]{6}$/i;

/**
 * Mix a `#rrggbb` colour toward black (amount < 0) or white (amount > 0) by |amount|. This is
 * web's original `shade()` verbatim (pinned byte-identical by
 * `apps/web/components/tenant-provider-ramp.test.ts`): it returns the input unchanged only when a
 * channel fails to parse.
 */
export function shadeHex(hex: string, amount: number): string {
  const clean = hex.replace("#", "");
  const ch = [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4, 6)].map((h) => parseInt(h, 16));
  if (ch.some((n) => isNaN(n))) return hex;
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return (
    "#" +
    ch
      .map((c) =>
        Math.round(c + (target - c) * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/** The mix amounts web applies to a custom tenant brand (strong / deep / soft). */
export const TENANT_SHADE = { strong: -0.14, deep: -0.28, soft: 0.9 } as const;

/**
 * The accent ramp for a surface. The buyer surface is always emerald. The operator surface uses
 * the Ledger teal ramp unless the tenant has a valid custom brand colour, in which case the ramp
 * is derived from it exactly as web does. `mist` stays static, as on web.
 */
export function accentForSurface(
  surface: LedgerSurface,
  tenantPrimary?: string | null,
): LedgerAccent {
  if (surface === "buyer") return ledgerAccents.buyer;
  const base = ledgerAccents.operator;
  if (!tenantPrimary || !HEX6.test(tenantPrimary)) return base;
  const primary = tenantPrimary.startsWith("#") ? tenantPrimary : `#${tenantPrimary}`;
  return {
    accent: primary,
    strong: shadeHex(primary, TENANT_SHADE.strong),
    deep: shadeHex(primary, TENANT_SHADE.deep),
    soft: shadeHex(primary, TENANT_SHADE.soft),
    mist: base.mist,
  };
}

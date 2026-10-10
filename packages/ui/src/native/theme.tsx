/**
 * The native runtime theme (#2330, plan §2.2 item 5): web's per-surface `--accent*` and
 * `--row-h` / `--text-body` knobs as a React context. Kit components read the accent and density
 * from `useTheme()` and everything else from the static tokens.
 *
 * The context lives here; the provider logic (which surface, which tenant) lives in
 * `apps/mobile/lib/theme.tsx`.
 */
import { createContext, useContext } from "react";
import { accentForSurface } from "../tokens/accent";
import {
  ledgerDensity,
  ledgerSurface,
  type LedgerAccent,
  type LedgerSurface,
} from "../tokens/ledger";

export interface NativeTheme {
  surface: LedgerSurface;
  accent: LedgerAccent;
  /** Text on an accent fill: web `--primary-foreground` (#fff). Contrast is #2382. */
  onAccent: string;
  density: { rowHeight: number; textBody: number };
}

export interface NativeThemeInput {
  surface: LedgerSurface;
  /** Tenant `primaryColor`; only the operator surface uses it. */
  tenantPrimary?: string | null;
}

export function buildNativeTheme({ surface, tenantPrimary }: NativeThemeInput): NativeTheme {
  return {
    surface,
    accent: accentForSurface(surface, tenantPrimary),
    onAccent: ledgerSurface.paper,
    density: ledgerDensity[surface],
  };
}

/** Default = the operator surface with the Ledger teal, so a missing provider still renders. */
export const ThemeContext = createContext<NativeTheme>(buildNativeTheme({ surface: "operator" }));

export function useTheme(): NativeTheme {
  return useContext(ThemeContext);
}

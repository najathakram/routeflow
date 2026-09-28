import { useMemo, type ReactNode } from "react";
import { useSegments } from "expo-router";
import { ThemeContext, buildNativeTheme } from "@routeflow/ui/native";
import { useTenantStore } from "./tenant-store";
import { surfaceForSegments } from "./theme-surface";

/**
 * Provider logic only (#2330): picks the surface from the current route group and the tenant's
 * brand colour from the tenant store, then hands both to the shared theme builder. The context
 * and `useTheme()` live in `@routeflow/ui/native`.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const segments = useSegments();
  const surface = surfaceForSegments(segments);
  const tenantPrimary = useTenantStore((s) => s.branding?.primaryColor ?? null);
  const theme = useMemo(
    () => buildNativeTheme({ surface, tenantPrimary }),
    [surface, tenantPrimary],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

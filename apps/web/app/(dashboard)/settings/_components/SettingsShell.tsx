"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { RailBoundary } from "./RailBoundary";
import { SettingsRail } from "./SettingsRail";
import { useDesktopRail } from "./use-desktop-rail";
import { useHashScroll } from "./use-hash-scroll";

function HashScroll() {
  const key = `${usePathname()}?${useSearchParams().toString()}`;
  useHashScroll(key);
  return null;
}

/**
 * Wraps every /settings screen. Staff at xl and up get the rail beside the screen (it stays while a section or
 * a sub-route is open; a throw inside it hides the whole rail column, not the screen, and retries on navigation); below xl, and for CUSTOMER / DRIVER (who only ever see My account), the screen alone.
 * Anchors (`#delivery-method`, `#route-defaults`...) scroll into view once their card mounts, with an offset.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const desktop = useDesktopRail();
  const staff = !!user && user.role !== "CUSTOMER" && user.role !== "DRIVER";
  const rail = staff && desktop;
  return (
    <div className={rail ? "mx-auto flex max-w-[1240px] items-start gap-6 px-6 pt-6" : undefined}>
      {staff && (
        <React.Suspense fallback={null}>
          <HashScroll />
        </React.Suspense>
      )}
      {rail && (
        <RailBoundary resetKey={pathname}>
          <aside className="sticky top-4 max-h-[calc(100vh-6rem)] w-[300px] flex-none overflow-y-auto">
            <React.Suspense fallback={null}>
              <SettingsRail isAdmin={user?.role === "TENANT_ADMIN"} />
            </React.Suspense>
          </aside>
        </RailBoundary>
      )}
      <div
        id="settings-content"
        tabIndex={-1}
        className="min-w-0 flex-1 focus:outline-none [&_[id]]:scroll-mt-28"
      >
        {children}
      </div>
    </div>
  );
}

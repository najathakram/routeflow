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
  // Row 468: the two-column layout and the rail's track are CSS (xl:), so they exist from the first paint
  // and the screen never shifts when the rail mounts; only the rail's CONTENTS wait for the client to know
  // it is xl (useDesktopRail reads false on the server and the first paint).
  return (
    <div
      className={
        staff
          ? "xl:mx-auto xl:flex xl:max-w-[1240px] xl:items-start xl:gap-6 xl:px-6 xl:pt-6"
          : undefined
      }
    >
      {staff && (
        <React.Suspense fallback={null}>
          <HashScroll />
        </React.Suspense>
      )}
      {staff && (
        <RailBoundary resetKey={pathname}>
          {/* a plain column: the rail's own <nav aria-label="Settings"> is the one landmark (no aside + nav pair);
              a throw inside drops the whole column via the boundary, so no empty track is left behind */}
          <div
            data-testid="settings-rail-track"
            className="sticky top-4 hidden max-h-[calc(100vh-6rem)] w-[300px] flex-none overflow-y-auto xl:block"
          >
            {desktop && (
              <React.Suspense fallback={null}>
                <SettingsRail isAdmin={user?.role === "TENANT_ADMIN"} />
              </React.Suspense>
            )}
          </div>
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

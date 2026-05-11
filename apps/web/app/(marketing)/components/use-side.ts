"use client";

import { usePathname } from "next/navigation";

export type Side = "neutral" | "retailer" | "wholesaler";

// URL → side mapping. Server-rendered via the layout from `pathname`,
// so the wrapper `data-side` is correct on first paint (no flash).
export function getSideFromPath(pathname: string): Side {
  if (pathname === "/retailers" || pathname.startsWith("/retailers/")) return "retailer";
  if (
    pathname === "/wholesalers" ||
    pathname.startsWith("/wholesalers/") ||
    pathname === "/distributors" ||
    pathname.startsWith("/distributors/") ||
    pathname === "/pricing" ||
    pathname.startsWith("/pricing/")
  )
    return "wholesaler";
  return "neutral";
}

export function useSide(): Side {
  const pathname = usePathname();
  return getSideFromPath(pathname);
}

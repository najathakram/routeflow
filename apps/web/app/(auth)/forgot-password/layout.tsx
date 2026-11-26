import type { Metadata } from "next";
import type { ReactNode } from "react";
import { frontDoorMetadata, frontDoorViewport } from "@/lib/front-door-metadata";

// Site audit 2026-11-02: a form page, not one to find in search. It gets its own title and stays out
// of the index. The rest of the head comes from the brand seam (lib/front-door-metadata.ts).
export const metadata: Metadata = frontDoorMetadata({
  page: "Reset your password",
  robots: { index: false, follow: false },
});
export const viewport = frontDoorViewport;

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}

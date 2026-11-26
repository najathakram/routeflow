import type { Metadata } from "next";
import type { ReactNode } from "react";
import { frontDoorMetadata, frontDoorViewport } from "@/lib/front-door-metadata";

// The page is a client component, so its head lives in this layout. Same title as before (the bare
// name); the share block, icons, app-bar title and browser-bar colour come from the brand seam
// instead of the root layout (lib/front-door-metadata.ts).
export const metadata: Metadata = frontDoorMetadata();
export const viewport = frontDoorViewport;

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}

import type { Metadata } from "next";
import type { ReactNode } from "react";

// Site audit 2026-11-02: a form page, not one to find in search. It gets its own title (the root
// layout adds " · RouteFlow") and stays out of the index.
export const metadata: Metadata = {
  title: "Start your free trial",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}

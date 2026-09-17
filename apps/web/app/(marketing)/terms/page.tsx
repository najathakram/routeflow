import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { routes, site } from "../lib/site";
import { Eyebrow } from "../components/marketing";

// Interim shell — spec.md R9 (not the redesign's placeholder legal clauses).
// `/terms` is a legal shell excluded from the sitemap and opted out of
// indexing.

const route = routes.find((r) => r.slug === "terms")!;

export const metadata: Metadata = {
  title: route.title,
  description: route.description,
  alternates: { canonical: "/terms" },
  robots: { index: false, follow: true },
  openGraph: {
    title: route.title,
    description: route.description,
    url: "/terms",
    siteName: site.name,
    type: "website",
  },
};

export default function TermsPage() {
  return (
    <div className="glass-page">
      <section className="legal-page wrap">
        <Eyebrow>ROUTEFLOW</Eyebrow>
        <h1>Terms information</h1>
        <p>
          Our terms of service are being finalised. For any question about the terms of service,
          contact <a href={`mailto:${site.email}`}>{site.email}</a>.
        </p>
        <Link href="/" className="text-link">
          Return to RouteFlow <ArrowRight size={18} />
        </Link>
      </section>
    </div>
  );
}

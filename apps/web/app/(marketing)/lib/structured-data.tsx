// JSON-LD for the home page (W8): the organization and the software. No ratings, reviews or
// offers: nothing here is a claim the site doesn't already make. Words: the share line from
// COPY.md section 8; the address and logo are the site's own.

import { SHARE_IMAGE_LINES } from "./metadata";
import { site } from "./site";

export function structuredData() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${site.origin}/#organization`,
        name: site.name,
        url: site.origin,
        logo: `${site.origin}/brand/routeflow-mark-512.png`,
        email: site.email,
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${site.origin}/#software`,
        name: site.name,
        url: site.origin,
        description: SHARE_IMAGE_LINES.line,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        publisher: { "@id": `${site.origin}/#organization` },
      },
    ],
  };
}

export function StructuredData() {
  // "<" is escaped so no text in the data can close the script tag early.
  const json = JSON.stringify(structuredData()).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

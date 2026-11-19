// The home page's structured data, as the {{brand:key}} template the page carries. The one place
// alternateName is derived (SA-1178); scripts/sync-site-port.mjs writes it into home.html and
// apps/web/lib/site-port-tokens.test.ts proves the committed page equals it.
"use strict";

/** The `<script type="application/ld+json">` element for the home page. Every value is a token, so
 *  the page follows the brand file. alternateName is the everyday name and the former name,
 *  duplicates and the official name removed, and is left out when empty. */
function homeJsonLd(brand) {
  const alternateName = [brand.name, brand.formerly]
    .filter((n, i, all) => all.indexOf(n) === i && n !== brand.officialName)
    .map((n) => (n === brand.name ? "{{brand:name}}" : "{{brand:formerly}}"));
  const alt = alternateName.length ? { alternateName } : {};
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "{{brand:origin}}/#organization",
        name: "{{brand:officialName}}",
        ...alt,
        legalName: "{{brand:legalEntity}}",
        url: "{{brand:origin}}",
        logo: "{{brand:origin}}{{brand:icon.512}}",
        email: "{{brand:email}}",
      },
      {
        "@type": "SoftwareApplication",
        "@id": "{{brand:origin}}/#software",
        name: "{{brand:officialName}}",
        ...alt,
        url: "{{brand:origin}}",
        description: "{{brand:shareLine}}",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        publisher: { "@id": "{{brand:origin}}/#organization" },
      },
    ],
  };
  const escaped = JSON.stringify(graph).replace(/</g, String.fromCharCode(92) + "u003c");
  return `<script type="application/ld+json">${escaped}</script>`;
}

/** The brand keys whose value is placed in the script. Script content is raw text, so the page
 *  renderer's HTML escaping (&amp; &#39; ...) would reach crawlers literally: a value with any of
 *  & < > " ' is refused until a JSON mode exists. Returns the offending keys. */
function unsafeJsonLdKeys(brand, template = homeJsonLd(brand)) {
  const keys = [...new Set([...template.matchAll(/\{\{brand:([^{}]*)\}\}/g)].map((m) => m[1]))];
  return keys.filter((k) => {
    const v = k.split(".").reduce((at, part) => (at == null ? at : at[part]), brand);
    return typeof v === "string" && /[&<>"']/.test(v);
  });
}

module.exports = { homeJsonLd, unsafeJsonLdKeys };

#!/usr/bin/env node
// Re-sync the ready-made marketing pages (home, pricing, product, landing, the four deep pages:
// getting-started, does-and-doesnt, data-in-and-out, security, and company and contact) from the design source
// into apps/web/public/site, applying the port edits: real auth routes, /site/ asset paths,
// canonical + share tags, no HTML comments, noindex only on /landing.
//
//   node scripts/sync-site-port.mjs --from <design source dir>
//
// The source is the machine-local design package (local-assets/website-design-...). Wording,
// layout, styles and scripts are copied as they are: edit the source, never public/site. The
// subset font in public/site/fonts is left alone. Afterwards run the pin:
//   npm test -w apps/web -- static-site
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const fromAt = argv.indexOf("--from");
if (fromAt < 0 || !argv[fromAt + 1]) {
  console.error("usage: node scripts/sync-site-port.mjs --from <design source dir>");
  process.exit(2);
}
const SRC = path.resolve(argv[fromAt + 1]);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DST = path.join(ROOT, "apps/web/public/site");
if (!fs.existsSync(path.join(SRC, "index.html"))) {
  console.error(`not a design source (no index.html): ${SRC}`);
  process.exit(2);
}
const ORIGIN = "https://www.routeflow.info";

const copy = (rel) => {
  const to = path.join(DST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), to);
};

for (const rel of [
  "css/site.css",
  "css/home.css",
  "css/home-up.css",
  "css/home-color.css",
  "css/color-deep.css",
  "css/product.css",
  "css/does.css",
  "css/start.css",
  "css/company.css",
  "js/prices.js",
  "js/site.js",
  "js/product.js",
  "js/home-up.js",
  "js/auth-nav.js",
  "js/vendor/gsap.min.js",
  "js/vendor/ScrollTrigger.min.js",
  "js/vendor/SplitText.min.js",
  "graphics/rf-graphics.css",
  "graphics/rf-wheel-up.css",
  "graphics/rf-wheel-up.js",
  "img/routeflow-mark-64.png",
  "img/routeflow-mark-192.png",
]) {
  copy(rel);
}

// source file -> [served file, route, indexable]
const pages = [
  ["index.html", "home.html", "/", true],
  ["pricing/index.html", "pricing.html", "/pricing", true],
  ["product/index.html", "product.html", "/product", true],
  ["landing/index.html", "landing.html", "/landing", false],
  ["getting-started/index.html", "getting-started.html", "/getting-started", true],
  ["does-and-doesnt/index.html", "does-and-doesnt.html", "/does-and-doesnt", true],
  ["data-in-and-out/index.html", "data-in-and-out.html", "/data-in-and-out", true],
  ["security/index.html", "security.html", "/security", true],
  ["company/index.html", "company.html", "/company", true],
  ["contact/index.html", "contact.html", "/contact", true],
];

// The four deep pages (source folder name = served route).
const DEEP_SLUGS = [
  "getting-started",
  "does-and-doesnt",
  "data-in-and-out",
  "security",
  "company",
  "contact",
];

function port(html, route, indexable) {
  let h = html;
  // internal notes in HTML comments stay out of the shipped page
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  // real auth and legal routes instead of the preview's absolute address
  h = h.replace(
    /https:\/\/www\.routeflow\.info\/(signup|login|buyer\/login|terms|privacy)\b/g,
    "/$1",
  );
  // The Enterprise button opens an email to the contact address (the source jumps to a line on
  // the same page).
  h = h.replace(
    /href="#contact"( data-track="enterprise_click")/g,
    'href="mailto:hello@routeflow.info"$1',
  );
  // page-to-page links
  h = h.replace(
    /href="(?:\.\.\/)?pricing\/index\.html(#[^"]*)?"/g,
    (_, a) => `href="/pricing${a ?? ""}"`,
  );
  h = h.replace(
    /href="(?:\.\.\/)?product\/index\.html(#[^"]*)?"/g,
    (_, a) => `href="/product${a ?? ""}"`,
  );
  for (const slug of DEEP_SLUGS) {
    h = h.replace(
      new RegExp(`href="(?:\\.\\./)?${slug}/index\\.html(#[^"]*)?"`, "g"),
      (_, a) => `href="/${slug}${a ?? ""}"`,
    );
  }
  h = h.replace(/href="(?:\.\.\/)?index\.html(#[^"]*)?"/g, (_, a) => `href="/${a ?? ""}"`);
  // assets: every relative reference lands under /site/
  h = h.replace(
    /\b(href|src)="(?:\.\.\/)?((?:css|js|graphics|fonts|img)\/[^"]+)"/g,
    '$1="/site/$2"',
  );
  h = h.replace(/url\((?:\.\.\/)?(fonts\/[^)]+)\)/g, "url(/site/$1)");
  if (indexable) {
    h = h.replace(/<meta name="robots" content="noindex,nofollow">\n?/, "");
  }
  // canonical + share tags, as the old pages carried through Next metadata
  const title = (h.match(/<title>([^<]*)<\/title>/) ?? [])[1];
  const desc = (h.match(/<meta name="description" content="([^"]*)">/) ?? [])[1];
  const img = `${ORIGIN}/opengraph-image`;
  const alt = "RouteFlow. Wholesale software for orders and delivery.";
  let extra =
    `<link rel="canonical" href="${ORIGIN}${route}">
` +
    `<meta property="og:site_name" content="RouteFlow">
<meta property="og:type" content="website">
` +
    `<meta property="og:url" content="${ORIGIN}${route}">
<meta property="og:title" content="${title}">
` +
    `<meta property="og:description" content="${desc}">
` +
    `<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
` +
    `<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
` +
    `<meta property="og:image:alt" content="${alt}">
` +
    `<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
` +
    `<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${img}">
`;
  if (route === "/") {
    const graph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": `${ORIGIN}/#organization`,
          name: "RouteFlow",
          url: ORIGIN,
          logo: `${ORIGIN}/brand/routeflow-mark-512.png`,
          email: "hello@routeflow.info",
        },
        {
          "@type": "SoftwareApplication",
          "@id": `${ORIGIN}/#software`,
          name: "RouteFlow",
          url: ORIGIN,
          description: "Wholesale software for orders and delivery.",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          publisher: { "@id": `${ORIGIN}/#organization` },
        },
      ],
    };
    extra += `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\u003c")}</script>
`;
  }
  h = h.replace(/(<meta name="description" content="[^"]*">\n)/, `$1${extra}`);
  return h;
}

for (const [from, to, route, indexable] of pages) {
  const html = fs.readFileSync(path.join(SRC, from), "utf8");
  const out = port(html, route, indexable);
  fs.writeFileSync(path.join(DST, to), out);
  const left = out.match(/(?:href|src)="(?!#|\/|mailto:|data:)[^"]*"/g) ?? [];
  console.log(
    to,
    out.length,
    "bytes; relative refs left:",
    left.length,
    left.slice(0, 5).join(" "),
  );
}

// The brand mapping of scripts/sync-site-port.mjs, kept in its own file so a Jest test can run it
// (apps/web/lib/site-port-tokens.test.ts). Every place a ported page names the brand becomes a
// {{brand:key}} token, longest value first so the share line and the origin are taken whole before
// the bare name. The test proves the committed pages come back byte for byte.
"use strict";

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Identifiers that carry the old spelling on purpose (the same list T35 allows); left as they are.
const ALLOWED_IDENTIFIERS = ["RouteFlowShell", "routeflow-v4", "/brand/routeflow-mark"];

function tokenise(html, brand) {
  let h = html;
  h = h.split(`${brand.name}. ${brand.shareLine}`).join("{{brand:name}}. {{brand:shareLine}}");
  h = h.split(brand.origin).join("{{brand:origin}}");
  h = h.split(brand.email).join("{{brand:email}}");
  h = h.replace(
    new RegExp(`<link rel="icon" href="${escapeRe(brand.icon.favicon)}"`, "g"),
    '<link rel="icon" href="{{brand:icon.favicon}}"',
  );
  h = h.split(brand.logo.onLight).join("{{brand:logo.onLight}}");
  h = h.replace(
    new RegExp(`${escapeRe(brand.titleSeparator)}${escapeRe(brand.name)}(?=</title>|">)`, "g"),
    "{{brand:titleSeparator}}{{brand:name}}",
  );
  // The bare name: whole words only. Not after a letter, digit, dot, @ or slash (a host, an address,
  // a path) and not before a letter, digit or a dot-and-letter (an identifier that starts with the
  // name, a host).
  h = h.replace(
    new RegExp(`(?<![\\w.@/])${escapeRe(brand.name)}(?!\\w|\\.\\w)`, "g"),
    "{{brand:name}}",
  );
  // Anything of the name still there is in a place a token would corrupt (a URL, an identifier):
  // stop, so the page is fixed in the design source rather than shipped half-tokenised.
  let rest = h.replace(/\{\{brand:[^}]*\}\}/g, "");
  for (const id of ALLOWED_IDENTIFIERS) rest = rest.split(id).join("");
  const at = rest.search(new RegExp(escapeRe(brand.name), "i"));
  if (at >= 0) {
    throw new Error(`cannot tokenise the name near "${rest.slice(Math.max(0, at - 20), at + 30)}"`);
  }
  return h;
}

module.exports = { escapeRe, tokenise };

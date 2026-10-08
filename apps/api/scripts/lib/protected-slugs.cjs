// Protected-tenant list for live-capable scripts (row 195, SA-756r).
//
// A new trial tenant is not "paying" and has no Stripe subscription yet, so the paying/Stripe arms
// of paying-tenant.cjs cannot protect it. The operator names such tenants in the environment:
//
//   PROTECTED_TENANT_SLUGS=slug-a,slug-b     (comma-separated; set it on the Railway service / shell)
//
// This module turns that string into a validated Set, or THROWS. It never prints a slug: every
// message below is fixed text plus an entry INDEX, because a slug is a client identifier and must
// not reach a log, a PR or a test output.
//
// Rules:
//   - unset + a target that is not provably local  -> throw (a prod run must say what it protects)
//   - unset + a provably local target              -> empty Set
//   - "" (set, empty)                              -> explicit "none", empty Set, any target
//   - set                                          -> ALWAYS applied, even on a local-looking target
//                                                    (a tunnel can make production look local)
//   - an invalid entry, a test-pattern slug or a duplicate -> throw: refuse everything
//
// Pure: no connection, no logging, no exit.

"use strict";

const { classifyDbTarget } = require("./production-guard.js");
const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const UNSET_ON_NON_LOCAL_MESSAGE =
  "PROTECTED_TENANT_SLUGS is not set and the database target is not provably local: refusing. " +
  'Set it to the comma-separated slugs that must never be touched, or to "" to state that none exist.';

/**
 * @param {Record<string, string | undefined>} env
 * @param {string | null | undefined} dbUrl the URL the script will ACTUALLY dial (after its own fallbacks)
 * @returns {Set<string>} lower-cased, trimmed, validated slugs
 */
function loadProtectedSlugs(env, dbUrl) {
  const raw = env.PROTECTED_TENANT_SLUGS;
  if (raw === undefined) {
    if (!classifyDbTarget(dbUrl, env).ok) throw new Error(UNSET_ON_NON_LOCAL_MESSAGE);
    return new Set();
  }

  const out = new Set();
  const entries = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  entries.forEach((slug, i) => {
    const n = i + 1;
    if (!SLUG_SHAPE.test(slug))
      throw new Error(`PROTECTED_TENANT_SLUGS entry ${n} is not a valid tenant slug: refusing.`);
    if (isTestTenant(slug))
      throw new Error(
        `PROTECTED_TENANT_SLUGS entry ${n} is a test-tenant slug (test / qa-* / e2e-* / ux-audit-* ` +
          "or an approved test tenant): refusing.",
      );
    if (out.has(slug))
      throw new Error(`PROTECTED_TENANT_SLUGS entry ${n} duplicates an earlier entry: refusing.`);
    out.add(slug);
  });
  return out;
}

module.exports = { loadProtectedSlugs, SLUG_SHAPE, UNSET_ON_NON_LOCAL_MESSAGE };

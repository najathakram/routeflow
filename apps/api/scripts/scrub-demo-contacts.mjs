#!/usr/bin/env node
/**
 * Scrub non-fictional contact info off routeflow-demo customers.
 *
 * Verified root cause (2026-08-26 audit): prod `routeflow-demo` customers had
 * picked up real contact details — one from demo-seed.js's own CUSTOMERS array
 * (since replaced with a fictional address — see OWNER_EMAIL there) and one on
 * a row created later through the running app, carrying a real work email and
 * a real phone number. Policy: the demo tenant carries fictional
 * *.example.com contacts and 555 phone numbers only (CLAUDE.md "Test tenants &
 * real-client data"). demo-seed.js's CUSTOMERS array is guarded at seed start,
 * but rows created afterward through the running app (support edits, manual
 * demo tweaks) are not — this script sweeps those.
 *
 * Deliberately carries no real address, phone, or row id: this file lives in a
 * repo that goes briefly public for CI, so the offenders are matched by SHAPE
 * (not *.example.com / not a 555 number), never by literal value.
 *
 * Dry-run by default — prints every offending customer (id, businessName,
 * email, phone) and its planned replacement, and writes nothing. Pass
 * --execute to apply the writes.
 *
 * Run (prod):
 *   railway run --service postgres node apps/api/scripts/scrub-demo-contacts.mjs [--execute]
 */
import { createRequire } from "node:module";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const require = createRequire(import.meta.url);
// scripts/lib/test-tenants.cjs is CJS (see its header for why exports stay
// static `module.exports`); load it the same way demo-seed.js's sibling
// scripts do.
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

// Hardcoded — this script exists specifically to scrub the demo tenant, never
// takes a slug argument, and the guard must run before any Prisma client or
// write path even exists.
const DEMO_SLUG = assertTestTenant("routeflow-demo", "scrub-demo-contacts");

// Same connection pattern as demo-seed.js / audit-buyer-verification-grandfather.mjs:
// under `railway run --service postgres` the proxy vars are injected; build the
// URL from them (Prisma 7 requires explicit options — a bare constructor throws).
function resolveDbUrl() {
  const e = process.env;
  if (
    e.RAILWAY_TCP_PROXY_DOMAIN &&
    e.RAILWAY_TCP_PROXY_PORT &&
    e.POSTGRES_USER &&
    e.POSTGRES_PASSWORD &&
    e.POSTGRES_DB
  ) {
    return (
      `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
      `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
    );
  }
  return e.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/routeflow_dev";
}

const pool = new pg.Pool({ connectionString: resolveDbUrl() });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const EXECUTE = process.argv.includes("--execute");
// Fictional US numbers are the 555 range (demo-seed writes "(512) 555-01xx"), so
// a demo phone WITHOUT 555 in it is a real one that leaked in. Matched
// digits-only, so formatting variants (dashes, parens, spaces) still hit.
// Deliberately a shape test — never a hardcoded real number (see header).
const FICTIONAL_PHONE_MARKER = "555";
const PHONE_BASE = 90; // "(512) 555-01xx" — bumped per row to stay unique.

/** lowercase alnum-only, so it's safe to drop straight into an email local-part/domain. */
function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

function isOffendingEmail(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  // `no-email+<uuid>@placeholder.local` is the DELIBERATE sentinel for
  // customers without an email (see customers.service create; sendPortalInvite
  // special-cases the domain). It is fictional by construction — never scrub it.
  if (lower.endsWith("@placeholder.local")) return false;
  return !lower.endsWith("example.com");
}

function isOffendingPhone(phone) {
  const digits = digitsOnly(phone);
  // An absent phone is not an offender — only a present, non-fictional one is.
  return digits.length > 0 && !digits.includes(FICTIONAL_PHONE_MARKER);
}

/** "<contact first name or business slug>@<business slug>.example.com", e.g. dana@abcwholesale.example.com. */
function replacementEmail(customer) {
  const domain = slugify(customer.businessName).slice(0, 30) || "customer";
  const firstName = String(customer.contactName ?? "")
    .trim()
    .split(/\s+/)[0];
  const local = (slugify(firstName) || slugify(customer.businessName)).slice(0, 24) || "contact";
  return `${local}@${domain}.example.com`;
}

function replacementPhone(index) {
  const last2 = String((PHONE_BASE + index) % 100).padStart(2, "0");
  return `(512) 555-01${last2}`;
}

async function main() {
  const customers = await prisma.customer.findMany({
    where: { tenant: { slug: DEMO_SLUG }, deletedAt: null },
    select: { id: true, businessName: true, contactName: true, email: true, phone: true },
    orderBy: { businessName: "asc" },
  });

  // No early return on zero offenders — the user/buyer sweeps below must still run.
  const offenders = customers.filter((c) => isOffendingEmail(c.email) || isOffendingPhone(c.phone));

  const writes = [];
  offenders.forEach((c, index) => {
    const nextEmail = isOffendingEmail(c.email) ? replacementEmail(c) : c.email;
    const nextPhone = isOffendingPhone(c.phone) ? replacementPhone(index) : c.phone;

    console.log(
      `${EXECUTE ? "SCRUB" : "WOULD SCRUB"} ${c.id} "${c.businessName}"\n` +
        `  email: ${c.email ?? "(none)"} -> ${nextEmail ?? "(none)"}\n` +
        `  phone: ${c.phone ?? "(none)"} -> ${nextPhone ?? "(none)"}`,
    );

    if (EXECUTE) {
      writes.push(
        prisma.customer.update({
          where: { id: c.id },
          data: { email: nextEmail, phone: nextPhone },
        }),
      );
    }
  });

  if (EXECUTE) {
    await Promise.all(writes);
  }

  // ── Linked User accounts ────────────────────────────────────────────────────
  // demo-seed creates each demo customer's login User with the SAME email, so a
  // leaked address usually exists twice. Sweep demo-tenant users too: reuse the
  // matching customer's replacement when the emails line up, else a generic
  // fictional address.
  const users = await prisma.user.findMany({
    where: { tenant: { slug: DEMO_SLUG } },
    select: { id: true, email: true, username: true },
  });
  const emailMap = new Map(
    offenders
      .filter((c) => isOffendingEmail(c.email))
      .map((c) => [c.email.toLowerCase(), replacementEmail(c)]),
  );
  const offendingUsers = users.filter((u) => isOffendingEmail(u.email));
  const userWrites = [];
  offendingUsers.forEach((u, index) => {
    const nextEmail =
      emailMap.get(String(u.email).toLowerCase()) ??
      `scrubbed-user-${index + 1}@routeflow-demo.example.com`;
    console.log(
      `${EXECUTE ? "SCRUB" : "WOULD SCRUB"} user ${u.id} "${u.username}"\n` +
        `  email: ${u.email} -> ${nextEmail}`,
    );
    if (EXECUTE) {
      userWrites.push(prisma.user.update({ where: { id: u.id }, data: { email: nextEmail } }));
    }
  });
  if (EXECUTE) {
    await Promise.all(userWrites);
  }

  // ── Buyer accounts: REPORT ONLY ─────────────────────────────────────────────
  // BuyerAccount is GLOBAL (no tenantId) — an account linked to the demo tenant
  // may be a real person's identity that also links to real tenants. Never
  // rewrite those here; surface them for the owner to unlink/decide.
  const linkedBuyers = await prisma.buyerAccount.findMany({
    where: { customerLinks: { some: { tenant: { slug: DEMO_SLUG } } } },
    select: { id: true, email: true },
  });
  const buyerOffenders = linkedBuyers.filter((b) => isOffendingEmail(b.email));
  for (const b of buyerOffenders) {
    console.log(
      `REPORT ONLY: buyer account ${b.id} (${b.email}) is linked to ${DEMO_SLUG} — ` +
        `global identity, NOT modified; owner decides whether to unlink.`,
    );
  }

  console.log(
    `\nscrubbed ${offenders.length} customers, ${offendingUsers.length} users ` +
      `(${EXECUTE ? "executed" : "dry-run"}); ${buyerOffenders.length} linked buyer account(s) reported`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

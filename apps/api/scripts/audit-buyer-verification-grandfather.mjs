#!/usr/bin/env node
/**
 * READ-ONLY audit — buyer-connect email-verification grandfather backfill (F3).
 *
 * The migration 20260824000000_add_buyer_email_verification grandfathered every
 * then-existing buyer account to emailVerified=true with a TIME-UNBOUNDED
 * statement:  UPDATE "BuyerAccount" SET "emailVerified" = true WHERE "emailVerified" = false;
 * That is correct once, at deploy. But it is NOT idempotent-by-intent: replaying
 * it (e.g. a hand-run of the data step after a DB restore) would silently verify
 * EVERY currently-pending account. Prisma will not re-run an applied migration on
 * `migrate deploy` (it tracks `_prisma_migrations`), so the guard is operational:
 * never re-run the data step by hand; let restores replay through the migrations
 * table only.
 *
 * This script makes NO writes. It flags accounts the backfill MAY have verified
 * without any mailbox proof: created before the cutoff, emailVerified=true, that
 * never held a verification token, whose email matches a customer/user record, and
 * shows their ACTIVE CustomerLinks (the #378→#386 auto-connect exposure window).
 *
 * Run against prod (read-only):
 *   railway run --service postgres node apps/api/scripts/audit-buyer-verification-grandfather.mjs
 */
import { PrismaClient } from "@prisma/client";

const CUTOFF = new Date("2026-08-24T00:00:00.000Z");
const prisma = new PrismaClient();

async function main() {
  const suspects = await prisma.buyerAccount.findMany({
    where: {
      emailVerified: true,
      createdAt: { lt: CUTOFF },
      emailVerificationTokens: { none: {} },
      deletedAt: null,
    },
    select: {
      id: true,
      email: true,
      createdAt: true,
      googleId: true,
      passwordSet: true,
      customerLinks: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          tenantId: true,
          customer: { select: { id: true, businessName: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const flagged = [];
  for (const acc of suspects) {
    const email = acc.email.toLowerCase();
    // Does this buyer's email match any customer record (own email or linked user email)?
    const match = await prisma.customer.findFirst({
      where: { OR: [{ email }, { user: { email } }] },
      select: { id: true, tenantId: true, businessName: true },
    });
    if (!match && acc.customerLinks.length === 0) continue;
    flagged.push({
      buyerId: acc.id,
      email: acc.email,
      createdAt: acc.createdAt.toISOString(),
      googleLinked: !!acc.googleId,
      passwordSet: acc.passwordSet,
      matchedCustomer: match
        ? { id: match.id, tenantId: match.tenantId, businessName: match.businessName }
        : null,
      activeLinks: acc.customerLinks.map((l) => ({
        linkId: l.id,
        tenantId: l.tenantId,
        customerId: l.customer?.id ?? null,
        businessName: l.customer?.businessName ?? null,
      })),
    });
  }

  console.log(
    `\nBuyer verification grandfather audit — cutoff ${CUTOFF.toISOString()}\n` +
      `Scanned ${suspects.length} tokenless pre-cutoff verified accounts; ` +
      `${flagged.length} match a customer record and/or hold ACTIVE links.\n`,
  );
  console.log(JSON.stringify(flagged, null, 2));
  console.log(
    `\nREAD-ONLY: no rows were modified. Review flagged accounts whose password ` +
      `was never mailbox-proven (passwordSet=true, googleLinked=false) and that hold ` +
      `ACTIVE links — those are the highest-risk grandfathered auto-connects.\n`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

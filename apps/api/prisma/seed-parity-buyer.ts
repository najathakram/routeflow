import type { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { assertTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import {
  PARITY_BUYER,
  PARITY_BUYER_EMPTY,
  PARITY_TENANT_SLUG,
} from "../../../scripts/native-parity/fixtures.cjs";

/**
 * #2338 (T0.10): buyer-portal fixtures for the native-parity proof harness on the `test` tenant.
 * The `test` seed had no BuyerAccount, so buyer screens could not be captured from seeded data.
 *
 * - PARITY_BUYER: ACTIVE-linked to `loadedCustomerId` (the seed's first customer, which has orders),
 *   so buyer screens render their LOADED state.
 * - PARITY_BUYER_EMPTY: ACTIVE-linked to a dedicated customer with nothing on it: the EMPTY state.
 *
 * A BuyerAccount is GLOBAL (not tenant-scoped) and its password is a committed throwaway, so, like
 * apps/api/scripts/e2e-seed.js's buyer fixture, this only runs on a provably local database: the
 * caller passes `isLocalTarget` (seed.ts's vetted localConnectionConfig), and nothing overrides it.
 * Idempotent: each piece is found first and repaired (re-activated, unlocked, password restored,
 * link re-approved) rather than duplicated.
 */
export async function ensureParityBuyers(
  prisma: PrismaClient,
  opts: { tenantId: string; tenantSlug: string; loadedCustomerId: string; isLocalTarget: boolean },
): Promise<void> {
  assertTestTenant(opts.tenantSlug, "seed-parity-buyer.ts");
  if (opts.tenantSlug !== PARITY_TENANT_SLUG) {
    throw new Error(`parity buyers belong to the "${PARITY_TENANT_SLUG}" tenant only`);
  }
  if (!opts.isLocalTarget) {
    console.log("  - parity buyer fixtures skipped (non-local target)");
    return;
  }

  const loaded = await ensureAccount(prisma, PARITY_BUYER);
  await ensureActiveLink(prisma, loaded.id, opts.loadedCustomerId, opts.tenantId);

  const user = await prisma.user.upsert({
    where: {
      tenantId_username: {
        tenantId: opts.tenantId,
        username: PARITY_BUYER_EMPTY.customer.username,
      },
    },
    update: { status: "ACTIVE" },
    create: {
      tenantId: opts.tenantId,
      username: PARITY_BUYER_EMPTY.customer.username,
      email: `${PARITY_BUYER_EMPTY.customer.username}@test.routeflow.test`,
      password: await bcrypt.hash(PARITY_BUYER_EMPTY.password, 10),
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
    },
  });
  const emptyCustomer = await prisma.customer.upsert({
    where: { userId: user.id },
    update: { deletedAt: null },
    create: {
      tenantId: opts.tenantId,
      userId: user.id,
      businessName: PARITY_BUYER_EMPTY.customer.businessName,
      contactName: PARITY_BUYER_EMPTY.name,
    },
  });
  const empty = await ensureAccount(prisma, PARITY_BUYER_EMPTY);
  await ensureActiveLink(prisma, empty.id, emptyCustomer.id, opts.tenantId);

  console.log(
    `  ✓ Parity buyers: ${PARITY_BUYER.email} (loaded), ${PARITY_BUYER_EMPTY.email} (empty)`,
  );
}

async function ensureAccount(
  prisma: PrismaClient,
  fx: { email: string; password: string; name: string },
): Promise<{ id: string }> {
  const existing = await prisma.buyerAccount.findUnique({ where: { email: fx.email } });
  if (!existing) {
    return prisma.buyerAccount.create({
      data: {
        email: fx.email,
        passwordHash: await bcrypt.hash(fx.password, 10),
        name: fx.name,
        emailVerified: true,
      },
      select: { id: true },
    });
  }
  const passwordOk = await bcrypt.compare(fx.password, existing.passwordHash);
  const healthy =
    passwordOk &&
    existing.status === "ACTIVE" &&
    !existing.deletedAt &&
    !existing.lockedUntil &&
    existing.failedLoginAttempts === 0;
  if (healthy) return existing;
  return prisma.buyerAccount.update({
    where: { id: existing.id },
    data: {
      status: "ACTIVE",
      deletedAt: null,
      lockedUntil: null,
      failedLoginAttempts: 0,
      ...(passwordOk ? {} : { passwordHash: await bcrypt.hash(fx.password, 10) }),
    },
    select: { id: true },
  });
}

/** CustomerLink.customerId is @unique: one customer holds one buyer, re-approved if it drifted. */
async function ensureActiveLink(
  prisma: PrismaClient,
  buyerAccountId: string,
  customerId: string,
  tenantId: string,
): Promise<void> {
  const link = await prisma.customerLink.findUnique({ where: { customerId } });
  if (link && link.buyerAccountId === buyerAccountId && link.status === "ACTIVE") return;
  await prisma.customerLink.upsert({
    where: { customerId },
    create: { buyerAccountId, customerId, tenantId, status: "ACTIVE", linkedAt: new Date() },
    update: {
      buyerAccountId,
      status: "ACTIVE",
      linkedAt: new Date(),
      disconnectedAt: null,
      disconnectedBy: null,
      inviteToken: null,
      inviteExpiresAt: null,
    },
  });
}

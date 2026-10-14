import type { PrismaClient } from "@prisma/client";
import type { Pool } from "pg";
import type { JwtPayload } from "../src/auth/jwt-payload.interface";
import { assertSafeTextCell } from "../src/common/safe-text-cell";

/**
 * Row 510 DB-spec fixture (test code only; lives in apps/api/test/, outside src/ and outside the build, because the repo-wide
 * writer scans (stock ledger, address, price, text cell) read every non-spec file under src/): a throwaway `qa-*` tenant with an OPERATOR, a
 * TENANT_ADMIN and a DRIVER, two customers (one in CA, one in TX), a restricted category with a STATE rule banning CA,
 * three products (two carry the restricted label, one is clean) and NO `selling_restrictions.enabled` row (the switch is
 * gone, so a tenant without it must still be judged). The store (`TenantConfig.state`) is set per test.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

export interface OverrideWorld {
  tenantId: string;
  slug: string;
  operatorId: string;
  adminId: string;
  driverId: string;
  caCustomerId: string;
  txCustomerId: string;
  categoryId: string;
  ruleId: string;
  /** Restricted by the CA rule (label INCLUDE). */
  banned: string;
  banned2: string;
  clean: string;
}

export async function seedOverrideWorld(
  raw: PrismaClient,
  run: string,
  specName: string,
): Promise<OverrideWorld> {
  const slug = assertTestTenant(`qa-r510-${run}`, specName);
  const tenantId = (await raw.tenant.create({ data: { slug, name: `R510 ${slug}` } })).id;
  const mkUser = async (key: string, role: "OPERATOR" | "TENANT_ADMIN" | "DRIVER" | "CUSTOMER") =>
    (
      await raw.user.create({
        data: { email: `${key}-${run}@example.test`, username: `${key}-${run}`, role, tenantId },
      })
    ).id;
  const operatorId = await mkUser("op", "OPERATOR");
  const adminId = await mkUser("admin", "TENANT_ADMIN");
  const driverId = await mkUser("driver", "DRIVER");

  const mkCustomer = async (key: string, state: string) => {
    // the text-cell scan (B956) wants a writer of these fields to run the shared guard, fixture or not
    assertSafeTextCell({
      businessName: `R510 ${key} co`,
      contactName: "Tester",
      city: "Testville",
    });
    const userId = await mkUser(`cust-${key}`, "CUSTOMER");
    const customer = await raw.customer.create({
      data: { userId, businessName: `R510 ${key} co`, contactName: "Tester", tenantId },
    });
    await raw.customerAddress.create({
      data: {
        tenantId,
        customerId: customer.id,
        line1: "1 Test St",
        city: "Testville",
        state,
        stateCode: state,
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    return customer.id;
  };
  const caCustomerId = await mkCustomer("ca", "CA");
  const txCustomerId = await mkCustomer("tx", "TX");

  const category = await raw.productCategory.create({ data: { tenantId, name: "Restricted" } });
  const mkProduct = async (name: string, restricted: boolean) => {
    assertSafeTextCell({ name: `${name} ${run}` });
    const product = await raw.product.create({
      data: {
        tenantId,
        name: `${name} ${run}`,
        unit: "each",
        pricePerUnit: "10.00",
        currentStock: 1000,
      },
    });
    if (restricted)
      await raw.productCategoryLabel.create({
        data: { tenantId, productId: product.id, categoryId: category.id, mode: "INCLUDE" },
      });
    return product.id;
  };
  const banned = await mkProduct("Gummies", true);
  const banned2 = await mkProduct("Edibles", true);
  const clean = await mkProduct("Water", false);
  const ruleId = (
    await raw.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: category.id,
        jurisdiction: "STATE",
        states: ["CA"],
        reason: "R510 state ban",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    })
  ).id;
  return {
    tenantId,
    slug,
    operatorId,
    adminId,
    driverId,
    caCustomerId,
    txCustomerId,
    categoryId: category.id,
    ruleId,
    banned,
    banned2,
    clean,
  };
}

/** Set the store's business state (`null` = none). */
export async function setStoreState(raw: PrismaClient, tenantId: string, state: string | null) {
  await raw.tenantConfig.deleteMany({ where: { tenantId } });
  if (state) await raw.tenantConfig.create({ data: { tenantId, state } });
}

export const staffPayload = (
  w: OverrideWorld,
  role: "OPERATOR" | "TENANT_ADMIN" | "DRIVER" | "SUPER_ADMIN" = "OPERATOR",
): JwtPayload =>
  ({
    sub: role === "DRIVER" ? w.driverId : role === "TENANT_ADMIN" ? w.adminId : w.operatorId,
    username: `${role.toLowerCase()}-r510`,
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: w.tenantId,
    tenantSlug: w.slug,
  }) as JwtPayload;

/**
 * Delete everything the run made. Every table with a `tenantId` column is emptied for the tenant in repeated passes
 * (a statement that violates a foreign key is retried after its referrers went), then the tenant. Test tenants only.
 */
export async function purgeOverrideWorld(pool: Pool, tenantId: string): Promise<void> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId' AND table_name <> 'Tenant'`,
  );
  let pending = rows.map((r) => r.table_name);
  for (let pass = 0; pass < 12 && pending.length > 0; pass++) {
    const next: string[] = [];
    for (const table of pending) {
      try {
        await pool.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [tenantId]);
      } catch {
        next.push(table);
      }
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  await pool.query(`DELETE FROM "Tenant" WHERE id = $1`, [tenantId]);
}

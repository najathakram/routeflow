import { Prisma } from "@prisma/client";
import type { AutoCheckKey } from "./onboarding-catalog";

/**
 * Onboarding auto-checks (#2159 S1). Each checker answers one checklist line from the
 * linked workspace's data and returns `{ ok, detail }`; the result is shown beside the
 * step and never changes the step's status by itself.
 *
 * TENANCY: a checker reads ONE tenant. Every query carries an explicit `tenantId` filter
 * on the base (unscoped) client — the caller also wraps the run in
 * `TenantContextService.run(tenantId, …)` so any scoped helper a future checker reuses
 * resolves the same tenant (L-124). Nothing here writes. The two-tenant DB spec
 * (onboarding.db.spec.ts) pins that a check never counts another tenant's rows.
 */

/** The minimum client surface a checker needs — the base PrismaService satisfies it. */
export type CheckDb = Pick<
  Prisma.TransactionClient,
  | "tenant"
  | "tenantSubscription"
  | "tenantConfig"
  | "mailboxConnection"
  | "product"
  | "customer"
  | "user"
  | "driver"
  | "invoice"
  | "$queryRaw"
>;

export interface CheckContext {
  db: CheckDb;
  tenantId: string;
  now: Date;
}

export interface CheckOutcome {
  ok: boolean;
  detail: string;
}

type Checker = (ctx: CheckContext) => Promise<CheckOutcome>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Live, buying customers — suppliers and soft-deleted rows are not on the map or the books. */
const liveCustomers = (tenantId: string): Prisma.CustomerWhereInput => ({
  tenantId,
  deletedAt: null,
  supplierOnly: false,
});

export const AUTO_CHECKERS: Record<AutoCheckKey, Checker> = {
  async "workspace.created"({ db, tenantId }) {
    const t = await db.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { slug: true },
    });
    return t
      ? { ok: true, detail: `Workspace ${t.slug}` }
      : { ok: false, detail: "Workspace not found" };
  },

  async "payment.recorded"({ db, tenantId }) {
    const sub = await db.tenantSubscription.findUnique({
      where: { tenantId },
      select: { stripeSubId: true, externalPayment: true, externalPaymentMethod: true },
    });
    if (sub?.stripeSubId) return { ok: true, detail: "Card subscription (Stripe)" };
    if (sub?.externalPayment) {
      return {
        ok: true,
        detail: `Manual payment (${sub.externalPaymentMethod ?? "method not set"})`,
      };
    }
    return { ok: false, detail: "No card subscription or manual payment recorded" };
  },

  async "tenant.active"({ db, tenantId }) {
    const t = await db.tenant.findFirst({ where: { id: tenantId }, select: { status: true } });
    return t?.status === "ACTIVE"
      ? { ok: true, detail: "Workspace is ACTIVE" }
      : { ok: false, detail: `Workspace is ${t?.status ?? "missing"}` };
  },

  async "profile.complete"({ db, tenantId }) {
    const c = await db.tenantConfig.findUnique({
      where: { tenantId },
      select: {
        businessName: true,
        addressLine1: true,
        city: true,
        state: true,
        zip: true,
        phone: true,
      },
    });
    const missing = (
      [
        ["business name", c?.businessName],
        ["address", c?.addressLine1],
        ["city", c?.city],
        ["state", c?.state],
        ["ZIP", c?.zip],
        ["phone", c?.phone],
      ] as const
    )
      .filter(([, v]) => !v || !String(v).trim())
      .map(([label]) => label);
    return missing.length === 0
      ? { ok: true, detail: "Business profile complete" }
      : { ok: false, detail: `Missing: ${missing.join(", ")}` };
  },

  async "email.connected"({ db, tenantId }) {
    const mailbox = await db.mailboxConnection.findUnique({
      where: { tenantId },
      select: { status: true },
    });
    if (mailbox?.status === "CONNECTED") return { ok: true, detail: "Mailbox connected" };
    const cfg = await db.tenantConfig.findUnique({
      where: { tenantId },
      select: { smtpHost: true, smtpUser: true },
    });
    if (cfg?.smtpHost && cfg.smtpUser) return { ok: true, detail: "SMTP configured" };
    return { ok: false, detail: "No mailbox connected and no SMTP configured" };
  },

  // SA-443: ships labelled pending — continuing the old invoice sequence is B861's run.
  "numbering.set"() {
    return Promise.resolve({
      ok: false,
      detail: "Pending B861 — new invoices start at INV-<year>-0001 until it lands",
    });
  },

  async "catalog.productsPriced"({ db, tenantId }) {
    const unpriced = await db.product.count({
      where: { tenantId, isActive: true, pricePerUnit: { lte: 0 } },
    });
    const noPack = await db.product.count({
      where: { tenantId, isActive: true, unitsPerBox: null },
    });
    if (unpriced === 0 && noPack === 0)
      return { ok: true, detail: "Every active product has a price and pack size" };
    const parts: string[] = [];
    if (unpriced) parts.push(`${plural(unpriced, "product")} without a price`);
    if (noPack) parts.push(`${plural(noPack, "product")} without a pack size`);
    return { ok: false, detail: parts.join("; ") };
  },

  // The (tenantId, sku) unique index already refuses exact duplicates; this catches the ones
  // it cannot — the same SKU differing only in case or surrounding spaces.
  async "catalog.skuUnique"({ db, tenantId }) {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM (
        SELECT lower(btrim(sku)) FROM "Product"
        WHERE "tenantId" = ${tenantId} AND sku IS NOT NULL AND btrim(sku) <> ''
        GROUP BY lower(btrim(sku)) HAVING COUNT(*) > 1
      ) d`;
    const dupes = Number(rows[0]?.n ?? 0);
    return dupes === 0
      ? { ok: true, detail: "No duplicate SKUs" }
      : { ok: false, detail: `${plural(dupes, "SKU")} used by more than one product` };
  },

  async "customers.geocoded"({ db, tenantId }) {
    const unplaced = await db.customer.count({
      where: {
        ...liveCustomers(tenantId),
        addresses: { none: { lat: { not: null }, lng: { not: null } } },
      },
    });
    return unplaced === 0
      ? { ok: true, detail: "Every customer is placed on the map" }
      : { ok: false, detail: `${plural(unplaced, "customer")} without a map position` };
  },

  async "customers.exemptCertificates"({ db, tenantId }) {
    const n = await db.customer.count({
      where: {
        ...liveCustomers(tenantId),
        isTaxExempt: true,
        taxExemptDocumentKeys: { isEmpty: true },
      },
    });
    return n === 0
      ? { ok: true, detail: "Every tax-exempt customer has a certificate" }
      : { ok: false, detail: `${plural(n, "tax-exempt customer")} without a certificate` };
  },

  async "customers.licencesValid"({ db, tenantId, now }) {
    const n = await db.customer.count({
      where: { ...liveCustomers(tenantId), tobaccoLicenseExpiry: { lt: now } },
    });
    return n === 0
      ? { ok: true, detail: "No expired tobacco licences" }
      : { ok: false, detail: `${plural(n, "customer")} with an expired tobacco licence` };
  },

  async "admin.signedIn"({ db, tenantId }) {
    const n = await db.user.count({
      where: { tenantId, role: "TENANT_ADMIN", deletedAt: null, lastLoginAt: { not: null } },
    });
    return n > 0
      ? { ok: true, detail: "A workspace admin has signed in" }
      : { ok: false, detail: "No workspace admin has signed in yet" };
  },

  async "drivers.signedIn"({ db, tenantId }) {
    const drivers = await db.driver.findMany({
      where: { tenantId, status: "ACTIVE" },
      select: { user: { select: { lastLoginAt: true } } },
    });
    if (drivers.length === 0) return { ok: false, detail: "No drivers yet" };
    const signedIn = drivers.filter((d) => d.user.lastLoginAt).length;
    return signedIn === drivers.length
      ? { ok: true, detail: `All ${plural(drivers.length, "driver")} signed in` }
      : { ok: false, detail: `${signedIn} of ${plural(drivers.length, "driver")} signed in` };
  },

  async "golive.firstCycle"({ db, tenantId }) {
    const inv = await db.invoice.findFirst({
      where: { tenantId, status: { in: ["PARTIAL", "PAID"] }, order: { status: "DELIVERED" } },
      select: { invoiceNumber: true },
    });
    return inv
      ? { ok: true, detail: `First cycle complete (${inv.invoiceNumber})` }
      : { ok: false, detail: "No delivered order with a paid or part-paid invoice yet" };
  },
};

export async function runAutoCheck(key: string, ctx: CheckContext): Promise<CheckOutcome> {
  const checker = (AUTO_CHECKERS as Record<string, Checker | undefined>)[key];
  if (!checker) return { ok: false, detail: `Unknown check ${key}` };
  try {
    return await checker(ctx);
  } catch (err) {
    return { ok: false, detail: `Check failed: ${(err as Error).message.slice(0, 200)}` };
  }
}

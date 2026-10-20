/**
 * SA-827 (T2) — real-Postgres proof of every query invoice-display-unit.ts adds: the live resolve (customer, customerPrice,
 * productTierUnit, product, productUnit, systemConfig), the issue-time resolve (non-tx client) and the snapshot write
 * (updateMany inside a REAL Serializable tenantTransaction, under the display_unit_snapshot savepoint), plus the revert clear.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway `qa-sa827-<run>-<n>` slug approved
 * by `assertTestTenant`, deleted in FK order in afterAll. Acme fixtures only.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  clearIssueDisplayUnits,
  resolveIssueDisplayUnits,
  resolveLiveDisplayUnits,
  writeIssueDisplayUnits,
} from "./invoice-display-unit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const on = { hasFlagStrict: jest.fn().mockResolvedValue(true) };
const off = { hasFlagStrict: jest.fn().mockResolvedValue(false) };

describeDb("SA-827 invoice display unit — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.customerPrice.deleteMany(where).catch(swallow);
      await prisma.productTierUnit.deleteMany(where).catch(swallow);
      await prisma.productUnit.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.systemConfig.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** One tenant, one customer, one boxed product (15 pieces, base "Piece"), one invoice with one box line. */
  async function seed(
    label: string,
    opts: {
      business?: string;
      customerRef?: string;
      invoiceUnitDefault?: "LEGACY" | "PIECES" | "PACK";
      tier?: { customerTier: number; invoiceUnitRef: string };
      status?: "DRAFT" | "SENT";
    } = {},
  ) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa827-${RUN}-${seq}-${label}`,
      "invoice-display-unit.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA827 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme ${label}`,
        contactName: "Pat",
        tenantId,
        ...(opts.tier ? { pricingTier: opts.tier.customerTier } : {}),
        ...(opts.invoiceUnitDefault ? { invoiceUnitDefault: opts.invoiceUnitDefault } : {}),
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Acme mixed box ${label}`,
        unit: "Box",
        packLabel: "Box",
        baseUnitLabel: "Piece",
        unitsPerBox: 15,
        pricePerUnit: 30.01,
      },
    });
    if (opts.business) {
      await prisma.systemConfig.create({
        data: { tenantId, key: "units.invoiceUnit", value: opts.business },
      });
    }
    if (opts.tier) {
      await prisma.productTierUnit.create({
        data: {
          tenantId,
          productId: product.id,
          tier: opts.tier.customerTier,
          invoiceUnitRef: opts.tier.invoiceUnitRef,
        },
      });
    }
    if (opts.customerRef) {
      await prisma.customerPrice.create({
        data: {
          tenantId,
          customerId: customer.id,
          productId: product.id,
          invoiceUnitRef: opts.customerRef,
        },
      });
    }
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-SA827-${RUN}-${seq}`,
        status: opts.status ?? "DRAFT",
        subtotal: 60.02,
        taxAmount: 0,
        total: 60.02,
      },
    });
    const item = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: product.id,
        description: "Acme mixed box",
        qty: 30,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 15,
        unitPrice: 30.01,
        discount: 0,
        taxRate: 0,
        subtotal: 60.02,
      },
    });
    return { tenantId, customer, product, invoice, item };
  }

  const itemRow = (id: string) =>
    prisma.invoiceItem.findUniqueOrThrow({
      where: { id },
      select: {
        invoiceUnitLabel: true,
        invoiceUnitFactor: true,
        subtotal: true,
        unitPrice: true,
        qty: true,
      },
    });

  it("resolveLiveDisplayUnits: business 'smallest' + flag on resolves pieces; flag off or nothing set stays legacy", async () => {
    const s = await seed("live", { business: "smallest" });
    const inv = { customerId: s.customer.id, items: [{ id: s.item.id, productId: s.product.id }] };
    expect((await resolveLiveDisplayUnits(prisma, s.tenantId, inv, on)).get(s.item.id)).toEqual({
      kind: "pieces",
      label: "Piece",
    });
    expect((await resolveLiveDisplayUnits(prisma, s.tenantId, inv, off)).get(s.item.id)).toEqual({
      kind: "legacy",
      label: null,
    });
    const none = await seed("none");
    const inv2 = {
      customerId: none.customer.id,
      items: [{ id: none.item.id, productId: none.product.id }],
    };
    expect(
      (await resolveLiveDisplayUnits(prisma, none.tenantId, inv2, on)).get(none.item.id),
    ).toEqual({
      kind: "legacy",
      label: null,
    });
  });

  it("resolveLiveDisplayUnits: the customer's own product ref ('pack') beats the business setting", async () => {
    const s = await seed("custref", { business: "smallest", customerRef: "pack" });
    const inv = { customerId: s.customer.id, items: [{ id: s.item.id, productId: s.product.id }] };
    expect((await resolveLiveDisplayUnits(prisma, s.tenantId, inv, on)).get(s.item.id)).toEqual({
      kind: "legacy",
      label: null,
    });
  });

  it("resolveLiveDisplayUnits: the tier scope (customer pricingTier -> ProductTierUnit.invoiceUnitRef) resolves pieces", async () => {
    // no business setting, no customer override: only scopes.tier can produce pieces
    const s = await seed("tier", { tier: { customerTier: 2, invoiceUnitRef: "base" } });
    const inv = { customerId: s.customer.id, items: [{ id: s.item.id, productId: s.product.id }] };
    expect((await resolveLiveDisplayUnits(prisma, s.tenantId, inv, on)).get(s.item.id)).toEqual({
      kind: "pieces",
      label: "Piece",
    });
  });

  /** The first-issue sequence, as markSent runs it: resolve OUTSIDE the tx, write INSIDE a Serializable tx. */
  async function issue(
    s: { tenantId: string; invoice: { id: string } },
    entitlements: typeof on | typeof off = on,
  ) {
    const units = await resolveIssueDisplayUnits(prisma, s.tenantId, s.invoice.id, entitlements);
    await tenantCtx.run(s.tenantId, () =>
      prisma.tenantTransaction(async (tx) => writeIssueDisplayUnits(tx, s.invoice.id, units), {
        isolationLevel: "Serializable",
      }),
    );
  }

  it("Customer.invoiceUnitDefault PIECES on a flag-OFF tenant resolves pieces and snapshots Piece/1; money is untouched", async () => {
    const s = await seed("custdefault", { invoiceUnitDefault: "PIECES" });
    const inv = { customerId: s.customer.id, items: [{ id: s.item.id, productId: s.product.id }] };
    expect((await resolveLiveDisplayUnits(prisma, s.tenantId, inv, off)).get(s.item.id)).toEqual({
      kind: "pieces",
      label: "Piece",
    });
    const units = await resolveIssueDisplayUnits(prisma, s.tenantId, s.invoice.id, off);
    expect(units.get(s.item.id)).toEqual({ kind: "pieces", label: "Piece" });
    await issue(s, off);
    const row = await itemRow(s.item.id);
    expect(row.invoiceUnitLabel).toBe("Piece");
    expect(row.invoiceUnitFactor).toBe(1);
    expect(Number(row.subtotal)).toBe(60.02);
    expect(Number(row.unitPrice)).toBe(30.01);
    expect(Number(row.qty)).toBe(30);
  });

  it("Customer.invoiceUnitDefault PACK beats the business 'smallest'; a new customer reads LEGACY", async () => {
    const s = await seed("custpack", { business: "smallest", invoiceUnitDefault: "PACK" });
    const inv = { customerId: s.customer.id, items: [{ id: s.item.id, productId: s.product.id }] };
    expect((await resolveLiveDisplayUnits(prisma, s.tenantId, inv, on)).get(s.item.id)).toEqual({
      kind: "legacy",
      label: null,
    });
    const fresh = await seed("custlegacy");
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: fresh.customer.id },
      select: { invoiceUnitDefault: true },
    });
    expect(row.invoiceUnitDefault).toBe("LEGACY");
  });

  it("writeIssueDisplayUnits (real Serializable tenantTransaction) writes ONLY the two display columns, once; money is untouched", async () => {
    const s = await seed("snap", { business: "smallest" });
    await issue(s);
    const row = await itemRow(s.item.id);
    expect(row.invoiceUnitLabel).toBe("Piece");
    expect(row.invoiceUnitFactor).toBe(1);
    expect(Number(row.subtotal)).toBe(60.02);
    expect(Number(row.unitPrice)).toBe(30.01);
    expect(Number(row.qty)).toBe(30);
  });

  it("a pre-snapshotted item is NOT overwritten when the preference later changes", async () => {
    const s = await seed("frozen", { business: "smallest" });
    await issue(s);
    await prisma.systemConfig.update({
      where: { tenantId_key: { tenantId: s.tenantId, key: "units.invoiceUnit" } },
      data: { value: "pack" },
    });
    await prisma.invoiceItem.update({
      where: { id: s.item.id },
      data: { invoiceUnitLabel: "Each", invoiceUnitFactor: 1 },
    });
    // the resolver itself skips a snapshotted line; and a stale map written anyway is guarded by invoiceUnitFactor: null
    expect((await resolveIssueDisplayUnits(prisma, s.tenantId, s.invoice.id, on)).size).toBe(0);
    await tenantCtx.run(s.tenantId, () =>
      prisma.tenantTransaction(
        async (tx) =>
          writeIssueDisplayUnits(
            tx,
            s.invoice.id,
            new Map([[s.item.id, { kind: "pieces" as const, label: "Piece" }]]),
          ),
        { isolationLevel: "Serializable" },
      ),
    );
    const row = await itemRow(s.item.id);
    expect(row.invoiceUnitLabel).toBe("Each");
    expect(row.invoiceUnitFactor).toBe(1);
  });

  it("nothing set (legacy): zero writes, the columns stay null", async () => {
    const s = await seed("legacy");
    await issue(s);
    const row = await itemRow(s.item.id);
    expect(row.invoiceUnitLabel).toBeNull();
    expect(row.invoiceUnitFactor).toBeNull();
  });

  it("clearIssueDisplayUnits (revert to draft) nulls both columns so a re-issue snapshots afresh", async () => {
    const s = await seed("revert", { business: "smallest" });
    await issue(s);
    expect((await itemRow(s.item.id)).invoiceUnitFactor).toBe(1);
    await tenantCtx.run(s.tenantId, () =>
      prisma.tenantTransaction(async (tx) => clearIssueDisplayUnits(tx, s.invoice.id), {
        isolationLevel: "Serializable",
      }),
    );
    const cleared = await itemRow(s.item.id);
    expect(cleared.invoiceUnitLabel).toBeNull();
    expect(cleared.invoiceUnitFactor).toBeNull();
    await issue(s); // the preference is unchanged, so it freezes again
    expect((await itemRow(s.item.id)).invoiceUnitLabel).toBe("Piece");
  });

  it("resolveIssueDisplayUnits never reaches another tenant's invoice", async () => {
    const a = await seed("tenant-a", { business: "smallest" });
    const b = await seed("tenant-b", { business: "smallest" });
    expect((await resolveIssueDisplayUnits(prisma, a.tenantId, b.invoice.id, on)).size).toBe(0);
  });
});

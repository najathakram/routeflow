/**
 * SA-1029 D-R1 (red first) — real-Postgres proof that the per-piece unit word freezes at first issue in
 * InvoiceItem.baseLabel: written by writeIssueDisplayUnits (one updateMany per distinct label), kept when the product's
 * baseUnitLabel is renamed afterwards, and cleared by clearIssueDisplayUnits on a revert to DRAFT.
 *
 * Runs only under `npm run local:test:db`. Throwaway `qa-sa1029-<run>-<n>` tenants approved by `assertTestTenant`,
 * deleted in FK order in afterAll. Acme fixtures only.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  clearIssueDisplayUnits,
  freezeDraftIssueUnits,
  itemsWithDisplayUnits,
} from "./invoice-display-unit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const on = { hasFlagStrict: jest.fn().mockResolvedValue(true) };

describeDb("SA-1029 per-piece unit word freeze — real Postgres", () => {
  let prisma: PrismaService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** One DRAFT with one boxed line (24 per box, unitPrice 48 -> $2.00/pc) per entry of `labels`. */
  async function seed(label: string, labels: string[]) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa1029-${RUN}-${seq}-${label}`,
      "invoice-per-piece-freeze.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA1029 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Acme ${label}`, contactName: "Pat", tenantId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-SA1029-${RUN}-${seq}`,
        status: "DRAFT",
        subtotal: 96 * labels.length,
        taxAmount: 0,
        total: 96 * labels.length,
      },
    });
    const products: Array<{ id: string }> = [];
    const items: Array<{ id: string }> = [];
    for (const [i, baseUnitLabel] of labels.entries()) {
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `Acme case ${label} ${i}`,
          unit: "Case",
          packLabel: "Case",
          baseUnitLabel,
          unitsPerBox: 24,
          pricePerUnit: 48,
        },
      });
      products.push(product);
      items.push(
        await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            productId: product.id,
            description: `Acme case ${i}`,
            qty: 2,
            boxes: 2,
            pieces: 0,
            unitsPerBox: 24,
            unitPrice: 48,
            discount: 0,
            taxRate: 0,
            subtotal: 96,
          },
        }),
      );
    }
    return { tenantId, customer, invoice, products, items };
  }

  const baseLabelOf = async (id: string) =>
    (await prisma.invoiceItem.findUniqueOrThrow({ where: { id }, select: { baseLabel: true } }))
      .baseLabel;

  const perPiece = async (invoiceId: string, status: "DRAFT" | "SENT") => {
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { items: true },
    });
    const out = await itemsWithDisplayUnits(prisma, { ...inv, status }, on);
    return out.map((i: any) => i.perBaseUnit ?? null);
  };

  it("D-R1: the issue freezes the base label; a later rename of the product label does not move it", async () => {
    const s = await seed("freeze", ["Bag"]);
    await freezeDraftIssueUnits(prisma, prisma, { id: s.invoice.id, tenantId: s.tenantId }, on);
    await prisma.invoice.update({ where: { id: s.invoice.id }, data: { status: "SENT" } });
    expect(await baseLabelOf(s.items[0].id)).toBe("Bag");

    await prisma.product.update({
      where: { id: s.products[0].id },
      data: { baseUnitLabel: "Pack" },
    });
    expect(await baseLabelOf(s.items[0].id)).toBe("Bag");
    expect(await perPiece(s.invoice.id, "SENT")).toEqual([{ price: 2, unit: "bag" }]);
  });

  it("D-R1: a revert to DRAFT clears the freeze and the draft reads the live label", async () => {
    const s = await seed("revert", ["Bag"]);
    await freezeDraftIssueUnits(prisma, prisma, { id: s.invoice.id, tenantId: s.tenantId }, on);
    await prisma.product.update({
      where: { id: s.products[0].id },
      data: { baseUnitLabel: "Pack" },
    });

    await clearIssueDisplayUnits(prisma, s.invoice.id);
    expect(await baseLabelOf(s.items[0].id)).toBeNull();
    expect(await perPiece(s.invoice.id, "DRAFT")).toEqual([{ price: 2, unit: "pack" }]);
  });

  it("D-R1: the issue runs one updateMany per distinct base label", async () => {
    const s = await seed("count", ["Bag", "Bag", "Tin"]);
    const spy = jest.spyOn(prisma.invoiceItem, "updateMany");
    try {
      await freezeDraftIssueUnits(prisma, prisma, { id: s.invoice.id, tenantId: s.tenantId }, on);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
    expect(await baseLabelOf(s.items[0].id)).toBe("Bag");
    expect(await baseLabelOf(s.items[1].id)).toBe("Bag");
    expect(await baseLabelOf(s.items[2].id)).toBe("Tin");
  });
});

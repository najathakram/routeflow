/**
 * DB-lane proof for B1188: the Settings card previews a prefix change with
 * `NumberingService.previewPrefix`, then saves it with `updateSettings` carrying the preview's
 * `expectedNextNumber`. Proven against a REAL Postgres (the max-first scan is a `regexp_match`,
 * and the stale-token refusal is a genuine compare-and-set on the stored row):
 *   1. the preview WRITES NOTHING (no row created, a configured row untouched);
 *   2. the preview is max-first under the NEW prefix and tenant-scoped (another tenant's numbers
 *      never count);
 *   3. a save with the preview's token succeeds and the new prefix is what the mint then uses;
 *   4. a sequence that MOVED since the preview (a live mint) makes the save 409 and changes nothing.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); run via
 * `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- src/import/numbering-prefix-preview.db.spec.ts"`.
 * SAFETY: throwaway `qa-b1188-<run>-<n>-<label>` tenants (`assertTestTenant`); afterAll deletes
 * exactly the tenants THIS run created.
 */
import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NumberingService } from "./numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b1188-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "numbering-prefix-preview.db.spec.ts",
  );
};
const YEAR = new Date().getFullYear();

describeDb("B1188 prefix preview + token-guarded save — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let numbering: NumberingService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module = await Test.createTestingModule({
      providers: [NumberingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    numbering = module.get(NumberingService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.numberingSequence.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string): Promise<{ id: string; customerId: string }> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1188 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const base = `${tenant.id}-c`;
    const user = await prisma.user.create({
      data: {
        email: `${base}@example.invalid`,
        username: base,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "B1188 customer",
        contactName: "B1188",
        tenantId: tenant.id,
      },
    });
    return { id: tenant.id, customerId: customer.id };
  }

  const seedInvoice = (t: { id: string; customerId: string }, invoiceNumber: string) =>
    prisma.invoice.create({
      data: {
        tenantId: t.id,
        customerId: t.customerId,
        invoiceNumber,
        status: "DRAFT",
        subtotal: 10,
        total: 10,
      },
    });

  const row = (tenantId: string) =>
    prisma.numberingSequence.findUnique({
      where: { tenantId_docType_year: { tenantId, docType: "INVOICE", year: 0 } },
    });
  const rowCount = (tenantId: string) =>
    prisma.numberingSequence.count({ where: { tenantId, docType: "INVOICE" } });
  const asTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  it("the preview writes nothing for an unsaved tenant and returns the unsaved token 1", async () => {
    const t = await seedTenant("unsaved");
    const before = await rowCount(t.id);
    const out = await asTenant(t.id, () => numbering.previewPrefix("INVOICE", "NEW-"));
    expect(out).toEqual({
      docType: "INVOICE",
      prefix: "NEW-",
      preview: "NEW-0001",
      expectedNextNumber: 1,
    });
    expect(await row(t.id)).toBeNull();
    expect(await rowCount(t.id)).toBe(before);
  });

  it("the preview is max-first under the NEW prefix, tenant-scoped, and leaves a saved row untouched", async () => {
    const a = await seedTenant("a");
    const b = await seedTenant("b");
    await seedInvoice(a, "NEW-0041");
    await seedInvoice(a, "OLD-0900"); // another prefix: not counted
    await seedInvoice(b, "NEW-0099"); // another tenant: not counted
    await asTenant(a.id, () =>
      numbering.updateSettings("INVOICE", { prefix: "INV-", expectedNextNumber: 1 }),
    );
    const saved = await row(a.id);

    const out = await asTenant(a.id, () => numbering.previewPrefix("INVOICE", "NEW-"));
    expect(out.preview).toBe("NEW-0042");
    expect(out.expectedNextNumber).toBe(saved!.nextNumber);

    const after = await row(a.id);
    expect(after).toMatchObject({ prefix: "INV-", nextNumber: saved!.nextNumber });
    expect(after!.updatedAt.getTime()).toBe(saved!.updatedAt.getTime());
  });

  it("a save carrying the preview's token succeeds and the mint then uses the new prefix", async () => {
    const t = await seedTenant("save");
    await seedInvoice(t, "NEW-0041");
    await asTenant(t.id, () =>
      numbering.updateSettings("INVOICE", { prefix: "INV-", expectedNextNumber: 1 }),
    );
    const preview = await asTenant(t.id, () => numbering.previewPrefix("INVOICE", "NEW-"));
    const saved = await asTenant(t.id, () =>
      numbering.updateSettings("INVOICE", {
        prefix: preview.prefix,
        expectedNextNumber: preview.expectedNextNumber,
      }),
    );
    expect(saved.prefix).toBe("NEW-");
    expect(saved.preview).toBe(preview.preview);
    const minted = await asTenant(t.id, () =>
      numbering.reserveNext("INVOICE", { year: YEAR, tenantId: t.id }),
    );
    expect(minted).toBe(preview.preview);
  });

  it("409s and changes nothing when the sequence moved since the preview", async () => {
    const t = await seedTenant("stale");
    await asTenant(t.id, () =>
      numbering.updateSettings("INVOICE", { prefix: "INV-", expectedNextNumber: 1 }),
    );
    const preview = await asTenant(t.id, () => numbering.previewPrefix("INVOICE", "NEW-"));
    // A live mint lands between the preview and the save: the stored nextNumber moves.
    await asTenant(t.id, () => numbering.reserveNext("INVOICE", { year: YEAR, tenantId: t.id }));
    const moved = await row(t.id);
    expect(moved!.nextNumber).not.toBe(preview.expectedNextNumber);

    await expect(
      asTenant(t.id, () =>
        numbering.updateSettings("INVOICE", {
          prefix: preview.prefix,
          expectedNextNumber: preview.expectedNextNumber,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await row(t.id)).toMatchObject({ prefix: "INV-", nextNumber: moved!.nextNumber });
  });
});

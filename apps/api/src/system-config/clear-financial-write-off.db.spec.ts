/**
 * SA-1050 A-1 / R-W1 (real Postgres): `DELETE /settings/financial-data` deletes every invoice of the tenant in one raw
 * transaction. `InvoiceWriteOffEvent.invoiceId` is ON DELETE RESTRICT (the events are the bad-debt ledger), so a tenant
 * holding ONE event aborted the whole wipe on P2003 and rolled it back. The wipe is a WIPE site: it deletes the tenant's
 * events first, matched through the parent invoice, and ends with 0 invoices and 0 events.
 *
 * The event is seeded directly: the writer lands in a later commit of the same PR, and this spec proves the wipe door.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-wow-<run>-<n>` slug (`assertTestTenant`).
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EmailService } from "../email/email.service";
import { quickKeysSettingsStubProvider } from "../testing/quick-keys-settings-stub";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-1050 R-W1: clearFinancialData with a write-off event (real Postgres)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let controller: SettingsController;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        quickKeysSettingsStubProvider,
      ],
    }).compile();
    controller = mod.get(SettingsController);
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.invoiceWriteOffEvent.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoiceItem.deleteMany({ where: { invoice: { tenantId } } }).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A tenant with one customer and one written-off invoice; `withEvent` adds its one WRITE_OFF event. */
  async function seed(label: string, withEvent: boolean) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-wow-${RUN}-${seq}-${label}`,
      "clear-financial-write-off.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `wow ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-WOW-${RUN}-${seq}`,
        status: "WRITTEN_OFF",
        subtotal: 75,
        taxAmount: 0,
        total: 75,
        writeOffReason: "uncollectable",
        writtenOffAt: new Date(),
      },
    });
    if (withEvent) {
      await prisma.invoiceWriteOffEvent.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          kind: "WRITE_OFF",
          amount: 75,
          preTax: 75,
          at: new Date(),
          reason: "uncollectable",
        },
      });
    }
    return { tenantId, invoiceId: invoice.id };
  }

  const wipe = (tenantId: string) =>
    tenantCtx.run(tenantId, () =>
      controller.clearFinancialData({ confirmTenantId: tenantId } as any),
    );

  it("R-W1: a tenant with one write-off event wipes: 0 invoices and 0 events afterwards (head: P2003 rollback)", async () => {
    const s = await seed("event", true);

    await wipe(s.tenantId);

    expect(await prisma.invoice.count({ where: { tenantId: s.tenantId } })).toBe(0);
    expect(await prisma.invoiceWriteOffEvent.count({ where: { tenantId: s.tenantId } })).toBe(0);
  }, 60_000);

  it("R-W1 scope: the wipe deletes ONLY the calling tenant's events", async () => {
    const mine = await seed("mine", true);
    const other = await seed("other", true);

    await wipe(mine.tenantId);

    expect(await prisma.invoiceWriteOffEvent.count({ where: { tenantId: other.tenantId } })).toBe(
      1,
    );
    expect(await prisma.invoice.count({ where: { tenantId: other.tenantId } })).toBe(1);
  }, 60_000);

  it("control: a tenant with a written-off invoice and NO event wipes as before", async () => {
    const s = await seed("legacy", false);

    await wipe(s.tenantId);

    expect(await prisma.invoice.count({ where: { tenantId: s.tenantId } })).toBe(0);
  }, 60_000);
});

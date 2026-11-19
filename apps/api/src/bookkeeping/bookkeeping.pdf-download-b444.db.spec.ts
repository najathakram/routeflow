/**
 * B444 / B1023 against real Postgres (DB lane, run by the prover on the compose DB; the builder does not run it).
 * GET /bookkeeping/transactions/:id/pdf reaches the tenant renderer: a real invoice id of the caller's tenant
 * gives a URL, and another tenant's invoice id is a 404 (forTenant()), never a leak.
 *
 * SAFETY: rows live under two throwaway `qa-b444-<sfx>` tenants (`assertTestTenant`); `afterAll` deletes exactly
 * those rows in FK order. The PDF library, template and storage are stubbed: this spec proves the tenant scope.
 */
import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async () => Buffer.from("%PDF")),
}));
jest.mock("../invoices/invoice-pdf-template", () => ({ InvoicePdfTemplate: () => null }));
jest.mock("../vendor-bills/vendor-bills.service", () => ({ VendorBillsService: jest.fn() }));

import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { BookkeepingService } from "./bookkeeping.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "bookkeeping.pdf-download-b444.db.spec.ts";
const sfx = randomUUID().slice(0, 8);
const T_A = `qa-b444-${sfx}-a`;
const T_B = `qa-b444-${sfx}-b`;
const SLUG_A = assertTestTenant(`qa-b444-${sfx}-a`, SPEC);
const SLUG_B = assertTestTenant(`qa-b444-${sfx}-b`, SPEC);
const U_A = randomUUID();
const U_B = randomUUID();
const C_A = randomUUID();
const C_B = randomUUID();
const INV_A = randomUUID();
const INV_B = randomUUID();

describeDb("B444 bookkeeping pdf download is tenant-scoped (real Postgres)", () => {
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let service: BookkeepingService;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const storage = {
      upload: jest.fn().mockResolvedValue(undefined),
      presignedUrl: jest.fn(async (key: string) => `https://r2.example.com/${key}`),
      download: jest.fn(),
    };
    const systemConfig = { getAll: jest.fn().mockResolvedValue({}), get: jest.fn() };
    const pdf = new InvoicePdfService(prisma, storage as any, systemConfig as any);
    const unused = {} as any;
    service = new BookkeepingService(prisma, pdf, unused, unused, unused, unused);

    for (const [t, slug, u, c, inv] of [
      [T_A, SLUG_A, U_A, C_A, INV_A],
      [T_B, SLUG_B, U_B, C_B, INV_B],
    ] as const) {
      await prisma.tenant.create({ data: { id: t, slug, name: `ACME ${slug}` } });
      await prisma.user.create({
        data: { id: u, email: `${u}@example.invalid`, username: u, role: "CUSTOMER", tenantId: t },
      });
      await prisma.customer.create({
        data: {
          id: c,
          userId: u,
          businessName: "Acme Deli",
          contactName: "Sample Contact",
          tenantId: t,
        },
      });
      await prisma.invoice.create({
        data: {
          id: inv,
          customerId: c,
          tenantId: t,
          status: "SENT",
          invoiceNumber: `INV-${sfx}-${t.slice(-1)}`,
          subtotal: 100,
          total: 100,
          dueDate: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    for (const t of [T_A, T_B]) {
      await prisma.invoice.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await prisma.customer.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await prisma.tenantConfig.deleteMany({ where: { tenantId: t } }).catch(() => undefined);
      await prisma.tenant.deleteMany({ where: { id: t } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it("a real invoice id of the caller's tenant gives a URL", async () => {
    const r = await tenantCtx.run(T_A, () => service.getPdfUrl(INV_A));
    expect(r.url).toContain(`invoice-pdfs/${INV_A}.pdf`);
  });

  it("REG-B188 (db): another tenant's invoice id is a 404", async () => {
    await expect(tenantCtx.run(T_A, () => service.getPdfUrl(INV_B))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

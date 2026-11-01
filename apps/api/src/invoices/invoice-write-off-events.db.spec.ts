/**
 * SA-1050 PR-0, real Postgres: the write-off ledger's table rules and the BAD_DEBT default, as the two migration
 * folders leave them. Nothing in the app writes an event yet; this proves the database alone refuses a bad row.
 *
 * Runs only under `npm run local:test:db` (a fresh database, every migration applied). Throwaway `qa-*` tenants.
 */
import { randomUUID } from "crypto";
import { OperatorPermissionGroup, UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);

describeDb("InvoiceWriteOffEvent — real Postgres (SA-1050 PR-0)", () => {
  let prisma: PrismaService;
  let tenantId: string;
  let invoiceId: string;
  let userId: string;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    const slug = assertTestTenant(`qa-wo-${RUN_SUFFIX}`, "invoice-write-off-events.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `write-off ${slug}` } });
    tenantId = tenant.id;
    const buyer = await prisma.user.create({
      data: {
        tenantId,
        role: UserRole.CUSTOMER,
        username: `wo-buyer-${RUN_SUFFIX}`,
        email: `wo-buyer-${RUN_SUFFIX}@example.test`,
      },
    });
    const customer = await prisma.customer.create({
      data: { tenantId, userId: buyer.id, businessName: "Acme Foods", contactName: "Pat" },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `WO-${RUN_SUFFIX}`,
        subtotal: "100.00",
        taxAmount: "7.00",
        total: "107.00",
      },
    });
    invoiceId = invoice.id;
    const user = await prisma.user.create({
      data: {
        tenantId,
        role: UserRole.TENANT_ADMIN,
        username: `wo-admin-${RUN_SUFFIX}`,
        email: `wo-${RUN_SUFFIX}@example.test`,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.invoiceWriteOffEvent.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma?.$disconnect();
  });

  const event = (over: Record<string, unknown> = {}) =>
    prisma.invoiceWriteOffEvent.create({
      data: {
        tenantId,
        invoiceId,
        kind: "WRITE_OFF",
        amount: "107.00",
        preTax: "100.00",
        at: new Date("2026-01-15T00:00:00Z"),
        byId: userId,
        reason: "Customer closed",
        ...over,
      } as never,
    });

  it("stores a dated write-off and its exact negative reinstate", async () => {
    const w = await event();
    const r = await event({
      kind: "REINSTATE",
      amount: "-107.00",
      preTax: "-100.00",
      at: new Date(),
    });
    expect(w.amount.toString()).toBe("107");
    expect(r.amount.toString()).toBe("-107");
    const sum = await prisma.$queryRaw<Array<{ s: string }>>`
      SELECT SUM("amount")::text AS s FROM "InvoiceWriteOffEvent" WHERE "invoiceId" = ${invoiceId}`;
    expect(Number(sum[0].s)).toBe(0);
  });

  it("refuses a write-off that is not positive, or whose pre-tax part exceeds the amount", async () => {
    await expect(event({ amount: "0.00", preTax: "0.00" })).rejects.toThrow();
    await expect(event({ amount: "-5.00", preTax: "-5.00" })).rejects.toThrow();
    await expect(event({ preTax: "107.01" })).rejects.toThrow();
    await expect(event({ preTax: "-0.01" })).rejects.toThrow();
  });

  it("refuses a reinstate that is not negative, or whose pre-tax part leaves its range", async () => {
    await expect(event({ kind: "REINSTATE", amount: "5.00", preTax: "-5.00" })).rejects.toThrow();
    await expect(event({ kind: "REINSTATE", amount: "-5.00", preTax: "1.00" })).rejects.toThrow();
    await expect(event({ kind: "REINSTATE", amount: "-5.00", preTax: "-5.01" })).rejects.toThrow();
  });

  it("allows an undated event only for a write-off with no author (an import)", async () => {
    await expect(event({ at: null, byId: null })).resolves.toBeDefined();
    await expect(event({ at: null, byId: userId })).rejects.toThrow();
    await expect(
      event({ kind: "REINSTATE", amount: "-5.00", preTax: "-5.00", at: null, byId: null }),
    ).rejects.toThrow();
  });

  it("refuses an empty or blank reason", async () => {
    await expect(event({ reason: "" })).rejects.toThrow();
    await expect(event({ reason: "   " })).rejects.toThrow();
  });

  it("deleting a user nulls the author but keeps the event (SetNull)", async () => {
    const other = await prisma.user.create({
      data: {
        tenantId,
        role: UserRole.TENANT_ADMIN,
        username: `wo-gone-${RUN_SUFFIX}`,
        email: `wo-gone-${RUN_SUFFIX}@example.test`,
      },
    });
    const e = await event({ byId: other.id });
    await prisma.user.delete({ where: { id: other.id } });
    const row = await prisma.invoiceWriteOffEvent.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.byId).toBeNull();
  });

  it("an invoice that has events cannot be deleted (Restrict)", async () => {
    await expect(prisma.invoice.delete({ where: { id: invoiceId } })).rejects.toThrow();
  });

  it("Invoice.writtenOffById exists, nullable and empty on a new invoice", async () => {
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect((row as unknown as { writtenOffById: string | null }).writtenOffById).toBeNull();
  });

  it("a new operator is denied BAD_DEBT by default", async () => {
    const op = await prisma.user.create({
      data: {
        tenantId,
        role: UserRole.OPERATOR,
        username: `wo-op-${RUN_SUFFIX}`,
        email: `wo-op-${RUN_SUFFIX}@example.test`,
      },
    });
    expect(op.deniedPermissionGroups).toEqual([OperatorPermissionGroup.BAD_DEBT]);
  });

  // SA-1050 A-3 row 4: on a database that has folder 1 only (folder 2 not yet run, so the column's own default is still
  // '{}'), the new client sends its schema default, so a user.create with no deny list still stores {BAD_DEBT}. Folder 2's
  // DDL is undone inside one rolled-back transaction, so the shared lane database is untouched afterwards.
  it("on a folder-1-only database, user.create with no deny list stores {BAD_DEBT} (the client's default)", async () => {
    class Rollback extends Error {}
    let stored: OperatorPermissionGroup[] | undefined;
    let columnDefault: string | undefined;
    await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE "User" ALTER COLUMN "deniedPermissionGroups" SET DEFAULT '{}'`,
        );
        const rows = await tx.$queryRaw<Array<{ d: string }>>`
          SELECT column_default AS d FROM information_schema.columns
           WHERE table_name = 'User' AND column_name = 'deniedPermissionGroups'`;
        columnDefault = rows[0]?.d;
        const op = await tx.user.create({
          data: {
            tenantId,
            role: UserRole.OPERATOR,
            username: `wo-op1-${RUN_SUFFIX}`,
            email: `wo-op1-${RUN_SUFFIX}@example.test`,
          },
        });
        stored = op.deniedPermissionGroups;
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    // the database default really was the folder-1 one ('{}'), so the value came from the client
    expect(columnDefault).toMatch(/^'\{\}'/);
    expect(stored).toEqual([OperatorPermissionGroup.BAD_DEBT]);
    // and the rollback restored folder 2's column default
    const after = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT column_default AS d FROM information_schema.columns
       WHERE table_name = 'User' AND column_name = 'deniedPermissionGroups'`;
    expect(after[0]?.d).toContain("BAD_DEBT");
  });
});

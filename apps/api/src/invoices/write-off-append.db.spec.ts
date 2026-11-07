/**
 * SA-1050 A-2 (real Postgres): `appendWriteOffEvent` against the real tables and the real tenant extension.
 *
 *   G-b1: two `qa-*` tenants. Under tenant A's context an append for tenant B's invoice throws and writes nothing; with no
 *         context the stored tenantId is the invoice's; under B's own context it is B's too. Without the check, the
 *         create injection writes A's id against B's invoice (the proof is in the PR body).
 *   G-a1 (DB): the REINSTATE is the exact negative of the real DECIMAL(10,2) sums and nets to 0.00 on both columns.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-wob-<run>-<n>` slug (`assertTestTenant`).
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { appendWriteOffEvent, WriteOffLedgerError } from "./invoice-write-off";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-1050 A-2: appendWriteOffEvent tenant and exact negative (real Postgres)", () => {
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
      await prisma.invoiceWriteOffEvent.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.invoice.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A tenant with one WRITTEN_OFF invoice (total 10.70, no payments, so it owes 10.70). */
  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-wob-${RUN}-${seq}-${label}`, "write-off-append.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `wob ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: label, contactName: label, tenantId: tenant.id },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        invoiceNumber: `INV-WOB-${RUN}-${seq}`,
        status: "WRITTEN_OFF",
        subtotal: 10,
        taxAmount: 0.7,
        total: 10.7,
        writeOffReason: "uncollectable",
        writtenOffAt: new Date(),
      },
    });
    return { tenantId: tenant.id, invoiceId: invoice.id };
  }

  const writeOff = {
    kind: "WRITE_OFF" as const,
    amount: 10.7,
    preTax: 10,
    at: new Date(),
    byId: null,
    reason: "uncollectable",
  };
  const eventsOf = (invoiceId: string) =>
    prisma.invoiceWriteOffEvent.findMany({ where: { invoiceId } });

  it("G-b1: under tenant A's context, an append for tenant B's invoice throws and writes nothing", async () => {
    const a = await seed("a");
    const b = await seed("b");
    const lockedB = { id: b.invoiceId, tenantId: b.tenantId }; // read unscoped, as a bypassing caller would

    const err: any = await tenantCtx
      .run(a.tenantId, () =>
        prisma.tenantTransaction((tx) => appendWriteOffEvent({ prisma }, tx, lockedB, writeOff)),
      )
      .catch((e: unknown) => e);

    // First what is stored (without the check this shows A's id against B's invoice), then the refusal.
    const stored = (await eventsOf(b.invoiceId)).map((r) =>
      r.tenantId === a.tenantId ? "tenant A" : r.tenantId === b.tenantId ? "tenant B" : r.tenantId,
    );
    expect(stored).toEqual([]);
    expect(await prisma.invoiceWriteOffEvent.count({ where: { tenantId: a.tenantId } })).toBe(0);
    expect(err).toBeInstanceOf(WriteOffLedgerError);
    expect(String(err.message)).toMatch(/not in the calling tenant/);
  }, 60_000);

  it("G-b1: with no context the stored tenantId is the invoice's", async () => {
    const b = await seed("noctx");

    await prisma.$transaction((tx) =>
      appendWriteOffEvent({ prisma }, tx, { id: b.invoiceId, tenantId: b.tenantId }, writeOff),
    );

    const rows = await eventsOf(b.invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(b.tenantId);
  }, 60_000);

  it("G-b1: under the invoice's own tenant context the stored tenantId is the invoice's", async () => {
    const b = await seed("ownctx");

    await tenantCtx.run(b.tenantId, () =>
      prisma.tenantTransaction((tx) =>
        appendWriteOffEvent({ prisma }, tx, { id: b.invoiceId, tenantId: b.tenantId }, writeOff),
      ),
    );

    const rows = await eventsOf(b.invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantId).toBe(b.tenantId);
  }, 60_000);

  it("G-b1: a null-tenant locked row is refused", async () => {
    const b = await seed("nulltenant");
    const err: any = await prisma
      .$transaction((tx) =>
        appendWriteOffEvent({ prisma }, tx, { id: b.invoiceId, tenantId: null }, writeOff),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteOffLedgerError);
    expect(await eventsOf(b.invoiceId)).toHaveLength(0);
  }, 60_000);

  it("G-a1 (DB): a REINSTATE is the exact negative of the DECIMAL sums and nets to 0.00 on both columns", async () => {
    const b = await seed("reinstate");
    const locked = { id: b.invoiceId, tenantId: b.tenantId };
    await prisma.$transaction((tx) => appendWriteOffEvent({ prisma }, tx, locked, writeOff));
    await prisma.invoice.update({ where: { id: b.invoiceId }, data: { status: "SENT" } });

    await prisma.$transaction((tx) =>
      appendWriteOffEvent({ prisma }, tx, locked, {
        kind: "REINSTATE",
        at: new Date(),
        byId: null,
        reason: "paid after all",
      }),
    );

    const rows = await eventsOf(b.invoiceId);
    const reinstate = rows.find((r) => r.kind === "REINSTATE")!;
    expect(Number(reinstate.amount)).toBe(-10.7);
    expect(Number(reinstate.preTax)).toBe(-10);
    const agg = await prisma.invoiceWriteOffEvent.aggregate({
      where: { invoiceId: b.invoiceId },
      _sum: { amount: true, preTax: true },
    });
    expect(Number(agg._sum.amount)).toBe(0);
    expect(Number(agg._sum.preTax)).toBe(0);
  }, 60_000);

  it("a write-off whose figure misses the confirmed balance throws and the transaction writes nothing", async () => {
    const b = await seed("miss");
    const err: any = await prisma
      .$transaction((tx) =>
        appendWriteOffEvent(
          { prisma },
          tx,
          { id: b.invoiceId, tenantId: b.tenantId },
          { ...writeOff, amount: 10.69 },
        ),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteOffLedgerError);
    expect(await eventsOf(b.invoiceId)).toHaveLength(0);
  }, 60_000);
});

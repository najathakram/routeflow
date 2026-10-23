/**
 * Row 616 DB twin — real Postgres. The unit spec mocks Prisma, so it cannot prove the three
 * things only a real client shows: the `invoice` relation select on InvoicePayment, the
 * compare-and-set on a NULL `internalNotes` / `notes` (`where: { notes: null }` must match a
 * null column), and the AdvancePayment path (on-account credit booked from the same
 * PaymentIntent). The method filter is proven too: a cash payment whose free-text reference
 * happens to equal the PaymentIntent id is never flagged.
 *
 * Throwaway `qa-*` tenant (assertTestTenant); afterAll deletes what it made. DB lane, run by F2.
 * `forTenant()` is modelled by the plain client: every row here belongs to the one fixture tenant.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ConnectChargeReviewService } from "./connect-charge-review.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("row 616 connect charge review flag (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let tenantId: string;
  let customerId: string;
  const run = randomUUID().slice(0, 8);
  const sent: string[] = [];
  let service: ConnectChargeReviewService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const slug = assertTestTenant(`qa-r616-${run}`, "connect-charge-review.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: slug } });
    tenantId = tenant.id;
    const cust = await prisma.user.create({
      data: {
        email: `c-${slug}@example.invalid`,
        username: `c-${slug}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    await prisma.user.create({
      data: {
        email: `o-${slug}@example.invalid`,
        username: `o-${slug}`,
        role: "OPERATOR",
        status: "ACTIVE",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: cust.id, businessName: "Fixture", contactName: "Fixture", tenantId },
    });
    customerId = customer.id;

    service = new ConnectChargeReviewService(
      { forTenant: () => prisma, user: prisma.user } as any,
      { run: (_id: string, fn: () => unknown) => fn() } as any,
      {
        sendToUser: async (id: string) => {
          sent.push(id);
          return 1;
        },
      } as any,
      { log: async () => undefined } as any,
    );
  });

  afterAll(async () => {
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
    await pool.end();
  });

  const input = (pi: string, eventId: string) => ({
    tenantId,
    kind: "refund" as const,
    eventId,
    paymentIntentId: pi,
    chargeId: "ch_db",
  });

  async function invoiceWithPayment(pi: string, method: "CREDIT_CARD" | "CASH", n: string) {
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-R616-${run}-${n}`,
        status: "PAID",
        subtotal: 50,
        total: 50,
      },
    });
    await prisma.invoicePayment.create({
      data: { invoiceId: invoice.id, tenantId, amount: 50, method, reference: pi },
    });
    return invoice;
  }

  it("flags a NULL-notes invoice, leaves status and amounts alone, and is idempotent", async () => {
    const pi = `pi_db_inv_${run}`;
    const invoice = await invoiceWithPayment(pi, "CREDIT_CARD", "1");

    await expect(service.flagForReview(input(pi, `evt_a_${run}`))).resolves.toBe("flagged");
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.internalNotes).toContain(`evt_a_${run}`);
    expect(after.status).toBe("PAID");
    expect(Number(after.total)).toBe(50);
    expect(sent.length).toBe(1);

    await expect(service.flagForReview(input(pi, `evt_a_${run}`))).resolves.toBe("already_flagged");
    expect(sent.length).toBe(1);
    const again = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(again.internalNotes).toBe(after.internalNotes);
  });

  it("flags an advance-only (on-account credit) settlement", async () => {
    const pi = `pi_db_adv_${run}`;
    const adv = await prisma.advancePayment.create({
      data: {
        tenantId,
        customerId,
        amount: 20,
        balance: 20,
        method: "CREDIT_CARD",
        reference: pi,
      },
    });

    await expect(service.flagForReview(input(pi, `evt_b_${run}`))).resolves.toBe("flagged");
    const after = await prisma.advancePayment.findUniqueOrThrow({ where: { id: adv.id } });
    expect(after.notes).toContain(`evt_b_${run}`);
    expect(Number(after.balance)).toBe(20);
  });

  it("a split payment flags both the invoice and the advance", async () => {
    const pi = `pi_db_split_${run}`;
    const invoice = await invoiceWithPayment(pi, "CREDIT_CARD", "2");
    const adv = await prisma.advancePayment.create({
      data: {
        tenantId,
        customerId,
        amount: 5,
        balance: 5,
        method: "CREDIT_CARD",
        reference: pi,
      },
    });

    await expect(service.flagForReview(input(pi, `evt_c_${run}`))).resolves.toBe("flagged");
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).internalNotes,
    ).toContain(`evt_c_${run}`);
    expect(
      (await prisma.advancePayment.findUniqueOrThrow({ where: { id: adv.id } })).notes,
    ).toContain(`evt_c_${run}`);
  });

  it("a cash payment with a pi_ lookalike reference is never flagged", async () => {
    const pi = `pi_db_cash_${run}`;
    const invoice = await invoiceWithPayment(pi, "CASH", "3");

    await expect(service.flagForReview(input(pi, `evt_d_${run}`))).resolves.toBe(
      "no_matching_payment",
    );
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.internalNotes).toBeNull();
  });
});

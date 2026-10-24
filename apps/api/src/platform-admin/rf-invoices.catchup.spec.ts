import { RfInvoicesAdminService } from "./rf-invoices.service";
import { CatchupClaimService } from "../billing/catchup-claim.service";
import { RF_INVOICE_CANDIDATE_WHERE } from "../billing/rf-invoice/rf-invoice-issuer.service";
import { fakeCatchupDb } from "../testing/fake-catchup-db";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-733r M5 / r3 N2: while a tenant's October catch-up claim is held, staff cannot record a payment on (or
 * reopen) its RfInvoice - the 409 is raised INSIDE the invoice's transaction, after the Tenant row lock - and the
 * issuer skips the tenant. The real-Postgres twin is billing/catchup-claim.db.spec.ts.
 */

const NOW = new Date("2026-10-09T12:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  tenantId: "t1",
  number: "RF-2026-0001",
  amount: 149,
  currency: "USD",
  cycle: "MONTHLY",
  status: "OPEN",
  periodStart: new Date("2026-10-01T12:00:00Z"),
  periodEnd: new Date("2026-11-01T12:00:00Z"),
  periodKey: "2026-10-01T12:00:00.000Z",
  issuedAt: new Date("2026-09-24T12:00:00Z"),
  dueDate: new Date("2026-10-01T12:00:00Z"),
  lastSentAt: null,
  sendCount: 0,
  paidAt: null,
  paidMethod: null,
  paidRef: null,
  lines: [],
  needsReview: false,
  tenant: { name: "Acme", slug: "acme", status: "ACTIVE", subscription: { stripeSubId: null } },
  ...over,
});

function make(claimState: string | null, invoice = row()) {
  const db = fakeCatchupDb({
    subs: [
      {
        tenantId: "t1",
        catchupState: claimState,
        cycle: "MONTHLY",
        planKey: "STARTER",
        periodStart: new Date("2026-10-01T12:00:00Z"),
        periodEnd: new Date("2026-11-01T12:00:00Z"),
        cancelAtPeriodEnd: false,
        tenant: { status: "ACTIVE", class: "PRODUCTION", deletedAt: null, slug: "acme" },
      },
    ],
    invoices: [invoice],
  });
  const prisma: any = {
    ...db.prisma,
    tenant: { findFirst: jest.fn(async () => ({ id: "t1" })) },
  };
  const issuer = { windowsFor: jest.fn(async () => []), issuePeriod: jest.fn() };
  const claim = new CatchupClaimService(prisma, {} as any, { emit: jest.fn() } as any);
  const svc = new RfInvoicesAdminService(prisma, {} as any, issuer as any, claim);
  return { svc, db, issuer, status: () => db.invoices[0].status };
}

const paid = (t: ReturnType<typeof make>) =>
  t.svc.markPaid("inv-1", { method: "CASH" }, "sa-1", NOW);

describe("recording a payment while a catch-up claim is held", () => {
  it("no claim: the payment is recorded, after the Tenant row lock", async () => {
    const t = make(null);
    await expect(paid(t)).resolves.toMatchObject({ status: "PAID" });
    expect(t.db.locks).toEqual(["t1"]);
  });

  it("SESSION_OPEN: 409 CATCHUP_SESSION_OPEN, the invoice stays OPEN, no audit row", async () => {
    const t = make("SESSION_OPEN");
    await expect(paid(t)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_SESSION_OPEN },
      status: 409,
    });
    expect(t.status()).toBe("OPEN");
    expect(t.db.audits).toHaveLength(0);
  });

  it.each(["AWAITING_FIRST_PAYMENT", "RELEASING"])("%s: 409 CATCHUP_PENDING", async (state) => {
    const t = make(state);
    await expect(paid(t)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_PENDING },
      status: 409,
    });
    expect(t.status()).toBe("OPEN");
  });

  it("reopening a PAID invoice is refused the same way", async () => {
    const t = make("AWAITING_FIRST_PAYMENT", row({ status: "PAID" }));
    await expect(
      t.svc.reopen("inv-1", { reason: "bounced cheque" }, "sa-1", NOW),
    ).rejects.toMatchObject({ response: { code: API_ERROR_CODES.CATCHUP_PENDING } });
    expect(t.status()).toBe("PAID");
  });

  it("voiding is NOT blocked (it removes a charge; it can never double one)", async () => {
    const t = make("SESSION_OPEN");
    await expect(
      t.svc.voidInvoice("inv-1", { reason: "issued in error" }, "sa-1", NOW),
    ).resolves.toMatchObject({ status: "VOID" });
  });

  it("issuing on demand is refused while the claim is held", async () => {
    process.env.RF_INVOICING_MODE = "live";
    try {
      const t = make("SESSION_OPEN");
      await expect(t.svc.issueForTenant("t1", "sa-1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.CATCHUP_SESSION_OPEN },
      });
      expect(t.issuer.windowsFor).not.toHaveBeenCalled();
    } finally {
      delete process.env.RF_INVOICING_MODE;
    }
  });
});

describe("the issuer skips a tenant with a claim (r2: the 7-day-lead issuer too)", () => {
  it("RF_INVOICE_CANDIDATE_WHERE requires catchupState = null (the cron and the admin summary share it)", () => {
    expect(RF_INVOICE_CANDIDATE_WHERE.catchupState).toBeNull();
  });
});

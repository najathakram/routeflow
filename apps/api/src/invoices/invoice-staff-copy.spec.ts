import { Test } from "@nestjs/testing";
import { EmailService } from "../email/email.service";
import { resolveInvoiceCopyRecipient, sendInvoiceStaffCopy } from "./invoice-staff-copy";

/**
 * W-1443 (SA-1516) T1-T8: who gets the private copy of an invoice email, and that sending it never
 * throws. EmailService is mocked at the module boundary; nothing is delivered. Fixtures use acme.
 */
type Row = { email: string } | null;

function makePrisma(opts: { user?: Row; pref?: string | null; tenantId?: string | null } = {}) {
  const user = { findFirst: jest.fn().mockResolvedValue(opts.user ?? null) };
  const userPreference = {
    findUnique: jest.fn().mockResolvedValue(opts.pref == null ? null : { value: opts.pref }),
  };
  return {
    prisma: {
      getTenantId: () => (opts.tenantId === undefined ? "t1" : opts.tenantId),
      forTenant: () => ({ user, userPreference }),
    } as any,
    user,
    userPreference,
  };
}

const operator = { email: "ops@acme.test" };

describe("resolveInvoiceCopyRecipient (R2)", () => {
  it("T1: opted-in active operator with a distinct address -> that address", async () => {
    const { prisma } = makePrisma({ user: operator, pref: "true" });
    expect(await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test")).toBe(
      "ops@acme.test",
    );
  });

  it("T2: preference absent -> null (opt-in, not opt-out)", async () => {
    const { prisma } = makePrisma({ user: operator, pref: null });
    expect(await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test")).toBeNull();
  });

  it.each(["false", "TRUE", "yes", ""])("T3: preference %p -> null", async (v) => {
    const { prisma } = makePrisma({ user: operator, pref: v });
    expect(await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test")).toBeNull();
  });

  it("T4: no actor (recurring or system send) -> null and no database read", async () => {
    const { prisma, user, userPreference } = makePrisma({ user: operator, pref: "true" });
    expect(await resolveInvoiceCopyRecipient(prisma, null, "buyer@acme.test")).toBeNull();
    expect(user.findFirst).not.toHaveBeenCalled();
    expect(userPreference.findUnique).not.toHaveBeenCalled();
  });

  it("T5: the user lookup is tenant-scoped, ACTIVE, not deleted, and TENANT_ADMIN or OPERATOR only", async () => {
    const { prisma, user } = makePrisma({ user: operator, pref: "true" });
    await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test");
    expect(user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "u1",
          tenantId: "t1",
          status: "ACTIVE",
          deletedAt: null,
          role: { in: ["TENANT_ADMIN", "OPERATOR"] },
        },
      }),
    );
  });

  it("T5: a user the lookup does not return (super admin, driver, deleted, other tenant) -> null, preference never read", async () => {
    const { prisma, userPreference } = makePrisma({ user: null, pref: "true" });
    expect(await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test")).toBeNull();
    expect(userPreference.findUnique).not.toHaveBeenCalled();
  });

  it("T5: no tenant in scope -> null", async () => {
    const { prisma } = makePrisma({ user: operator, pref: "true", tenantId: null });
    expect(await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test")).toBeNull();
  });

  it("T6: the staff address equals the customer address in another case -> null", async () => {
    const { prisma } = makePrisma({ user: { email: "Acme@x.test" }, pref: "true" });
    expect(await resolveInvoiceCopyRecipient(prisma, "u1", "acme@x.test")).toBeNull();
  });

  it("T6: the customer field holds several addresses and one is the staff address -> null", async () => {
    const { prisma } = makePrisma({ user: operator, pref: "true" });
    expect(
      await resolveInvoiceCopyRecipient(prisma, "u1", "a@acme.test; OPS@acme.test"),
    ).toBeNull();
  });

  it.each(["no-email+1@placeholder.local", "x@imported.local", "not-an-address", "  "])(
    "T8: unusable staff address %p -> null",
    async (email) => {
      const { prisma } = makePrisma({ user: { email }, pref: "true" });
      expect(await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test")).toBeNull();
    },
  );

  it("trims the staff address", async () => {
    const { prisma } = makePrisma({ user: { email: "  ops@acme.test " }, pref: "true" });
    expect(await resolveInvoiceCopyRecipient(prisma, "u1", "buyer@acme.test")).toBe(
      "ops@acme.test",
    );
  });
});

describe("sendInvoiceStaffCopy (R3)", () => {
  const attachment = { filename: "Invoice-INV-1.pdf", content: Buffer.from("x"), contentType: "a" };
  const payload = { to: "buyer@acme.test", invoiceId: "inv-1", attachment } as any;
  let sendInvoice: jest.Mock;
  let logger: { warn: jest.Mock };

  async function deps(prismaOpts: Parameters<typeof makePrisma>[0]) {
    const mod = await Test.createTestingModule({
      providers: [{ provide: EmailService, useValue: { sendInvoice } }],
    }).compile();
    return {
      prisma: makePrisma(prismaOpts).prisma,
      emailService: mod.get(EmailService),
      logger,
    } as any;
  }

  beforeEach(() => {
    sendInvoice = jest.fn().mockResolvedValue({ delivered: true });
    logger = { warn: jest.fn() };
  });

  it("T1: sends ONE more email to the staff address with the customer's own payload and attachment", async () => {
    const d = await deps({ user: operator, pref: "true" });
    const res = await sendInvoiceStaffCopy(d, {
      emailPayload: payload,
      actorId: "u1",
      customerTo: "buyer@acme.test",
    });
    expect(res).toEqual({ copiedTo: "ops@acme.test" });
    expect(sendInvoice).toHaveBeenCalledTimes(1);
    const sent = sendInvoice.mock.calls[0][0];
    expect(sent.to).toBe("ops@acme.test");
    expect(sent.staffCopy).toEqual({ sentTo: "buyer@acme.test" });
    expect(sent.attachment).toBe(attachment);
    expect(payload.to).toBe("buyer@acme.test"); // the customer's payload is not mutated
  });

  it("T2/T4: not opted in, or no actor -> no copy call and {}", async () => {
    const off = await deps({ user: operator, pref: null });
    expect(
      await sendInvoiceStaffCopy(off, {
        emailPayload: payload,
        actorId: "u1",
        customerTo: "b@x.test",
      }),
    ).toEqual({});
    expect(
      await sendInvoiceStaffCopy(off, {
        emailPayload: payload,
        actorId: null,
        customerTo: "b@x.test",
      }),
    ).toEqual({});
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("T7: the copy throws -> resolves {} (never rejects) and logs", async () => {
    sendInvoice.mockRejectedValue(new Error("smtp down"));
    const d = await deps({ user: operator, pref: "true" });
    await expect(
      sendInvoiceStaffCopy(d, { emailPayload: payload, actorId: "u1", customerTo: "b@x.test" }),
    ).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalled();
  });

  it("T7: the copy returns delivered:false -> {} (no copiedTo)", async () => {
    sendInvoice.mockResolvedValue({ delivered: false, error: "bounced" });
    const d = await deps({ user: operator, pref: "true" });
    expect(
      await sendInvoiceStaffCopy(d, {
        emailPayload: payload,
        actorId: "u1",
        customerTo: "b@x.test",
      }),
    ).toEqual({});
  });

  it("T7: the preference read itself throws -> {} and no send", async () => {
    const d = await deps({ user: operator, pref: "true" });
    d.prisma = {
      getTenantId: () => "t1",
      forTenant: () => ({
        user: { findFirst: jest.fn().mockRejectedValue(new Error("db")) },
        userPreference: { findUnique: jest.fn() },
      }),
    };
    expect(
      await sendInvoiceStaffCopy(d, {
        emailPayload: payload,
        actorId: "u1",
        customerTo: "b@x.test",
      }),
    ).toEqual({});
    expect(sendInvoice).not.toHaveBeenCalled();
  });
});

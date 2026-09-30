import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ConflictException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { BuyerService } from "./buyer.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import type { RequestSellerDto } from "./dto/request-seller.dto";

/**
 * Security regression pin for `BuyerService.requestSeller` (buyer-connect
 * account-takeover fix).
 *
 * Before this fix, `requestSeller` auto-approved a connection whenever the email
 * the buyer TYPED (`emailAtSeller`) matched a seller's customer record — it never
 * compared that claim against the email the buyer actually authenticated with.
 * Any buyer could type any customer's email and instantly claim that account's
 * invoices, orders, and pricing.
 *
 * These specs pin the fix: ACTIVE (auto-connect) is reachable ONLY when the
 * SIGN-IN email (`BuyerAccount.email`) matches the customer record (or its
 * linked `User.email`) — a typed-email-only match becomes a
 * `PENDING_SELLER_APPROVAL` request instead, notified out via socket + email
 * (both fire-and-forget), never blocking or failing the request.
 *
 * Second gate (closes the #378 residual exposure): the sign-in email must also
 * be VERIFIED (`BuyerAccount.emailVerified`). Registration issues tokens with
 * no mailbox check, so a matching-but-unverified account — exactly what an
 * attacker gets by registering under a victim customer's address — must fall
 * into the pending path too. Both gates are independent: a verified
 * non-matching account (the impostor cases below) stays pending as well.
 */

const TENANT = {
  id: "tenant-1",
  slug: "acme-foods",
  name: "Acme Foods",
  status: "ACTIVE",
};

const DTO: RequestSellerDto = {
  sellerSlug: "acme-foods",
  emailAtSeller: "buyer@example.com",
};

function makeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: "cust-1",
    businessName: "Retail Corner",
    email: "buyer@example.com",
    user: { email: "login@example.com" },
    ...overrides,
  };
}

describe("BuyerService.requestSeller — identity-gated auto-connect (security)", () => {
  let service: BuyerService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };
  let gateway: { emitBuyerAutoLinked: jest.Mock; emitBuyerConnectRequest: jest.Mock };

  // Notification fan-out (`notifySellerOfRequest`) is fired with `void` and never
  // awaited by `requestSeller` — flush the microtask queue before asserting on it.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue({ delivered: true }) };
    gateway = { emitBuyerAutoLinked: jest.fn(), emitBuyerConnectRequest: jest.fn() };

    prisma.tenant.findUnique.mockResolvedValue(TENANT as any);
    prisma.tenantConfig.findFirst.mockResolvedValue({ businessName: "Acme Foods" } as any);
    prisma.user.findMany.mockResolvedValue([{ email: "ops@acme-foods.example" }] as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: RouteFlowGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get(BuyerService);
  });

  it("1. sign-in email matches customer.email -> ACTIVE, autolinked emitted, no email helper call", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "buyer@example.com",
      name: "Buyer One",
      emailVerified: true,
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue(null);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-1" } as any);

    const result = await service.requestSeller("buyer-1", DTO);
    await flush();

    expect(prisma.customerLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "cust-1" },
        create: expect.objectContaining({ status: "ACTIVE", buyerAccountId: "buyer-1" }),
      }),
    );
    expect(result.linkId).toBe("link-1");
    expect(result.message).toContain("Connected!");
    expect(gateway.emitBuyerAutoLinked).toHaveBeenCalledWith("tenant-1", {
      customerId: "cust-1",
      customerName: "Retail Corner",
      buyerName: "Buyer One",
      buyerEmail: "buyer@example.com",
    });
    expect(gateway.emitBuyerConnectRequest).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled(); // notifySellerOfRequest never invoked
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("1b. sign-in email matches but account is UNVERIFIED -> PENDING with verification hint, never ACTIVE", async () => {
    // The #378 residual exposure: registration issues tokens with no mailbox
    // check, so a matching-but-unverified account is exactly what an attacker
    // gets by registering under a victim customer's address.
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "buyer@example.com", // matches the customer record...
      name: "Attacker Or Owner",
      emailVerified: false, // ...but the mailbox was never proven
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue(null);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-1b" } as any);

    const result = await service.requestSeller("buyer-1b", DTO);
    await flush();

    expect(JSON.stringify(prisma.customerLink.upsert.mock.calls)).not.toContain("ACTIVE");
    expect(prisma.customerLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "PENDING_SELLER_APPROVAL" }),
      }),
    );
    expect(result.pending).toBe(true);
    expect(result.needsEmailVerification).toBe(true);
    expect(result.message).toContain("verifying");
    expect(gateway.emitBuyerAutoLinked).not.toHaveBeenCalled();
    expect(gateway.emitBuyerConnectRequest).toHaveBeenCalled(); // seller still reviews it
  });

  it("2. sign-in email matches the linked user.email (not customer.email) -> ACTIVE", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "login@example.com",
      name: "Buyer Two",
      emailVerified: true,
    } as any);
    prisma.customer.findFirst.mockResolvedValue(
      makeCustomer({
        email: "someone-else@example.com",
        user: { email: "login@example.com" },
      }) as any,
    );
    prisma.customerLink.findFirst.mockResolvedValue(null);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-2" } as any);

    const result = await service.requestSeller("buyer-2", DTO);

    expect(prisma.customerLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: "ACTIVE" }) }),
    );
    expect(result.message).toContain("Connected!");
    expect(gateway.emitBuyerAutoLinked).toHaveBeenCalled();
  });

  it("3. typed email matches a customer but sign-in email does not -> PENDING, never ACTIVE; both notification paths fired", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "impostor@evil.example",
      name: "Impostor",
      emailVerified: true, // verified — but verification alone must never grant access
    } as any);
    // Customer's real emails: buyer@example.com / login@example.com — the impostor
    // typed one of these into `emailAtSeller` but never authenticated as it.
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue(null);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-3" } as any);

    const result = await service.requestSeller("buyer-3", DTO);
    await flush();

    // upsert (not create) because `customerId` is @unique and two concurrent requests
    // both read no existing row; either way NEITHER payload may say ACTIVE.
    expect(prisma.customerLink.upsert).toHaveBeenCalledWith({
      where: { customerId: "cust-1" },
      create: {
        status: "PENDING_SELLER_APPROVAL",
        buyerAccountId: "buyer-3",
        tenantId: "tenant-1",
        customerId: "cust-1",
      },
      update: { status: "PENDING_SELLER_APPROVAL", buyerAccountId: "buyer-3" },
    });
    expect(JSON.stringify(prisma.customerLink.upsert.mock.calls)).not.toContain("ACTIVE");
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
    expect(result.pending).toBe(true);
    expect(result.message).not.toContain("Connected!");

    expect(gateway.emitBuyerConnectRequest).toHaveBeenCalledWith(
      "tenant-1",
      expect.objectContaining({
        customerId: "cust-1",
        customerName: "Retail Corner",
        buyerName: "Impostor",
        buyerEmail: "impostor@evil.example",
      }),
    );
    expect(gateway.emitBuyerAutoLinked).not.toHaveBeenCalled();
    expect(prisma.user.findMany).toHaveBeenCalled(); // notifySellerOfRequest ran
    expect(emailService.send).toHaveBeenCalled();
  });

  it("4. case-insensitivity both directions (sign-in email vs. customer email, and typed email vs. customer email)", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "Buyer@Example.com",
      name: "Buyer One",
      emailVerified: true,
    } as any);
    prisma.customer.findFirst.mockResolvedValue(
      makeCustomer({ email: "buyer@example.com" }) as any,
    );
    prisma.customerLink.findFirst.mockResolvedValue(null);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-4" } as any);

    const result = await service.requestSeller("buyer-4", {
      sellerSlug: "acme-foods",
      emailAtSeller: "BUYER@EXAMPLE.COM",
    });

    expect(prisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ email: "buyer@example.com" }, { user: { email: "buyer@example.com" } }],
        }),
      }),
    );
    expect(prisma.customerLink.upsert).toHaveBeenCalled();
    expect(result.message).toContain("Connected!");
  });

  it("5. existing PENDING same buyer + still unproven -> idempotent, zero writes, zero notifications", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "impostor@evil.example",
      name: "Impostor",
      emailVerified: true, // verified — but verification alone must never grant access
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue({
      id: "link-5",
      status: "PENDING_SELLER_APPROVAL",
      buyerAccountId: "buyer-5",
    } as any);

    const result = await service.requestSeller("buyer-5", DTO);
    await flush();

    expect(result.pending).toBe(true);
    expect(result.linkId).toBe("link-5");
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
    expect(prisma.customerLink.create).not.toHaveBeenCalled();
    expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
    expect(gateway.emitBuyerConnectRequest).not.toHaveBeenCalled();
    expect(gateway.emitBuyerAutoLinked).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("5b. existing PENDING same buyer + matching-but-unverified -> idempotent no-op (no bell spam)", async () => {
    // Unverified counts as unproven, so the idempotent PENDING branch applies —
    // resubmitting must not re-notify the seller or rewrite the row.
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "buyer@example.com",
      name: "Unverified Owner",
      emailVerified: false,
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue({
      id: "link-5b",
      status: "PENDING_SELLER_APPROVAL",
      buyerAccountId: "buyer-5b",
    } as any);

    const result = await service.requestSeller("buyer-5b", DTO);
    await flush();

    expect(result.pending).toBe(true);
    expect(result.linkId).toBe("link-5b");
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
    expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
    expect(gateway.emitBuyerConnectRequest).not.toHaveBeenCalled();
    expect(gateway.emitBuyerAutoLinked).not.toHaveBeenCalled();
  });

  it("6. existing PENDING same buyer + now proven (sign-in email changed) -> upgraded to ACTIVE", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "buyer@example.com", // now matches the customer record
      name: "Buyer One",
      emailVerified: true,
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue({
      id: "link-6",
      status: "PENDING_SELLER_APPROVAL",
      buyerAccountId: "buyer-6",
    } as any);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-6" } as any);

    const result = await service.requestSeller("buyer-6", DTO);

    expect(prisma.customerLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "cust-1" },
        update: expect.objectContaining({ status: "ACTIVE", buyerAccountId: "buyer-6" }),
      }),
    );
    expect(prisma.customerLink.create).not.toHaveBeenCalled();
    expect(result.message).toContain("Connected!");
    expect(gateway.emitBuyerAutoLinked).toHaveBeenCalled();
  });

  it("7. existing INVITED + unproven request -> PENDING, inviteToken preserved", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "impostor@evil.example",
      name: "Impostor",
      emailVerified: true, // verified — but verification alone must never grant access
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue({
      id: "link-7",
      status: "INVITED",
      buyerAccountId: null,
      inviteToken: "secret-token",
      inviteExpiresAt: new Date("2099-01-01"),
    } as any);
    prisma.customerLink.update.mockResolvedValue({ id: "link-7" } as any);

    const result = await service.requestSeller("buyer-7", DTO);
    await flush();

    // The update data omits inviteToken/inviteExpiresAt entirely, so the true
    // invitee's outstanding token is left untouched.
    expect(prisma.customerLink.update).toHaveBeenCalledWith({
      where: { id: "link-7" },
      data: { status: "PENDING_SELLER_APPROVAL", buyerAccountId: "buyer-7" },
    });
    expect(result.pending).toBe(true);
    expect(gateway.emitBuyerConnectRequest).toHaveBeenCalled();
  });

  it("7b. the true invitee's token still redeems after an unproven request flipped the row to PENDING", async () => {
    // Preserving inviteToken is only worth anything if the token's consumers still honour
    // it — getInviteDetails/acceptInvite gate on status, so a PENDING row that still
    // carries a live token must stay redeemable or the seller's invite is silently dead.
    const requestedAgainstInvite = {
      id: "link-7",
      tenantId: "tenant-1",
      status: "PENDING_SELLER_APPROVAL",
      buyerAccountId: "buyer-7", // the un-proven requester currently on the row
      inviteToken: "secret-token",
      inviteExpiresAt: new Date("2099-01-01"),
      inviteMethod: "EMAIL",
      tenant: { id: "tenant-1", name: "Acme Foods", slug: "acme-foods" },
    };
    prisma.customerLink.findUnique.mockResolvedValue(requestedAgainstInvite as any);
    prisma.customerLink.findFirst.mockResolvedValue(null); // invitee has no other link here
    prisma.customerLink.update.mockResolvedValue({ id: "link-7" } as any);

    await expect(service.getInviteDetails("secret-token")).resolves.toMatchObject({
      sellerSlug: "acme-foods",
    });

    const accepted = await service.acceptInvite("secret-token", "true-invitee");

    expect(accepted.linkId).toBe("link-7");
    // The invitee — not the requester — ends up owning the ACTIVE link, token consumed.
    expect(prisma.customerLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "link-7" },
        data: expect.objectContaining({
          buyerAccountId: "true-invitee",
          status: "ACTIVE",
          inviteToken: null,
        }),
      }),
    );
  });

  it("7c. an un-proven request against a DISCONNECTED row clears its stale invite token", async () => {
    // The seller cancelled an invite by disconnecting the portal. Rows disconnected before
    // the disconnect writers started clearing the token still carry it, so a stranger's
    // un-proven request must not carry that revoked token into PENDING — doing so would
    // make getInviteDetails/acceptInvite honour a link the seller deliberately severed
    // (and a later decline would revert the row to INVITED, resurrecting it for good).
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "impostor@evil.example",
      name: "Impostor",
      emailVerified: true, // verified — but verification alone must never grant access
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue({
      id: "link-7c",
      status: "DISCONNECTED",
      buyerAccountId: null,
      inviteToken: "revoked-token",
      inviteExpiresAt: new Date("2099-01-01"),
    } as any);
    prisma.customerLink.update.mockResolvedValue({ id: "link-7c" } as any);

    const result = await service.requestSeller("buyer-7c", DTO);
    await flush();

    expect(prisma.customerLink.update).toHaveBeenCalledWith({
      where: { id: "link-7c" },
      data: {
        status: "PENDING_SELLER_APPROVAL",
        buyerAccountId: "buyer-7c",
        inviteToken: null,
        inviteExpiresAt: null,
      },
    });
    expect(result.pending).toBe(true);

    // With the token gone the emailed link no longer resolves to anything.
    prisma.customerLink.findUnique.mockResolvedValue(null);
    await expect(service.getInviteDetails("revoked-token")).rejects.toThrow(NotFoundException);
  });

  it("8. existing PENDING under another buyer + unproven -> 409, no writes", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "impostor@evil.example",
      name: "Impostor",
      emailVerified: true, // verified — but verification alone must never grant access
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue({
      id: "link-8",
      status: "PENDING_SELLER_APPROVAL",
      buyerAccountId: "some-other-buyer",
    } as any);

    await expect(service.requestSeller("buyer-8", DTO)).rejects.toThrow(ConflictException);
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
    expect(prisma.customerLink.create).not.toHaveBeenCalled();
    expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
  });

  it("8b. existing PENDING under another buyer + PROVEN -> the owner takes the row over (no 409)", async () => {
    // A stranger's un-proven request must not lock the legitimate owner out of
    // self-connecting: the PENDING conflict applies only while ownership is unproven.
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "buyer@example.com", // on the customer record — proven
      name: "Buyer One",
      emailVerified: true,
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue({
      id: "link-8b",
      status: "PENDING_SELLER_APPROVAL",
      buyerAccountId: "some-other-buyer",
    } as any);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-8b" } as any);

    const result = await service.requestSeller("buyer-8b", DTO);

    expect(prisma.customerLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "ACTIVE", buyerAccountId: "buyer-8b" }),
      }),
    );
    expect(result.message).toContain("Connected!");
    expect(gateway.emitBuyerAutoLinked).toHaveBeenCalled();
  });

  it("9. email helper rejection does not fail the request", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "impostor@evil.example",
      name: "Impostor",
      emailVerified: true, // verified — but verification alone must never grant access
    } as any);
    prisma.customer.findFirst.mockResolvedValue(makeCustomer() as any);
    prisma.customerLink.findFirst.mockResolvedValue(null);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-9" } as any);
    // The email helper's own dependency rejects outright (not just an individual
    // send() call) — the request must still resolve, and the socket notification
    // (a separate, synchronous channel) must still fire.
    prisma.user.findMany.mockRejectedValue(new Error("db unavailable"));

    const result = await service.requestSeller("buyer-9", DTO);
    await flush();

    expect(result.pending).toBe(true);
    expect(result.linkId).toBe("link-9");
    expect(gateway.emitBuyerConnectRequest).toHaveBeenCalled();
  });

  it("throws UnauthorizedException when the buyer account behind the token no longer exists", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue(null);

    await expect(service.requestSeller("ghost", DTO)).rejects.toThrow(UnauthorizedException);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});

describe("BuyerService.getSellers — non-ACTIVE customer redaction (security)", () => {
  let service: BuyerService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };
  let gateway: { emitBuyerAutoLinked: jest.Mock; emitBuyerConnectRequest: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue({ delivered: true }) };
    gateway = { emitBuyerAutoLinked: jest.fn(), emitBuyerConnectRequest: jest.fn() };

    prisma.tenant.findUnique.mockResolvedValue(TENANT as any);
    prisma.tenantConfig.findFirst.mockResolvedValue(null);
    prisma.user.findMany.mockResolvedValue([{ email: "ops@acme-foods.example" }] as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: RouteFlowGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get(BuyerService);
  });

  it("ACTIVE link -> customer identity is populated", async () => {
    prisma.customerLink.findMany.mockResolvedValue([
      {
        id: "l1",
        status: "ACTIVE",
        linkedAt: new Date(),
        tenantId: "t1",
        tenant: { id: "t1", name: "Acme", slug: "acme" },
        customer: { id: "c1", businessName: "Retail Corner", email: "c@x.com" },
      },
    ] as any);

    const result = await service.getSellers("buyer-1");

    expect(result).toHaveLength(1);
    expect(result[0].linkStatus).toBe("ACTIVE");
    expect(result[0].customer).toEqual({
      id: "c1",
      businessName: "Retail Corner",
      email: "c@x.com",
    });
    expect(result[0].tenant.name).toBe("Acme");
  });

  it("PENDING_SELLER_APPROVAL link -> customer identity is redacted, tenant branding stays", async () => {
    prisma.customerLink.findMany.mockResolvedValue([
      {
        id: "l2",
        status: "PENDING_SELLER_APPROVAL",
        linkedAt: null,
        tenantId: "t1",
        tenant: { id: "t1", name: "Acme", slug: "acme" },
        customer: { id: "c1", businessName: "Retail Corner", email: "c@x.com" },
      },
    ] as any);

    const result = await service.getSellers("buyer-2");

    expect(result).toHaveLength(1);
    expect(result[0].linkStatus).toBe("PENDING_SELLER_APPROVAL");
    expect(result[0].customer).toBeNull();
    expect(result[0].tenant.name).toBe("Acme");
    expect(result[0].tenant.slug).toBe("acme");
  });

  it("INVITED link -> customer identity is redacted, tenant branding stays", async () => {
    prisma.customerLink.findMany.mockResolvedValue([
      {
        id: "l3",
        status: "INVITED",
        linkedAt: null,
        tenantId: "t1",
        tenant: { id: "t1", name: "Acme", slug: "acme" },
        customer: { id: "c1", businessName: "Retail Corner", email: "c@x.com" },
      },
    ] as any);

    const result = await service.getSellers("buyer-3");

    expect(result).toHaveLength(1);
    expect(result[0].linkStatus).toBe("INVITED");
    expect(result[0].customer).toBeNull();
    expect(result[0].tenant.name).toBe("Acme");
  });
});

// Honest stand-in for Postgres: applies the `where` the service actually sends, so a where-only fix is
// observable (L-081: a mock that injects a fixed result cannot see one). Strict: an unmodelled filter
// shape throws instead of silently matching.
function matchesWhere(row: any, where: any = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "customer") {
      const rel = (cond as any)?.is ?? cond;
      if (
        !rel ||
        !Object.prototype.hasOwnProperty.call(rel, "deletedAt") ||
        rel.deletedAt !== null
      ) {
        throw new Error(`matchesWhere: unsupported customer filter ${JSON.stringify(cond)}`);
      }
      if (row.customer.deletedAt !== null) return false;
      continue;
    }
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as any;
      if ("has" in c) {
        if (!row[key].includes(c.has)) return false;
      } else if ("in" in c) {
        if (!c.in.includes(row[key])) return false;
      } else if ("lte" in c) {
        if (!(row[key] <= c.lte)) return false;
      } else {
        throw new Error(`matchesWhere: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

const REMOVED_AT = new Date("2026-09-01T00:00:00.000Z");

describe("BuyerService.getSellers — removed customer (B141)", () => {
  let service: BuyerService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const sellerLink = (slug: string, deletedAt: Date | null) => ({
    id: `l-${slug}`,
    buyerAccountId: "b-1",
    status: "ACTIVE",
    linkedAt: new Date("2026-08-01"),
    tenantId: `tn-${slug}`,
    tenant: { id: `tn-${slug}`, name: slug, slug },
    customer: {
      id: `c-${slug}`,
      businessName: "Retail Corner",
      email: "c@example.test",
      deletedAt,
    },
  });

  async function boot(removedAt: Date | null) {
    prisma = createMockPrisma();
    const rows = [sellerLink("acme-live", null), sellerLink("acme-removed", removedAt)];
    prisma.customerLink.findMany.mockImplementation((async (args: any) =>
      rows.filter((r) => matchesWhere(r, args?.where))) as any);
    prisma.tenantConfig.findFirst.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: RouteFlowGateway,
          useValue: { emitBuyerAutoLinked: jest.fn(), emitBuyerConnectRequest: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(BuyerService);
  }

  it("REG-B141 T8: GET /buyer/sellers hides a seller whose customer record was removed", async () => {
    await boot(REMOVED_AT);
    expect((await service.getSellers("b-1")).map((s) => s.tenant.slug)).toEqual(["acme-live"]);
  });

  it("B141 P6: getSellers lists a restored seller again", async () => {
    await boot(null);
    expect((await service.getSellers("b-1")).map((s) => s.tenant.slug)).toEqual([
      "acme-live",
      "acme-removed",
    ]);
  });
});

describe("BuyerService reconnect paths — removed customer (B141)", () => {
  let service: BuyerService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };
  let gateway: { emitBuyerAutoLinked: jest.Mock; emitBuyerConnectRequest: jest.Mock };

  // `notifySellerOfRequest` is fired with `void`; flush before asserting it never ran.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  // Where-honoring stand-ins (L-081): a where-only fix is invisible to a mock that injects a
  // fixed row, so these return the removed row ONLY while the caller has not asked for a live one.
  function bootCustomer(deletedAt: Date | null) {
    const row = { ...makeCustomer(), deletedAt };
    prisma.customer.findFirst.mockImplementation((async (args: any) =>
      args?.where?.deletedAt === null && row.deletedAt !== null ? null : row) as any);
  }

  function bootInvite(deletedAt: Date | null) {
    const row = {
      id: "link-r",
      tenantId: "tenant-1",
      status: "INVITED",
      buyerAccountId: null,
      inviteToken: "secret-token",
      inviteExpiresAt: new Date("2099-01-01"),
      inviteMethod: "EMAIL",
      tenant: { id: "tenant-1", name: "Acme Foods", slug: "acme-foods" },
      customer: { id: "cust-1", deletedAt },
    };
    prisma.customerLink.findUnique.mockImplementation((async (args: any) => {
      const rel = args?.where?.customer;
      if (rel?.deletedAt === null && row.customer.deletedAt !== null) return null;
      return row;
    }) as any);
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue({ delivered: true }) };
    gateway = { emitBuyerAutoLinked: jest.fn(), emitBuyerConnectRequest: jest.fn() };

    prisma.tenant.findUnique.mockResolvedValue(TENANT as any);
    prisma.tenantConfig.findFirst.mockResolvedValue({ businessName: "Acme Foods" } as any);
    prisma.user.findMany.mockResolvedValue([{ email: "ops@acme-foods.example" }] as any);
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "buyer@example.com",
      name: "Buyer One",
      emailVerified: true,
    } as any);
    prisma.customerLink.findFirst.mockResolvedValue(null);
    prisma.customerLink.upsert.mockResolvedValue({ id: "link-1" } as any);
    prisma.customerLink.update.mockResolvedValue({ id: "link-r" } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: RouteFlowGateway, useValue: gateway },
      ],
    }).compile();

    service = module.get(BuyerService);
  });

  it("REG-B141 T9: requestSeller refuses a removed customer and writes/notifies nothing", async () => {
    bootCustomer(REMOVED_AT);

    await expect(service.requestSeller("buyer-1", DTO)).rejects.toBeInstanceOf(NotFoundException);
    await flush();

    expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
    expect(gateway.emitBuyerAutoLinked).not.toHaveBeenCalled();
    expect(gateway.emitBuyerConnectRequest).not.toHaveBeenCalled();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it("REG-B141 T10: acceptInvite treats a removed customer's invite as not found", async () => {
    bootInvite(REMOVED_AT);

    await expect(service.acceptInvite("secret-token", "buyer-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
  });

  it("B141 P7: requestSeller still connects a live (or restored) customer", async () => {
    bootCustomer(null);

    const result = await service.requestSeller("buyer-1", DTO);

    expect(result.message).toContain("Connected!");
    expect(prisma.customerLink.upsert).toHaveBeenCalled();
  });

  it("B141 P8: acceptInvite still redeems a live (or restored) customer's invite", async () => {
    bootInvite(null);

    await expect(service.acceptInvite("secret-token", "buyer-1")).resolves.toMatchObject({
      tenantSlug: "acme-foods",
    });
    expect(prisma.customerLink.update).toHaveBeenCalled();
  });
});

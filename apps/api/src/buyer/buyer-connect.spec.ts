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

  it("2. sign-in email matches the linked user.email (not customer.email) -> ACTIVE", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "login@example.com",
      name: "Buyer Two",
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

  it("6. existing PENDING same buyer + now proven (sign-in email changed) -> upgraded to ACTIVE", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      email: "buyer@example.com", // now matches the customer record
      name: "Buyer One",
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

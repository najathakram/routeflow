import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { LEGACY_INVITE_ACCEPT_UNTIL } from "../auth/legacy-link-windows";
import { hashInviteToken } from "../buyer/invite-token";

/**
 * Portal invites on the seller side: a new invite stores only the hash, the emailed link carries
 * the plain token in the URL fragment, and decline / disconnect / approve treat either token
 * column as "a live invite" (the plaintext one only inside the legacy window).
 */
const TENANT_ID = "tenant-1";
const CUSTOMER_ID = "cust-1";
const INSIDE = new Date(LEGACY_INVITE_ACCEPT_UNTIL.getTime() - 60_000);
const AFTER = new Date(LEGACY_INVITE_ACCEPT_UNTIL.getTime() + 60_000);
const NOT_FAKED = [
  "nextTick",
  "setImmediate",
  "clearImmediate",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
] as const;
const at = (now: Date) => jest.useFakeTimers({ now, doNotFake: [...NOT_FAKED] });

const PENDING = {
  id: "link-1",
  customerId: CUSTOMER_ID,
  tenantId: TENANT_ID,
  buyerAccountId: "buyer-1",
  status: "PENDING_SELLER_APPROVAL" as const,
  inviteToken: null as string | null,
  inviteTokenHash: null as string | null,
  inviteExpiresAt: null as Date | null,
  inviteMethod: null,
  linkedAt: null,
  disconnectedAt: null,
  disconnectedBy: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-02T00:00:00.000Z"),
};

describe("Portal invites — hash at rest, fragment in the link", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let email: { send: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        CustomersService,
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: EmailService, useValue: email },
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((k: string) => (k === "WEB_URL" ? "https://app.test" : null)) },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
        },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
      ],
    }).compile();
    service = module.get(CustomersService);
  });

  afterEach(() => jest.useRealTimers());

  describe("sendPortalInvite", () => {
    beforeEach(() => {
      prisma.customer.findFirst.mockResolvedValue({
        id: CUSTOMER_ID,
        tenantId: TENANT_ID,
        email: "buyer@example.com",
        isWalkIn: false,
        user: null,
      } as any);
      prisma.customerLink.upsert.mockResolvedValue({ id: "link-1" } as any);
      prisma.tenantConfig.findFirst.mockResolvedValue({ businessName: "Acme Foods" } as any);
    });

    it("stores only the hash, nulls the plaintext column, and puts the plain token in the URL fragment", async () => {
      const result = await service.sendPortalInvite(CUSTOMER_ID, { method: "EMAIL" }, TENANT_ID);

      const upsert = prisma.customerLink.upsert.mock.calls[0][0] as any;
      const token = result.inviteUrl.split("#t=")[1];
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.inviteUrl).toBe(`https://app.test/buyer/invite#t=${token}`);
      for (const side of [upsert.create, upsert.update]) {
        expect(side).toMatchObject({
          status: "INVITED",
          inviteToken: null,
          inviteTokenHash: hashInviteToken(token),
        });
      }
      // The plain token appears in no stored value.
      expect(JSON.stringify(upsert)).not.toContain(token);
    });

    it("emails the fragment link: no token in the path or the query, and none in the log", async () => {
      const logSpy = jest.spyOn((service as any).logger, "log").mockImplementation(() => {});
      const result = await service.sendPortalInvite(CUSTOMER_ID, { method: "EMAIL" }, TENANT_ID);
      const token = result.inviteUrl.split("#t=")[1];

      const html = email.send.mock.calls[0][0].html as string;
      expect(html).toContain(`https://app.test/buyer/invite#t=${token}`);
      expect(html).not.toContain(`/buyer/invite/${token}`);
      expect(html).not.toContain(`?t=${token}`);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(token.slice(0, 8));
    });

    it("a resend issues a new token and replaces the stored hash", async () => {
      const a = await service.sendPortalInvite(CUSTOMER_ID, { method: "EMAIL" }, TENANT_ID);
      const b = await service.sendPortalInvite(CUSTOMER_ID, { method: "EMAIL" }, TENANT_ID);
      expect(a.inviteUrl).not.toBe(b.inviteUrl);
      const hashes = prisma.customerLink.upsert.mock.calls.map(
        (c) => (c[0] as any).update.inviteTokenHash,
      );
      expect(hashes[0]).not.toBe(hashes[1]);
    });
  });

  describe("declineBuyerRequest — a live invite is either token column", () => {
    const requestedAgainst = (patch: Record<string, unknown>) =>
      prisma.customerLink.findFirst.mockResolvedValue({
        ...PENDING,
        inviteExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
        ...patch,
      } as any);

    it("a hash-only invite reverts the row to INVITED (it is not deleted)", async () => {
      requestedAgainst({ inviteTokenHash: hashInviteToken("t") });

      await expect(service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID)).resolves.toEqual({
        declined: true,
      });

      expect(prisma.customerLink.delete).not.toHaveBeenCalled();
      expect(prisma.customerLink.update).toHaveBeenCalledWith({
        where: { id: "link-1" },
        data: { status: "INVITED", buyerAccountId: null },
      });
    });

    it("a plaintext-only legacy invite reverts to INVITED inside the window", async () => {
      at(INSIDE);
      requestedAgainst({ inviteToken: "legacy-token" });

      await service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID);

      expect(prisma.customerLink.delete).not.toHaveBeenCalled();
      expect(prisma.customerLink.update).toHaveBeenCalled();
    });

    it("a plaintext-only legacy invite no longer counts after the window: the row is deleted", async () => {
      at(AFTER);
      requestedAgainst({ inviteToken: "legacy-token" });

      await service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID);

      expect(prisma.customerLink.delete).toHaveBeenCalledWith({ where: { id: "link-1" } });
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
    });

    it("no token column at all: the row is deleted", async () => {
      requestedAgainst({});
      await service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID);
      expect(prisma.customerLink.delete).toHaveBeenCalled();
    });

    it("an expired hash-only invite: the row is deleted", async () => {
      requestedAgainst({
        inviteTokenHash: hashInviteToken("t"),
        inviteExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      });
      await service.declineBuyerRequest(CUSTOMER_ID, TENANT_ID);
      expect(prisma.customerLink.delete).toHaveBeenCalled();
    });
  });

  describe("disconnectPortal — burns both token columns", () => {
    it("nulls the plaintext and the hash", async () => {
      prisma.customerLink.findFirst.mockResolvedValue({
        ...PENDING,
        status: "INVITED",
        inviteTokenHash: hashInviteToken("t"),
      } as any);

      await service.disconnectPortal(CUSTOMER_ID, TENANT_ID);

      expect(prisma.customerLink.update).toHaveBeenCalledWith({
        where: { id: "link-1" },
        data: expect.objectContaining({
          status: "DISCONNECTED",
          inviteToken: null,
          inviteTokenHash: null,
          inviteExpiresAt: null,
        }),
      });
    });
  });

  describe("listPendingPortalApprovals — the token columns are never echoed to the seller", () => {
    it("drops inviteToken and inviteTokenHash from every row", async () => {
      prisma.customerLink.findMany.mockResolvedValue([
        {
          ...PENDING,
          inviteToken: "legacy-secret",
          inviteTokenHash: "hash-secret",
          customer: { id: CUSTOMER_ID, businessName: "Acme", contactName: null, email: null },
          buyerAccount: { id: "buyer-1", email: "b@example.com", name: "B" },
        },
      ] as any);

      const rows = await service.listPendingPortalApprovals(TENANT_ID);

      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty("inviteToken");
      expect(rows[0]).not.toHaveProperty("inviteTokenHash");
      expect(JSON.stringify(rows)).not.toContain("secret");
      expect(rows[0]).toMatchObject({ id: "link-1", customerName: "Acme", buyerName: "B" });
    });
  });
});

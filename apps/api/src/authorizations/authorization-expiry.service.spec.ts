import { Test } from "@nestjs/testing";
import { NotificationEvent } from "@prisma/client";
import { AuthorizationExpiryService } from "./authorization-expiry.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import { AuditService } from "../audit/audit.service";
import { MessagingService } from "../messaging/messaging.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("AuthorizationExpiryService", () => {
  let service: AuthorizationExpiryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let notifications: { sendToCustomer: jest.Mock; sendToUser: jest.Mock };
  let email: { send: jest.Mock };
  let audit: { log: jest.Mock };
  let messaging: { notify: jest.Mock; notifyEvent: jest.Mock };

  const now = new Date("2026-07-07T12:00:00Z");
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

  beforeEach(async () => {
    prisma = createMockPrisma();
    notifications = {
      sendToCustomer: jest.fn().mockResolvedValue(undefined),
      sendToUser: jest.fn().mockResolvedValue(0),
    };
    email = { send: jest.fn().mockResolvedValue(undefined) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    messaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationExpiryService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: (_id: string, fn: () => any) => fn() } },
        { provide: NotificationsService, useValue: notifications },
        { provide: EmailService, useValue: email },
        { provide: AuditService, useValue: audit },
        { provide: MessagingService, useValue: messaging },
      ],
    }).compile();
    service = mod.get(AuthorizationExpiryService);
    prisma.user.findMany.mockResolvedValue([{ id: "op1", email: "op@acme.com" }]);
    prisma.customer.findUnique.mockResolvedValue({ businessName: "Acme Retail" });
  });

  const auth = (over: Record<string, unknown>) => ({
    id: "a1",
    customerId: "c1",
    trackedCategoryId: "cat",
    expiresAt: null,
    expiringSoonNotifiedBucket: null,
    trackedCategory: { name: "Alcohol", requiresLicense: true },
    ...over,
  });
  const setScans = (toExpire: unknown[], soon: unknown[]) =>
    prisma.customerAuthorization.findMany
      .mockResolvedValueOnce(toExpire)
      .mockResolvedValueOnce(soon);

  describe("bucketFor", () => {
    it("maps days-until-expiry to 30/7/1 (or null)", () => {
      expect(service.bucketFor(days(30), now)).toBe(30);
      expect(service.bucketFor(days(8), now)).toBe(30);
      expect(service.bucketFor(days(7), now)).toBe(7);
      expect(service.bucketFor(days(1), now)).toBe(1);
      expect(service.bucketFor(days(-1), now)).toBeNull(); // already expired
      expect(service.bucketFor(days(40), now)).toBeNull(); // too far out
    });
  });

  describe("processTenant — flip", () => {
    it("flips a VERIFIED past-expiry row to EXPIRED, audits, and notifies both parties", async () => {
      setScans([auth({ expiresAt: days(-1) })], []);
      const r = await service.processTenant("t1", now);
      expect(r.expired).toBe(1);
      expect(prisma.customerAuthorization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "a1" },
          data: expect.objectContaining({ status: "EXPIRED", expiryNotifiedAt: now }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "regulated_authorization.expired", userId: null }),
      );
      expect(notifications.sendToCustomer).toHaveBeenCalled();
      expect(notifications.sendToUser).toHaveBeenCalledWith("op1", expect.anything());
      expect(email.send).toHaveBeenCalled();
    });

    it("SKIPS a non-gated (tobacco, requiresLicense=false) row — no flip, no notify", async () => {
      setScans(
        [
          auth({
            expiresAt: days(-1),
            trackedCategory: { name: "Tobacco", requiresLicense: false },
          }),
        ],
        [],
      );
      const r = await service.processTenant("t1", now);
      expect(r.expired).toBe(0);
      expect(prisma.customerAuthorization.update).not.toHaveBeenCalled();
      expect(notifications.sendToCustomer).not.toHaveBeenCalled();
      expect(messaging.notifyEvent).not.toHaveBeenCalled();
    });
  });

  describe("processTenant — LICENSE_EXPIRING via the messaging engine (P6-5)", () => {
    it("fires LICENSE_EXPIRING once on the EXPIRED flip", async () => {
      setScans([auth({ customerId: "c1", expiresAt: days(-1) })], []);
      await service.processTenant("t1", now);
      expect(messaging.notifyEvent).toHaveBeenCalledTimes(1);
      expect(messaging.notifyEvent).toHaveBeenCalledWith(
        NotificationEvent.LICENSE_EXPIRING,
        expect.objectContaining({
          customerId: "c1",
          senderId: null,
          vars: expect.objectContaining({ expiryDate: expect.stringContaining("2026") }),
        }),
      );
    });

    it("fires nothing for a non-gated (tobacco) row", async () => {
      setScans(
        [
          auth({
            expiresAt: days(-1),
            trackedCategory: { name: "Tobacco", requiresLicense: false },
          }),
        ],
        [],
      );
      await service.processTenant("t1", now);
      expect(messaging.notifyEvent).not.toHaveBeenCalled();
    });

    it("fires LICENSE_EXPIRING once on a fresh expiring-soon warning", async () => {
      setScans([], [auth({ id: "a2", customerId: "c1", expiresAt: days(5) })]); // 5 days → bucket 7
      await service.processTenant("t1", now);
      expect(messaging.notifyEvent).toHaveBeenCalledTimes(1);
      expect(messaging.notifyEvent).toHaveBeenCalledWith(
        NotificationEvent.LICENSE_EXPIRING,
        expect.objectContaining({
          customerId: "c1",
          senderId: null,
          vars: expect.objectContaining({ expiryDate: expect.stringContaining("2026") }),
        }),
      );
    });

    it("fires nothing when the bucket is already stamped (idempotency marker)", async () => {
      setScans([], [auth({ id: "a2", expiresAt: days(5), expiringSoonNotifiedBucket: 7 })]);
      await service.processTenant("t1", now);
      expect(messaging.notifyEvent).not.toHaveBeenCalled();
    });
  });

  describe("processTenant — expiring-soon warnings (idempotent per bucket)", () => {
    it("warns once and stamps the bucket", async () => {
      setScans([], [auth({ id: "a2", expiresAt: days(5) })]); // 5 days → bucket 7
      const r = await service.processTenant("t1", now);
      expect(r.warned).toBe(1);
      expect(prisma.customerAuthorization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { expiringSoonNotifiedBucket: 7 } }),
      );
    });

    it("does NOT re-warn the same bucket (idempotency marker)", async () => {
      setScans([], [auth({ id: "a2", expiresAt: days(5), expiringSoonNotifiedBucket: 7 })]);
      const r = await service.processTenant("t1", now);
      expect(r.warned).toBe(0);
      expect(prisma.customerAuthorization.update).not.toHaveBeenCalled();
    });

    it("DOES warn again when the bucket shrinks (7 → 1)", async () => {
      setScans([], [auth({ id: "a2", expiresAt: days(1), expiringSoonNotifiedBucket: 7 })]);
      const r = await service.processTenant("t1", now);
      expect(r.warned).toBe(1);
      expect(prisma.customerAuthorization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { expiringSoonNotifiedBucket: 1 } }),
      );
    });
  });

  describe("runExpirySweep", () => {
    it("only sweeps active tenants that run a license-required program", async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
      prisma.trackedCategory.findMany.mockResolvedValue([{ tenantId: "t1" }]); // only t1 is gated
      const spy = jest.spyOn(service, "processTenant").mockResolvedValue({ expired: 0, warned: 0 });
      await service.runExpirySweep();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("t1");
    });
  });
});

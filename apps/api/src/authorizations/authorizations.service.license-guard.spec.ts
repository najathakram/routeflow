import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AuthorizationsService } from "./authorizations.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B964-1: CustomerAuthorization.licenseNumber (printed byte-verbatim on regulated filings) refuses a leading = + - @ TAB CR LF on
 * submit (buyer-typed), create (wholesaler-added) and renew, with the readable label message, BEFORE any authorization write.
 * The writers spread a `data` variable, so the scan cannot see them: these pins are the proof.
 */
describe("AuthorizationsService license-number guard (B964-1)", () => {
  let service: AuthorizationsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };
  let notifications: { sendToUser: jest.Mock; sendToCustomer: jest.Mock };
  let email: { send: jest.Mock };
  const user = { sub: "u1", username: "operator1", role: "OPERATOR" } as any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    notifications = {
      sendToUser: jest.fn().mockResolvedValue(1),
      sendToCustomer: jest.fn().mockResolvedValue(1),
    };
    email = { send: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        AuthorizationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: NotificationsService, useValue: notifications },
        { provide: EmailService, useValue: email },
      ],
    }).compile();
    service = mod.get(AuthorizationsService);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
    prisma.trackedCategory.findFirst.mockResolvedValue({ id: "cat-1" });
    prisma.customerAuthorization.create.mockImplementation((a: any) =>
      Promise.resolve({ id: "a1", ...a.data }),
    );
    prisma.customerAuthorization.update.mockImplementation((a: any) =>
      Promise.resolve({ id: a.where.id, ...a.data }),
    );
    // submit() only accepts a category that requires a license
    prisma.trackedCategory.findFirst.mockResolvedValue({
      id: "cat-1",
      name: "Tobacco",
      requiresLicense: true,
    });
  });

  const MSG = "License number can't start with =, +, -, @ or a tab/line break";
  const expectRefused = async (p: Promise<unknown>) => {
    const err: any = await p.catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "TEXT_CELL_FORMULA_LEAD",
      field: "licenseNumber",
      message: MSG,
    });
    expect(prisma.customerAuthorization.create).not.toHaveBeenCalled();
    expect(prisma.customerAuthorization.update).not.toHaveBeenCalled();
  };

  it("submit (buyer-typed) refuses a formula-led license number", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    await expectRefused(
      service.submit("c1", {
        trackedCategoryId: "cat-1",
        licenseNumber: "=HYPERLINK(1)",
        expiresAt: "2027-01-01T00:00:00Z",
      } as never),
    );
  });

  it("create (wholesaler-added) refuses a formula-led license number", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    await expectRefused(
      service.create(
        "c1",
        { trackedCategoryId: "cat-1", licenseNumber: "@SUM(A1)" } as never,
        user,
      ),
    );
  });

  it("renew refuses a CHANGED formula-led license number", async () => {
    prisma.customerAuthorization.findFirst.mockResolvedValue({
      id: "a1",
      customerId: "c1",
      status: "VERIFIED",
      licenseNumber: "TX-1",
    });
    prisma.customerAuthorization.findUnique.mockResolvedValue({
      id: "a1",
      customerId: "c1",
      status: "VERIFIED",
      licenseNumber: "TX-1",
    });
    await expectRefused(service.renew("c1", "a1", { licenseNumber: "-1+1" } as never, user));
  });

  it("an ordinary and a numeric-only license number pass (submit)", async () => {
    prisma.customerAuthorization.findUnique.mockResolvedValue(null);
    for (const licenseNumber of ["TX-123456", "-12345"]) {
      await expect(
        service.submit("c1", {
          trackedCategoryId: "cat-1",
          licenseNumber,
          expiresAt: "2027-01-01T00:00:00Z",
        } as never),
      ).resolves.toBeDefined();
    }
  });

  it("a LEGACY formula-led stored number echoed back unchanged on renew does not block (change-only)", async () => {
    const row = { id: "a1", customerId: "c1", status: "VERIFIED", licenseNumber: "=LEGACY" };
    prisma.customerAuthorization.findFirst.mockResolvedValue(row);
    prisma.customerAuthorization.findUnique.mockResolvedValue(row);
    await expect(
      service.renew("c1", "a1", { licenseNumber: "=LEGACY" } as never, user),
    ).resolves.toBeDefined();
  });
});

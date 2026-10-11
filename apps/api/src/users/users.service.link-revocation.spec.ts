/**
 * Account links die with the account's standing: every UsersService writer of a non-ACTIVE
 * status, a role change or an email change burns the user's outstanding set-password / reset
 * links in the SAME transaction as the write (`common/revoke-user-link-tokens.ts`).
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

type Tx = {
  user: { update: jest.Mock };
  $executeRaw: jest.Mock;
  events: string[];
};

describe("UsersService — link revocation on standing changes", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tx: Tx;
  let email: Record<string, jest.Mock>;

  /** The userIds whose PasswordResetToken rows the tx was asked to burn. */
  const burnedFor = () =>
    tx.$executeRaw.mock.calls
      .filter(([strings]) =>
        (strings as TemplateStringsArray).join("").includes("PasswordResetToken"),
      )
      .map(([, id]) => id as string);

  /** The userIds whose UserEmailVerificationToken rows the tx was asked to burn. */
  const verificationBurnedFor = () =>
    tx.$executeRaw.mock.calls
      .filter(([strings]) =>
        (strings as TemplateStringsArray).join("").includes("UserEmailVerificationToken"),
      )
      .map(([, id]) => id as string);

  const existing = (over: Record<string, unknown> = {}) => ({
    id: "u1",
    username: "acme_op",
    email: "old@acme.example",
    role: "OPERATOR",
    status: "ACTIVE",
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const events: string[] = [];
    tx = {
      events,
      user: {
        update: jest.fn((args: any) => {
          events.push("write");
          return Promise.resolve({
            id: "u1",
            username: "acme_op",
            email: args.data.email ?? "old@acme.example",
            role: args.data.role ?? "OPERATOR",
            status: args.data.status ?? "ACTIVE",
            forcePasswordChange: false,
          });
        }),
      },
      $executeRaw: jest.fn(() => {
        events.push("revoke");
        return Promise.resolve(1);
      }),
    };
    // Every write must go through the transaction client: the plain client rejects, so a write
    // that escaped the tx would fail the test instead of passing silently.
    prisma.user.update.mockRejectedValue(new Error("write outside the transaction"));
    prisma.passwordResetToken.updateMany.mockRejectedValue(new Error("revoke outside the tx"));
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
    email = {
      sendSetPasswordEmail: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangedNotice: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendEmailChangeConfirmation: jest
        .fn()
        .mockResolvedValue({ delivered: true, transport: "smtp" }),
      sendRoleChangedNotice: jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" }),
    };
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: { get: () => ({ web: "https://app.example.com" }) } },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  describe("changeStatus", () => {
    it.each(["SUSPENDED", "INACTIVE"])(
      "deactivating (to %s) burns the user's outstanding links in the same transaction",
      async (status) => {
        prisma.user.findUnique.mockResolvedValue(existing() as any);

        await service.changeStatus("u1", { status } as any, "TENANT_ADMIN" as any);

        expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
        expect(tx.user.update).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "u1" }, data: { status } }),
        );
        expect(burnedFor()).toEqual(["u1"]);
      },
    );

    it("INACTIVE -> INACTIVE still burns the links (a re-issued link must not survive a repeat write)", async () => {
      prisma.user.findUnique.mockResolvedValue(existing({ status: "INACTIVE" }) as any);

      await service.changeStatus("u1", { status: "INACTIVE" } as any, "TENANT_ADMIN" as any);

      expect(tx.user.update).toHaveBeenCalledTimes(1);
      expect(burnedFor()).toEqual(["u1"]);
    });

    it("INACTIVE -> INACTIVE also burns the email-verification links of the account", async () => {
      prisma.user.findUnique.mockResolvedValue(existing({ status: "INACTIVE" }) as any);

      await service.changeStatus("u1", { status: "INACTIVE" } as any, "TENANT_ADMIN" as any);

      expect(verificationBurnedFor()).toEqual(["u1"]);
    });

    it("reactivation (to ACTIVE) writes the status and burns nothing", async () => {
      prisma.user.findUnique.mockResolvedValue(existing({ status: "SUSPENDED" }) as any);

      await service.changeStatus("u1", { status: "ACTIVE" } as any, "TENANT_ADMIN" as any);

      expect(tx.user.update).toHaveBeenCalledTimes(1);
      expect(burnedFor()).toEqual([]);
    });

    it("a failed burn fails the whole change (it rolls back with the transaction)", async () => {
      prisma.user.findUnique.mockResolvedValue(existing() as any);
      tx.$executeRaw.mockRejectedValue(new Error("db down"));

      await expect(
        service.changeStatus("u1", { status: "SUSPENDED" } as any, "TENANT_ADMIN" as any),
      ).rejects.toThrow("db down");
    });
  });

  describe("updateUser", () => {
    it("an email change burns the links inside the same transaction as the write", async () => {
      prisma.user.findUnique.mockResolvedValue(existing() as any);

      await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        undefined,
        "TENANT_ADMIN" as any,
      );

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "u1" }, data: { email: "new@acme.example" } }),
      );
      expect(burnedFor()).toEqual(["u1"]);
      // one write, then the helper's two statements (reset links, verification links)
      expect(tx.events).toEqual(["write", "revoke", "revoke"]);
    });

    it("an email change also burns the email-verification links of the account", async () => {
      prisma.user.findUnique.mockResolvedValue(existing() as any);

      await service.updateUser(
        "u1",
        { email: "new@acme.example" } as any,
        undefined,
        "TENANT_ADMIN" as any,
      );

      expect(verificationBurnedFor()).toEqual(["u1"]);
    });

    it("a role change burns the links inside the same transaction as the write", async () => {
      prisma.user.findUnique.mockResolvedValue(existing() as any);

      await service.updateUser("u1", { role: "DRIVER" } as any, "admin", "TENANT_ADMIN" as any);

      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "u1" }, data: { role: "DRIVER" } }),
      );
      expect(burnedFor()).toEqual(["u1"]);
      // one write, then the helper's two statements (reset links, verification links)
      expect(tx.events).toEqual(["write", "revoke", "revoke"]);
    });

    describe("a role change re-issues a link only when the user still needs one (forcePasswordChange and ACTIVE)", () => {
      const withTxUser = (over: Record<string, unknown>) =>
        (tx.user.update as jest.Mock).mockImplementation((args: any) => {
          tx.events.push("write");
          return Promise.resolve({
            id: "u1",
            username: "acme_op",
            email: "old@acme.example",
            role: args.data.role ?? "OPERATOR",
            status: "ACTIVE",
            forcePasswordChange: false,
            ...over,
          });
        });

      it("an invited user who has not set a password gets a fresh link after the role change", async () => {
        prisma.user.findUnique.mockResolvedValue(existing() as any);
        withTxUser({ forcePasswordChange: true });

        await service.updateUser("u1", { role: "DRIVER" } as any, "admin", "TENANT_ADMIN" as any);

        expect(burnedFor()).toEqual(["u1"]);
        expect(email.sendSetPasswordEmail).toHaveBeenCalledTimes(1);
        expect(email.sendSetPasswordEmail).toHaveBeenCalledWith(
          expect.objectContaining({ to: "old@acme.example" }),
        );
      });

      it("a user who already set a password gets no new link", async () => {
        prisma.user.findUnique.mockResolvedValue(existing() as any);
        withTxUser({ forcePasswordChange: false });

        await service.updateUser("u1", { role: "DRIVER" } as any, "admin", "TENANT_ADMIN" as any);

        expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
      });

      it("an INACTIVE user gets no new link (reactivation does not restore a burned link either)", async () => {
        prisma.user.findUnique.mockResolvedValue(existing({ status: "INACTIVE" }) as any);
        withTxUser({ forcePasswordChange: true, status: "INACTIVE" });

        await service.updateUser("u1", { role: "DRIVER" } as any, "admin", "TENANT_ADMIN" as any);

        expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
      });

      it("email AND role changed in one edit sends exactly one fresh link", async () => {
        prisma.user.findUnique.mockResolvedValue(existing() as any);
        withTxUser({ forcePasswordChange: true, email: "new@acme.example" });

        await service.updateUser(
          "u1",
          { role: "DRIVER", email: "new@acme.example" } as any,
          "admin",
          "TENANT_ADMIN" as any,
        );

        expect(email.sendSetPasswordEmail).toHaveBeenCalledTimes(1);
      });
    });

    it("an edit that changes neither email nor role (same email re-sent, username only) burns nothing", async () => {
      prisma.user.findUnique.mockResolvedValue(existing() as any);

      await service.updateUser(
        "u1",
        { email: "OLD@acme.example", username: "renamed_op" } as any,
        undefined,
        "TENANT_ADMIN" as any,
      );

      expect(tx.user.update).toHaveBeenCalledTimes(1);
      expect(burnedFor()).toEqual([]);
    });

    it("a failed burn rolls the edit back and no notice goes out", async () => {
      prisma.user.findUnique.mockResolvedValue(existing() as any);
      tx.$executeRaw.mockRejectedValue(new Error("db down"));

      await expect(
        service.updateUser(
          "u1",
          { email: "new@acme.example" } as any,
          undefined,
          "TENANT_ADMIN" as any,
        ),
      ).rejects.toThrow("db down");
      expect(email.sendEmailChangedNotice).not.toHaveBeenCalled();
    });
  });
});

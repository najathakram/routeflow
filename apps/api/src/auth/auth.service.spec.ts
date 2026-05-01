import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";
import { EmailService } from "../email/email.service";

jest.mock("bcrypt", () => ({
  compare: jest.fn(),
  hash: jest.fn(),
  genSalt: jest.fn(),
}));
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};

const MOCK_USER = {
  id: "user-1",
  email: "admin@test.com",
  username: "admin",
  password: "$2b$10$hashedpassword",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("AuthService", () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let usersService: {
    findByUsername: jest.Mock;
    findByUsernameCrossTenant: jest.Mock;
    findByEmailCrossTenant: jest.Mock;
  };
  let jwtService: { sign: jest.Mock; verify: jest.Mock; decode: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    usersService = {
      findByUsername: jest.fn(),
      findByUsernameCrossTenant: jest.fn().mockResolvedValue(null),
      findByEmailCrossTenant: jest.fn().mockResolvedValue(null),
    };
    jwtService = {
      sign: jest.fn().mockReturnValue("mock-token"),
      verify: jest.fn(),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(JWT_CONFIG) },
        },
        {
          provide: EmailService,
          useValue: { send: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ─── validateUser ─────────────────────────────────────────────────────────

  describe("validateUser", () => {
    it("should return user data (without password) when credentials are valid", async () => {
      usersService.findByUsername.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.validateUser("admin", "correct-password");

      expect(result).toBeDefined();
      expect(result!.id).toBe("user-1");
      expect(result).not.toHaveProperty("password");
    });

    it("should return null when user does not exist", async () => {
      usersService.findByUsername.mockResolvedValue(null);
      const result = await service.validateUser("nobody", "pass");
      expect(result).toBeNull();
    });

    it("should return null when password is wrong", async () => {
      usersService.findByUsername.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      const result = await service.validateUser("admin", "wrong-password");
      expect(result).toBeNull();
    });

    it("should return null for soft-deleted users", async () => {
      usersService.findByUsername.mockResolvedValue({ ...MOCK_USER, deletedAt: new Date() });
      const result = await service.validateUser("admin", "correct-password");
      expect(result).toBeNull();
    });

    it("should return null for inactive users", async () => {
      usersService.findByUsername.mockResolvedValue({ ...MOCK_USER, status: "SUSPENDED" });
      const result = await service.validateUser("admin", "correct-password");
      expect(result).toBeNull();
    });
  });

  // ─── login ────────────────────────────────────────────────────────────────

  describe("login", () => {
    const validUser = {
      id: "user-1",
      username: "admin",
      role: "OPERATOR" as const,
      status: "ACTIVE" as const,
      forcePasswordChange: false,
    };

    it("should return access token, refresh token, and user", async () => {
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      const result = await service.login(validUser as any);

      expect(result).toHaveProperty("accessToken", "mock-token");
      expect(result).toHaveProperty("refreshToken", "mock-token");
      expect(result.user.id).toBe("user-1");
      expect(jwtService.sign).toHaveBeenCalledTimes(2);
    });

    it("should store the refresh token hash in the database", async () => {
      prisma.refreshToken.upsert.mockResolvedValue({} as any);

      await service.login(validUser as any);

      expect(prisma.refreshToken.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ userId: "user-1" }),
        }),
      );
    });
  });

  // ─── logout ───────────────────────────────────────────────────────────────

  describe("logout", () => {
    it("should delete all refresh tokens for the user", async () => {
      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.logout("user-1");

      expect(result).toEqual({ message: "Logged out successfully" });
      expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });
  });

  // ─── changePassword ───────────────────────────────────────────────────────

  describe("changePassword", () => {
    it("should hash the new password and update the user", async () => {
      prisma.user.findUnique.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock)
        .mockResolvedValueOnce(true) // current password is correct
        .mockResolvedValueOnce(false); // new password differs from old
      (bcrypt.hash as jest.Mock).mockResolvedValue("new-hash");
      prisma.user.update.mockResolvedValue({} as any);

      const result = await service.changePassword("user-1", "old", "new");

      expect(result).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/Password changed successfully/),
        }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            password: "new-hash",
            forcePasswordChange: false,
          }),
        }),
      );
    });

    it("should throw BadRequestException when current password is incorrect", async () => {
      prisma.user.findUnique.mockResolvedValue(MOCK_USER);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.changePassword("user-1", "wrong", "new")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw UnauthorizedException when user not found", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.changePassword("nobody", "old", "new")).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});

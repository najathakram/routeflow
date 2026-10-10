/**
 * B964-1: a buyer name TYPED by the buyer (register, updateProfile) or by staff (admin updateBuyer) refuses a leading
 * = + - @ TAB CR LF with a readable 400 (field buyerName) BEFORE any write. Change-only: a legacy name echoed back never blocks.
 * (Google/Apple supply the name and are NEUTRALISED, never refused: see oauth-name-neutralise.spec.ts.)
 */
import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { BuyerAuthService } from "./buyer-auth.service";
import { BuyerAdminService } from "./buyer-admin.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { AppleOAuthService } from "../auth/apple-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn().mockResolvedValue("hash") }));

const MSG = "Name can't start with =, +, -, @ or a tab/line break";
const expectRefused = async (p: Promise<unknown>) => {
  const err: any = await p.catch((e) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  expect(err.getResponse()).toMatchObject({
    code: "TEXT_CELL_FORMULA_LEAD",
    field: "buyerName",
    message: MSG,
  });
};

describe("buyer name guards (B964-1)", () => {
  let auth: BuyerAuthService;
  let admin: BuyerAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        BuyerAuthService,
        BuyerAdminService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue("t"),
            decode: jest.fn().mockReturnValue({ exp: 9e9 }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              secret: "s",
              refreshSecret: "r",
              expiresIn: "15m",
              refreshExpiresIn: "30d",
            }),
          },
        },
        { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
        { provide: AppleOAuthService, useValue: {} },
      ],
    }).compile();
    auth = mod.get(BuyerAuthService);
    admin = mod.get(BuyerAdminService);
  });

  it("register refuses a formula-led name before the email lookup and any write", async () => {
    await expectRefused(
      auth.register({
        email: "a@b.com",
        password: "pw123456",
        name: "=cmd|' /C calc'!A0",
      } as never),
    );
    expect(prisma.buyerAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.buyerAccount.create).not.toHaveBeenCalled();
  });

  it("updateProfile refuses a CHANGED formula-led name and writes nothing", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ id: "b1", name: "Pat" });
    await expectRefused(auth.updateProfile("b1", { name: "@evil" }));
    expect(prisma.buyerAccount.update).not.toHaveBeenCalled();
  });

  it("updateProfile: a LEGACY formula-led name echoed back unchanged, or a phone-only edit, still saves", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({ id: "b1", name: "=LEGACY" });
    prisma.buyerAccount.update.mockResolvedValue({ id: "b1" });
    await expect(
      auth.updateProfile("b1", { name: "=LEGACY", phone: "555" }),
    ).resolves.toBeDefined();
    await expect(auth.updateProfile("b1", { phone: "+1 555 1" })).resolves.toBeDefined();
  });

  it("admin updateBuyer refuses a CHANGED formula-led name (staff-typed) before the transaction", async () => {
    prisma.buyerAccount.findUnique.mockResolvedValue({
      id: "b1",
      email: "old@x.com",
      name: "Old",
      emailVerified: true,
    });
    await expectRefused(admin.updateBuyer("b1", { name: "-2+3" }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

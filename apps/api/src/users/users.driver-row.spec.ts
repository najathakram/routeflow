/**
 * B862 / SA-1171 (K1-K5): every user who drives has exactly one Driver row, written by DriversService.
 *  (a) POST /users/operator with role DRIVER is refused with a coded 400 and writes no user;
 *  (b) updateUser(op -> DRIVER) writes an ACTIVE Driver row in the same transaction;
 *  (c) updateUser(DRIVER -> OPERATOR) sets the row INACTIVE, or refuses with a coded 409 when a run is open;
 *  (d) toggleDriverPermit enables through the same helper, inside a transaction;
 *  (e) the inventory pin: a Driver row is written only inside ensureDriverRow (drivers.service.ts).
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { API_ERROR_CODES } from "@routeflow/types";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

const op = (over: object = {}) => ({
  id: "u1",
  tenantId: "t1",
  username: "pat",
  email: "pat@acme.example",
  role: UserRole.OPERATOR,
  status: "ACTIVE",
  isAdmin: false,
  canActAsDriver: false,
  forcePasswordChange: false,
  deletedAt: null,
  deniedPermissionGroups: [],
  ...over,
});

describe("B862 driver row writer (SA-1171)", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.update.mockImplementation(async ({ data }: any) => ({ ...op(), ...data }));
    prisma.driver.upsert.mockResolvedValue({ id: "d1" });
    prisma.routeRun.findFirst.mockResolvedValue(null);
    const mod = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => ({ web: "https://app.example.com" }) } },
        { provide: EmailService, useValue: { sendSetPasswordEmail: jest.fn() } },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = mod.get(UsersService);
  });

  it("(a) create with role DRIVER is a coded 400 and writes no user", async () => {
    const call = service.createOperator({
      email: "d@acme.example",
      username: "dee",
      role: UserRole.DRIVER,
    } as any);
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.DRIVER_VIA_DRIVERS_PAGE },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("(b) updateUser to DRIVER upserts one ACTIVE Driver row for that user", async () => {
    prisma.user.findUnique.mockResolvedValue(op());
    await service.updateUser(
      "u1",
      { role: UserRole.DRIVER } as any,
      "admin",
      UserRole.TENANT_ADMIN,
    );
    expect(prisma.driver.upsert).toHaveBeenCalledTimes(1);
    const arg = prisma.driver.upsert.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ userId: "u1" });
    expect(arg.create).toMatchObject({ userId: "u1", status: "ACTIVE" });
    expect(arg.update).toMatchObject({ status: "ACTIVE" });
  });

  it("(c) DRIVER -> OPERATOR sets the row INACTIVE", async () => {
    prisma.user.findUnique.mockResolvedValue(op({ role: UserRole.DRIVER }));
    await service.updateUser(
      "u1",
      { role: UserRole.OPERATOR } as any,
      "admin",
      UserRole.TENANT_ADMIN,
    );
    expect(prisma.driver.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { status: "INACTIVE" },
    });
  });

  it("(c) DRIVER -> OPERATOR with an open run is a coded 409 and writes nothing", async () => {
    prisma.user.findUnique.mockResolvedValue(op({ role: UserRole.DRIVER }));
    prisma.routeRun.findFirst.mockResolvedValue({ id: "r1" });
    const call = service.updateUser(
      "u1",
      { role: UserRole.OPERATOR } as any,
      "admin",
      UserRole.TENANT_ADMIN,
    );
    await expect(call).rejects.toBeInstanceOf(ConflictException);
    await expect(call).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.DRIVER_HAS_OPEN_RUN },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.driver.updateMany).not.toHaveBeenCalled();
  });

  it("(d) enabling the driver permit goes through the one writer, in a transaction", async () => {
    prisma.user.findUnique.mockResolvedValue(op());
    await service.toggleDriverPermit("u1", UserRole.TENANT_ADMIN);
    expect(prisma.tenantTransaction).toHaveBeenCalled();
    expect(prisma.driver.create).not.toHaveBeenCalled();
    expect(prisma.driver.upsert).toHaveBeenCalledTimes(1);
  });

  it("(K3) with no route add-on the enable still writes the row, and only logs", async () => {
    const hasAddon = jest.fn().mockResolvedValue(false);
    (service as any).addons = { hasAddon };
    const warn = jest
      .spyOn((service as any).logger ?? console, "warn")
      .mockImplementation(() => {});
    prisma.user.findUnique.mockResolvedValue(op());
    await service.toggleDriverPermit("u1", UserRole.TENANT_ADMIN);
    expect(prisma.driver.upsert).toHaveBeenCalledTimes(1);
    expect(hasAddon).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("driver-row gate would refuse"));
  });
});

describe("B862 inventory pin (K1, K5e)", () => {
  const SRC = join(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

  /** A Driver write: `x.driver.create(` and friends, or the nested form `driver: { create: ... }`. */
  const DRIVER_WRITE =
    /(^|[^A-Za-z])driver[^A-Za-z]{1,12}(create|createMany|upsert|connectOrCreate)([^A-Za-z]|$)/;
  const NL = String.fromCharCode(10);
  /** drivers.service.ts minus the body of ensureDriverRow, the one place a Driver row is written. */
  const withoutWriter = (src: string): string => {
    const fn = src.indexOf("export async function ensureDriverRow");
    const start = src.lastIndexOf("/**", fn); // its doc comment names the call forms too
    if (fn < 0 || start < 0) return src;
    const end = src.indexOf(NL + "}", fn) + 2;
    return src.slice(0, start) + src.slice(end);
  };

  it("the detector sees both the call form and the nested form", () => {
    expect(DRIVER_WRITE.test("await tx.driver.create({ data })")).toBe(true);
    expect(DRIVER_WRITE.test("await tx.driver.upsert({ where })")).toBe(true);
    expect(DRIVER_WRITE.test("user.update({ data: { driver: { create: { phone: '' } } } })")).toBe(
      true,
    );
    expect(DRIVER_WRITE.test("tx.driver.updateMany({ where })")).toBe(false);
  });

  it("only ensureDriverRow writes a Driver row (specs and testing fixtures excepted)", () => {
    const offenders = walk(SRC)
      .filter((p) => !p.endsWith(".spec.ts") && !p.includes(join("src", "testing")))
      .filter((p) => {
        const src = readFileSync(p, "utf8");
        return DRIVER_WRITE.test(
          p.endsWith(join("drivers", "drivers.service.ts")) ? withoutWriter(src) : src,
        );
      })
      .map((p) => p.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
  it("ensureDriverRow itself still writes the row (the exemption is not vacuous)", () => {
    const src = readFileSync(join(SRC, "drivers", "drivers.service.ts"), "utf8");
    expect(DRIVER_WRITE.test(src)).toBe(true);
    expect(DRIVER_WRITE.test(withoutWriter(src))).toBe(false);
  });
});

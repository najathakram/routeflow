/**
 * B862: Settings -> Add User with Role = Driver created an OPERATOR. The create-user DTO carried no role and
 * createOperator hard-coded OPERATOR. The role now travels in the DTO (OPERATOR or DRIVER only, OPERATOR when
 * absent, so older callers are unchanged) and is the role the account is written with.
 */
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UserRole } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { CreateOperatorDto } from "./dto/create-operator.dto";

const base = { email: "pat@acme.example", username: "pat" };

describe("CreateOperatorDto.role (B862)", () => {
  const errorsFor = async (o: object) => validate(plainToInstance(CreateOperatorDto, o));

  it("accepts no role, OPERATOR and DRIVER", async () => {
    expect(await errorsFor(base)).toHaveLength(0);
    expect(await errorsFor({ ...base, role: "OPERATOR" })).toHaveLength(0);
    expect(await errorsFor({ ...base, role: "DRIVER" })).toHaveLength(0);
  });

  it("refuses TENANT_ADMIN, CUSTOMER and anything else (no privilege escalation through create)", async () => {
    for (const role of ["TENANT_ADMIN", "CUSTOMER", "SUPER_ADMIN", "x"]) {
      expect((await errorsFor({ ...base, role })).length).toBeGreaterThan(0);
    }
  });
});

describe("UsersService.createOperator role (B862 / SA-1171 K2: always OPERATOR; DRIVER is refused, see users.driver-row.spec.ts)", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockImplementation(async ({ data }: any) => ({
      id: "u-new",
      username: data.username,
      email: data.email,
      role: data.role,
      status: "ACTIVE",
      forcePasswordChange: true,
    }));
    const mod = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue({ web: "https://app.example.com" }) },
        },
        {
          provide: EmailService,
          useValue: { sendSetPasswordEmail: jest.fn().mockResolvedValue({ delivered: true }) },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = mod.get(UsersService);
  });

  it("writes OPERATOR for OPERATOR and for no role (older callers)", async () => {
    await service.createOperator({ ...base, role: UserRole.OPERATOR } as any);
    await service.createOperator({ ...base, username: "pat2", email: "p2@acme.example" } as any);
    expect(prisma.user.create.mock.calls.map((c: any) => c[0].data.role)).toEqual([
      UserRole.OPERATOR,
      UserRole.OPERATOR,
    ]);
  });
});

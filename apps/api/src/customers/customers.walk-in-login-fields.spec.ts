/**
 * The walk-in customer's sign-in details stay fixed: the customer-update path refuses a change to its email
 * (the only login-related field UpdateCustomerDto carries; update() writes the customer row only, never the
 * linked user) before any write, while other fields stay editable. The isWalkIn flag cannot be set or cleared
 * through update.
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { customerUpdateData } from "./customer-update-data";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";

const WALK_IN = {
  id: "cust-walk",
  userId: "user-walk",
  deletedAt: null,
  isWalkIn: true,
  email: "counter@acme.example",
  businessName: "Walk-in",
};
const NORMAL = {
  id: "cust-1",
  userId: "user-1",
  deletedAt: null,
  isWalkIn: null,
  email: "a@acme.example",
  businessName: "Shop",
};

describe("the walk-in customer's login fields cannot be changed through update", () => {
  let service: CustomersService;
  let scoped: any;

  beforeEach(async () => {
    const rows: Record<string, any> = { [WALK_IN.id]: WALK_IN, [NORMAL.id]: NORMAL };
    scoped = {
      customer: {
        findUnique: jest.fn(async ({ where }: any) => rows[where.id] ?? null),
        update: jest.fn(async () => ({})),
      },
      user: { update: jest.fn() },
    };
    const prisma: any = {
      customer: { findFirst: jest.fn(async ({ where }: any) => rows[where.id] ?? null) },
      forTenant: () => scoped,
      getTenantId: () => "t1",
    };
    const mod = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        ...[
          ConfigService,
          StorageService,
          MeterService,
          PlanCatalogService,
          EntitlementAuthority,
          CommissionEngineService,
          RegulatedLedgerService,
          EmailService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    service = mod.get(CustomersService);
  });

  const refused = async (p: Promise<unknown>) => {
    const e: any = await p.then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ code: "WALK_IN_PROTECTED" });
  };

  it("an email change is refused and nothing is written", async () => {
    await refused(service.update(WALK_IN.id, { email: "other@acme.example" } as any));
    expect(scoped.customer.update).not.toHaveBeenCalled();
    expect(scoped.user.update).not.toHaveBeenCalled();
  });

  it("clearing the email is refused as well", async () => {
    await refused(service.update(WALK_IN.id, { email: null } as any));
    expect(scoped.customer.update).not.toHaveBeenCalled();
  });

  it("the unchanged email resent with other edits is accepted", async () => {
    await service.update(WALK_IN.id, { email: WALK_IN.email, notes: "n" } as any);
    expect(scoped.customer.update).toHaveBeenCalled();
  });

  it("a name change is still allowed", async () => {
    await service.update(WALK_IN.id, { businessName: "Counter sales" } as any);
    expect(scoped.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ businessName: "Counter sales" }) }),
    );
  });

  it("an ordinary customer's email change is unchanged", async () => {
    await service.update(NORMAL.id, { email: "new@acme.example" } as any);
    expect(scoped.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "new@acme.example" }) }),
    );
  });

  it("the isWalkIn flag cannot be cleared or set: the DTO drops it and the write data never has it", async () => {
    const dto = plainToInstance(UpdateCustomerDto, { notes: "x", isWalkIn: false });
    await validate(dto, { whitelist: true });
    expect((dto as any).isWalkIn).toBeUndefined();
    expect(customerUpdateData({ ...dto, isWalkIn: false } as any)).not.toHaveProperty("isWalkIn");
    await service.update(WALK_IN.id, { notes: "x", isWalkIn: false } as any);
    expect(scoped.customer.update.mock.calls[0][0].data).not.toHaveProperty("isWalkIn");
  });
});

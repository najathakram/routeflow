import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PlatformConfigService } from "./platform-config.service";
import { PrismaService } from "../prisma/prisma.service";

// T2 (R2) — PlatformConfigService.onModuleInit must issue no runtime DDL.
//
// Today onModuleInit runs three `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX
// IF NOT EXISTS` statements via `this.prisma.$executeRaw` (tagged-template
// calls, not `$executeRawUnsafe`) to auto-provision "PlatformConfig" and
// "AiUsageEvent" at boot. Prod migrations are the only sanctioned DDL path
// (spec R2) — after PR-1 that block is gone and onModuleInit issues zero
// $executeRaw / $executeRawUnsafe calls of any kind.
//
// Oracle: before the fix, $executeRaw is called 3 times (CREATE TABLE x2,
// CREATE INDEX x1) and this test fails on 3 !== 0. $executeRawUnsafe is
// already 0 today, so that half of the assertion is a tripwire against a
// future regression that swaps the DDL onto the unsafe variant.
describe("PlatformConfigService.onModuleInit — no runtime DDL (T2)", () => {
  let service: PlatformConfigService;
  let prisma: {
    $executeRawUnsafe: jest.Mock;
    $executeRaw: jest.Mock;
    $queryRaw: jest.Mock;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();
    service = mod.get(PlatformConfigService);
  });

  it("issues zero $executeRawUnsafe and zero $executeRaw calls on boot", async () => {
    // Live oracle: `onModuleInit?.()` below is a silent no-op once the method is gone, which
    // would make every assertion in this test vacuously true even if the DDL block came back
    // under a different lifecycle hook. Assert the method is actually absent so the call above
    // is known to be a deliberate no-op, not an accidental one.
    expect(service).not.toHaveProperty("onModuleInit");

    await (service as any).onModuleInit?.();

    // Concrete oracle independent of the implementation: today this is
    // 0 !== 3, so the assertion — not a stub returning undefined — is what
    // fails before the DDL block is removed.
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(0);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(0);

    // onModuleInit makes no other Prisma calls today (no $queryRaw,
    // $transaction, or model-delegate reads) — removing the DDL block must
    // not introduce any replacement Prisma traffic on boot either.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

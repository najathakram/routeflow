import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ModulesContainer } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogCopyModule } from "./catalog-copy.module";
import { CatalogCopyService } from "./catalog-copy.service";

const prismaStub = {
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
  $on: jest.fn(),
  $transaction: jest.fn(),
  getTenantId: jest.fn().mockReturnValue(null),
};

/**
 * SA-1027 rule 2, the stop condition as a test: the script-only graph resolves, and it holds no AppModule, no
 * ScheduleModule (so no `@LeaderCron` job ever ticks), no Bull queue and no throttler (no Redis client opens).
 */
describe("CatalogCopyModule (script-only graph)", () => {
  it("resolves the copy service without AppModule, ScheduleModule, BullModule or ThrottlerModule", async () => {
    process.env.JWT_SECRET = "test-only-catalog-copy-module-secret-0123456789abcdef";
    process.env.JWT_REFRESH_SECRET = "test-only-catalog-copy-module-refresh-0123456789abcdef";
    const moduleRef = await Test.createTestingModule({ imports: [CatalogCopyModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();
    expect(moduleRef.get(CatalogCopyService)).toBeInstanceOf(CatalogCopyService);

    const names = new Set(
      [...moduleRef.get(ModulesContainer).values()].map((m) => m.metatype?.name),
    );
    for (const banned of ["AppModule", "ScheduleModule", "BullModule", "ThrottlerModule"]) {
      expect(names.has(banned)).toBe(false);
    }
    await moduleRef.close();
  }, 60000);
});

import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ModulesContainer } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogCopyModule } from "./catalog-copy.module";
import { ensureScriptEnv } from "./catalog-copy.runner";
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

  // Found by the first live dry run (a `railway run --service postgres` shell carries NO JWT secret): the graph pulled in
  // AuthModule, whose JwtStrategy refuses to build without one. A script that writes through services needs no login.
  it("boots from a bare environment (no JWT secret) once the runner has filled the script env", async () => {
    const saved = { s: process.env.JWT_SECRET, r: process.env.JWT_REFRESH_SECRET };
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    ensureScriptEnv();
    try {
      const moduleRef = await Test.createTestingModule({ imports: [CatalogCopyModule] })
        .overrideProvider(PrismaService)
        .useValue(prismaStub)
        .compile();
      expect(moduleRef.get(CatalogCopyService)).toBeInstanceOf(CatalogCopyService);
      await moduleRef.close();
    } finally {
      for (const [k, v] of [
        ["JWT_SECRET", saved.s],
        ["JWT_REFRESH_SECRET", saved.r],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 60000);
});

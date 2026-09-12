// Repo-truth guard for the W16 outage class (window 16, 2026-09-12): CrmModule's controller
// applied `AddonGuard` but the module never imported `BillingModule`, the module that provides
// the guard's dependency. Nest's InstanceLoader threw `UnknownDependenciesException` at boot;
// every unit spec mocks at the module boundary so none of them saw it, `check-types` cannot see
// DI scope, and the Docker healthcheck window hid the boot crash until prod answered 502 (fixed
// in #703). `addon-guard-module-import.spec.ts` guards the same incident by reading source text
// for that one shape; this spec instead asks Nest to build the REAL `AppModule` DI graph the
// same way `main.ts` does at boot, so a missing import, wrong `provide` token, or broken
// dependency anywhere in the tree (not just around `AddonGuard`) fails here instead of in prod.
//
// Only genuinely external I/O is stubbed: `PrismaService` (real Postgres via `pg.Pool`) and the
// "invoices" Bull queue (real Redis via bull's own `ioredis` client, constructed eagerly — see
// bull/lib/queue.js's `getRedisVersion(this.client)` call right after construction). Everything
// else in the graph — including `RedisThrottlerStorage`'s own `new Redis(...)` — resolves
// against the jest-wide `ioredis` -> `test/__mocks__/ioredis.js` moduleNameMapper (see that
// file's header), so no other override is needed to keep this test socket-free.
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { AppModule } from "../app.module";
import { PrismaService } from "../prisma/prisma.service";

describe("AppModule compiles its full DI graph", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("resolves every provider without opening a real Postgres or Redis connection", async () => {
    // passport-jwt's Strategy constructors (JwtStrategy, BuyerJwtStrategy) throw synchronously
    // when secretOrKey is empty, so a fresh clone/CI running this spec with no .env needs a
    // dummy value here — this must never be a real secret. Set before `.compile()` so Nest's
    // ConfigModule loader (`configuration()`, called lazily during compile) reads it in time;
    // module imports above are just class/decorator declarations, no env reads happen at import.
    process.env.JWT_SECRET = "test-only-app-module-compile-spec-secret";
    process.env.JWT_REFRESH_SECRET = "test-only-app-module-compile-spec-refresh-secret";

    const prismaStub = {
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      $on: jest.fn(),
      $transaction: jest.fn(),
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
      getTenantId: jest.fn().mockReturnValue(null),
      tenantTransaction: jest.fn(),
    };
    const invoiceQueueStub = {
      add: jest.fn(),
      process: jest.fn(),
      on: jest.fn(),
      close: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(getQueueToken("invoices"))
      .useValue(invoiceQueueStub)
      .compile();

    expect(moduleRef).toBeDefined();

    await moduleRef.close();
  }, 60000);
});

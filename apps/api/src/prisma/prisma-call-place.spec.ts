import { Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { runAtPlace, callPlace } from "../common/call-place";

/**
 * B1285 / SA-1105 A-3: the guard's call place is `tenantCtx.label() ?? callPlace()`. A scheduled job or queue
 * processor is named by the place `@LeaderCron` / the processor wrapper set, in its own AsyncLocalStorage, so two jobs with
 * the same kind, model and op no longer share one capture gate. Its own spec file on purpose: the process guard (and its
 * 20-captures-per-second budget) is module state, and a fresh module registry keeps these rows off the other specs' budget.
 */
// SA-1110: under TENANT the walker stamps nested creates first, so the signal below is the walker-miss signal. These
// rows simulate a miss (identity stamp) to keep proving the guard still reports it, with the same keys and labels.
let mockWalkerMisses = false;
jest.mock("./tenant-nested-walker", () => {
  const real = jest.requireActual("./tenant-nested-walker");
  return {
    ...real,
    stampNestedTenant: (...a: any[]) => (mockWalkerMisses ? a[1] : real.stampNestedTenant(...a)),
  };
});
const proto = PrismaService.prototype as unknown as Record<string, any>;
const host = (ctx: TenantContextService) =>
  ({
    tenantCtx: ctx,
    getTenantId: () => ctx.getOrNull(),
    $extends: (ext: any) => ({ __extension: ext }),
    forTenant: proto.forTenant,
    _observeExtension: proto._observeExtension,
    _tenantExtension: proto._tenantExtension,
  }) as any;
const handler = (h: any) => h.forTenant().__extension.query.$allModels.$allOperations;
const read = (h: any) =>
  handler(h)({ model: "Customer", operation: "findMany", args: {}, query: async () => [] });

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());
const missing = () =>
  warn.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("TENANT_CONTEXT_MISSING kind="));

describe("B5-5 two jobs with the same kind, model and op are both logged", () => {
  it("a.one at 1000 hits and b.two once: one line each, each naming its job (red when jobs carry no place)", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    await runAtPlace("a.one", async () => {
      for (let i = 0; i < 1000; i++) await read(h);
    });
    await runAtPlace("b.two", () => read(h));
    const lines = missing();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("kind=NONE model=Customer op=read at=a.one");
    expect(lines[1]).toContain("kind=NONE model=Customer op=read at=b.two");
  });
});

describe("B5-7 a tenant run inside a job keeps the job's place", () => {
  beforeEach(() => (mockWalkerMisses = true));
  afterEach(() => (mockWalkerMisses = false));
  it("a TENANT-kind nested-create signal inside run(tenantId) is named by the job", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    await runAtPlace("c.three", () =>
      ctx.run("t1", () =>
        handler(h)({
          model: "Order",
          operation: "create",
          args: { data: { lineItems: { create: [{ productId: "p1", qty: 1 }] } } },
          query: async (a: any) => a,
        }),
      ),
    );
    const lines = missing();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("kind=TENANT model=Order.lineItems op=nested-create at=c.three");
  });
});

describe("the place is its own context", () => {
  it("a route label wins over a job place, and the place is absent outside any job", async () => {
    const ctx = new TenantContextService();
    const h = host(ctx);
    expect(callPlace()).toBeUndefined();
    await runAtPlace("d.four", () =>
      ctx.run(null, () => read(h), "ANONYMOUS", "OrdersController.create"),
    );
    const lines = missing();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("at=OrdersController.create");
    expect(lines[0]).not.toContain("d.four");
  });
});

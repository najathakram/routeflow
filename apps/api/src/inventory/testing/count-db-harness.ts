/**
 * SA-767 L-2.4 - the shared harness of the stock-count DB specs (`sa767-count-*.db.spec.ts`): two
 * `InventoryService` instances on separate connection pools (A = the held writer + all seeding and
 * reads, B = the competing writer), throwaway `qa-sa767-l24-*` tenants (approved by
 * `assertTestTenant`), a count world (N products + one session with one REPLACE line each), and the
 * deterministic-interleave tools: `Gate` holds a transaction open after its body ran (it still owns
 * its locks), `sawLockWait(holderPid)` observes a backend genuinely blocked BY that holder.
 *
 * Call `useCountDbHarness()` INSIDE a `describeDb` callback: it registers its own hooks. Collected
 * only through the `*.db.spec.ts` specs that import it (excluded from the build with `**\/testing/**`).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { InventoryService } from "../inventory.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { StockAlertService } from "../../stock-alerts/stock-alert.service";
import { AuditService } from "../../audit/audit.service";
import { requireLocalDatabaseUrl } from "../../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string, spec: string): string => {
  tenantSeq += 1;
  return assertTestTenant(`qa-sa767-l24-${RUN_SUFFIX}-${tenantSeq}-${label}`, spec);
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settles to the value, or to "pending" if it has not settled within `ms` (never hangs a case). */
export const settleWithin = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then(
      (value) => ({ value }) as { value: T; err?: undefined },
      (err) => ({ err }) as { value?: undefined; err: any },
    ),
    sleep(ms).then(() => "pending" as const),
  ]);

/** Holds a transaction open after its body ran, until released. */
export class Gate {
  private markParked!: () => void;
  private open!: () => void;
  /** Resolves when the held transaction's body has finished (it still owns its locks). */
  readonly parked = new Promise<void>((r) => {
    this.markParked = r;
  });
  private readonly opened = new Promise<void>((r) => {
    this.open = r;
  });
  /** The backend pid of the connection holding the transaction open (set by `hold`). */
  holderPid = 0;
  hold(holderPid = 0): Promise<void> {
    this.holderPid = holderPid;
    this.markParked();
    return this.opened;
  }
  release(): void {
    this.open();
  }
}

export interface Services {
  prisma: PrismaService;
  tenantCtx: TenantContextService;
  inventory: InventoryService;
}

export interface CountWorld {
  tenantId: string;
  userId: string;
  sessionId: string;
  idOf: (i: number) => string;
}

const pad3 = (i: number) => String(i).padStart(3, "0");

export function useCountDbHarness(spec: string) {
  const services: Services[] = [];
  const createdTenantIds: string[] = [];
  const gates: Gate[] = [];
  let pool: Pool;
  const h = {} as {
    A: Services;
    B: Services;
    pool: Pool;
  };

  async function build(): Promise<Services> {
    const tenantCtx = new TenantContextService();
    const prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: new AuditService(prisma) },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    const s = { prisma, tenantCtx, inventory: module.get(InventoryService) };
    services.push(s);
    return s;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    h.pool = pool;
    h.A = await build();
    h.B = await build();
  }, 120_000);

  afterEach(() => {
    gates.splice(0).forEach((g) => g.release());
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const prisma = h.A?.prisma;
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.stockCountLine.deleteMany({ where: { tenantId } });
        await prisma.stockCountSession.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // Never mask a test's own result, but never hide a leaked tenant either.
        // eslint-disable-next-line no-console
        console.error(`${spec} cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await Promise.all(services.map((s) => s.prisma.$disconnect()));
    await pool?.end();
  }, 120_000);

  /**
   * `n` products at `stock`, one session with one REPLACE line each (counted `counted(i)`, expected
   * `stock`). `lines: false` seeds the session with no lines (the cases that build them through the
   * real autosave path).
   */
  async function seedCountWorld(
    label: string,
    n: number,
    opts: { stock?: number; counted?: (i: number) => number; lines?: boolean } = {},
  ): Promise<CountWorld> {
    const stock = opts.stock ?? 100;
    const slug = freshTenantSlug(label, spec);
    const tenant = await h.A.prisma.tenant.create({ data: { slug, name: `SA-767 L-2.4 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await h.A.prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const idOf = (i: number) => `${tenant.id.slice(0, 8)}-${label}-${pad3(i)}`;
    await h.A.prisma.product.createMany({
      data: Array.from({ length: n }, (_, k) => ({
        id: idOf(k + 1),
        name: `Widget ${label} ${pad3(k + 1)}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: stock,
        averageCost: 2,
        costingMethod: "AVCO" as const,
        tenantId: tenant.id,
      })),
    });
    const session = await h.A.prisma.stockCountSession.create({
      data: { tenantId: tenant.id, startedById: user.id, name: `sa767 ${label}` },
    });
    if (opts.lines !== false) {
      await h.A.prisma.stockCountLine.createMany({
        data: Array.from({ length: n }, (_, k) => ({
          tenantId: tenant.id,
          sessionId: session.id,
          productId: idOf(k + 1),
          mode: "REPLACE" as const,
          countedQty: (opts.counted ?? (() => stock - 10))(k + 1),
          expectedQty: stock,
          countedById: user.id,
        })),
      });
    }
    return { tenantId: tenant.id, userId: user.id, sessionId: session.id, idOf };
  }

  const inTenant = <T>(s: Services, w: CountWorld, fn: () => Promise<T>) =>
    s.tenantCtx.run(w.tenantId, fn);
  const stockOfId = async (id: string) =>
    Number((await h.A.prisma.product.findUniqueOrThrow({ where: { id } })).currentStock);
  const commitSession = (s: Services, w: CountWorld, dto: Record<string, unknown> = {}) =>
    inTenant(s, w, () =>
      s.inventory.commitStockCountSession(w.sessionId, dto as any, { sub: w.userId }),
    );
  const upsert = (s: Services, w: CountWorld, dto: Record<string, unknown>) =>
    inTenant(s, w, () =>
      s.inventory.upsertStockCountLine(w.sessionId, dto as any, { sub: w.userId }),
    );
  const sessionOf = (w: CountWorld) =>
    h.A.prisma.stockCountSession.findUniqueOrThrow({ where: { id: w.sessionId } });
  const countMovements = (w: CountWorld) =>
    h.A.prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, reference: `STOCK_COUNT-${w.sessionId}` },
    });
  /** A sale, as the stock writers do it: relative decrement of the counter. */
  const sell = (id: string, qty: number) =>
    h.A.prisma.product.update({ where: { id }, data: { currentStock: { decrement: qty } } });

  /**
   * The FIRST `tenantTransaction` of `svc` runs its body, then parks (still holding every lock the
   * body took) until the gate is released. Later calls (a retry) run untouched.
   */
  function holdFirstTxOpen(svc: Services): Gate {
    const gate = new Gate();
    gates.push(gate);
    const original = svc.prisma.tenantTransaction.bind(svc.prisma) as any;
    let first = true;
    jest.spyOn(svc.prisma, "tenantTransaction").mockImplementation(((fn: any, opts?: any) => {
      if (!first) return original(fn, opts);
      first = false;
      return original(
        async (tx: any) => {
          const result = await fn(tx);
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await gate.hold(pid);
          return result;
        },
        { ...opts, timeout: 30_000, maxWait: 15_000 },
      );
    }) as any);
    return gate;
  }

  /** True once some backend is genuinely WAITING on a lock held by `holderPid`. */
  async function sawLockWait(holderPid: number, withinMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND pg_blocking_pids(pid) @> ARRAY[$1::int]`,
        [holderPid],
      );
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    return false;
  }

  return Object.assign(h, {
    seedCountWorld,
    inTenant,
    stockOfId,
    commitSession,
    upsert,
    sessionOf,
    countMovements,
    sell,
    holdFirstTxOpen,
    sawLockWait,
  });
}

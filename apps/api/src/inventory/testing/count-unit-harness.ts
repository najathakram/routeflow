/**
 * SA-767 L-2.4 - the shared mock world of the stock-count unit specs (`stock-count-*.spec.ts`):
 * an `InventoryService` over the mock Prisma, a stock map the product update/read mocks share, an
 * in-memory movement ledger, and a `tenantTransaction` whose tx carries `$queryRaw` (the advisory
 * lock probe: `countLockHeld` flips its answer) and `$executeRaw` (the product lock statements).
 *
 * The spec file owns `jest.mock("../common/db-locks")` (jest hoists it per file) and passes its
 * `withAdvisoryLock` mock in.
 */
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { InventoryService } from "../inventory.service";
import { PrismaService } from "../../prisma/prisma.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { StockAlertService } from "../../stock-alerts/stock-alert.service";
import { AuditService } from "../../audit/audit.service";

export const D = (n: number | string) => new Prisma.Decimal(n);
export const pid = (i: number) => `p${String(i).padStart(3, "0")}`;
export const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

export interface CountUnitWorld {
  service: InventoryService;
  prisma: ReturnType<typeof createMockPrisma>;
  audit: { log: jest.Mock };
  /** Live stock per product id (the update mock increments it). */
  stock: Map<string, Prisma.Decimal>;
  /** Product kinds / flags by id (default STANDARD, active). */
  kinds: Map<string, string>;
  active: Map<string, boolean>;
  /** Products that no longer exist. */
  gone: Set<string>;
  /** Every movement the create mock accepted: { id, productId, type }. */
  ledger: Array<{ id: string; productId: string; type: string }>;
  /** Flip to simulate the committer holding the session's exclusive lock. */
  state: { countLockHeld: boolean };
  /** Order of interesting calls: "tx", "lock", "session-read", "movement-read", "product-read",
   * "xlock:<family>|<key>" (a blocking tx advisory lock), "overlap-read" (the other-open-count lookup). */
  events: string[];
  seed: (ids: string[], currentStock?: number) => void;
}

export async function buildCountUnitWorld(
  mockWithAdvisoryLock: jest.Mock,
): Promise<CountUnitWorld> {
  const prisma = createMockPrisma();
  const stock = new Map<string, Prisma.Decimal>();
  const kinds = new Map<string, string>();
  const active = new Map<string, boolean>();
  const gone = new Set<string>();
  const ledger: CountUnitWorld["ledger"] = [];
  const state = { countLockHeld: false };
  const events: string[] = [];
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  mockWithAdvisoryLock.mockReset();
  mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }));
  prisma.tenantTransaction.mockImplementation(async (fn: any) => {
    events.push("tx");
    const tx = {
      ...prisma,
      $executeRaw: jest.fn().mockImplementation((s: TemplateStringsArray, ...v: unknown[]) => {
        // SA-767 r-note 5 SA-3: the per-product blocking xact lock, recorded with its (family, key).
        if (s.join("?").includes("pg_advisory_xact_lock")) events.push(`xlock:${v.join("|")}`);
        return Promise.resolve(0);
      }),
      $queryRaw: jest.fn().mockImplementation((s: TemplateStringsArray) => {
        if (s.join("?").includes("pg_try_advisory_xact_lock_shared")) {
          events.push("lock");
          return Promise.resolve([{ ok: !state.countLockHeld }]);
        }
        return Promise.resolve([]);
      }),
    };
    return fn(tx);
  });
  const known = (id: string) => stock.has(id) && !gone.has(id);
  prisma.product.findMany.mockImplementation(async (args: any) => {
    const wanted: string[] = args?.where?.id?.in ?? [...stock.keys()];
    return wanted.filter(known).map((id) => ({
      id,
      name: `Widget ${id}`,
      kind: kinds.get(id) ?? "STANDARD",
      isActive: active.get(id) ?? true,
      currentStock: stock.get(id),
      averageCost: D(2),
      costingMethod: "AVCO",
      unitsPerBox: null,
    }));
  });
  prisma.product.findFirst.mockImplementation(async (args: any) => {
    events.push("product-read");
    const id = args?.where?.id;
    if (!known(id)) return null;
    return {
      id,
      name: `Widget ${id}`,
      kind: kinds.get(id) ?? "STANDARD",
      currentStock: stock.get(id),
      unitsPerBox: null,
    };
  });
  prisma.product.update.mockImplementation(async ({ where, data }: any) => {
    const next = stock.get(where.id)!.plus(data.currentStock.increment);
    stock.set(where.id, next);
    return { currentStock: next };
  });
  let mv = 0;
  prisma.stockMovement.create.mockImplementation(async ({ data }: any) => {
    const row = { id: `mv-${++mv}`, productId: data.productId, type: data.type };
    ledger.push(row);
    return row;
  });
  prisma.stockMovement.findMany.mockImplementation(async (args: any) => {
    events.push("movement-read");
    const inIds: string[] | undefined = args?.where?.productId?.in;
    return ledger.filter((m) => !inIds || inIds.includes(m.productId));
  });
  prisma.stockMovement.findFirst.mockImplementation(async () => {
    events.push("movement-read");
    return ledger[0] ?? null;
  });
  prisma.stockCountSession.updateMany.mockResolvedValue({ count: 1 });

  const mod = await Test.createTestingModule({
    providers: [
      InventoryService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      {
        provide: StockAlertService,
        useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
      },
    ],
  }).compile();
  const service = mod.get(InventoryService);
  jest.spyOn(service, "fireStockAlerts").mockImplementation(() => undefined);

  return {
    service,
    prisma,
    audit,
    stock,
    kinds,
    active,
    gone,
    ledger,
    state,
    events,
    seed: (ids, currentStock = 100) => {
      for (const id of ids) stock.set(id, D(currentStock));
    },
  };
}

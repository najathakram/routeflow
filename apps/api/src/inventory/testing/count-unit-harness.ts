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
import { wireStockHelper } from "./stock-helper-mock";

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
  /** Every movement the stock helper inserted (SA-927: one `createManyAndReturn` per call): { id, productId, type }. */
  ledger: Array<{ id: string; productId: string; type: string }>;
  /** The full rows the helper inserted, in order (quantity, stockAfter, avgCostAfter, ...). */
  written: () => Array<Record<string, any>>;
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
  const inserted: Array<Record<string, any>> = [];
  const state = { countLockHeld: false };
  const events: string[] = [];
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  // SA-927: the REAL stock helper runs over this world; its locked read is the `stock` map below
  // (every product is AVCO at an average of 2), and what it inserts lands in `ledger`.
  const known = (id: string) => stock.has(id) && !gone.has(id);
  const helper = wireStockHelper(prisma, {
    stateOf: (ids) =>
      ids.filter(known).map((id) => ({
        id,
        currentStock: stock.get(id),
        averageCost: D(2),
        costingMethod: "AVCO",
      })),
  });

  mockWithAdvisoryLock.mockReset();
  mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }));
  prisma.tenantTransaction.mockImplementation(async (fn: any) => {
    events.push("tx");
    const tx = helper.wrapTx({
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
    });
    // A tx that throws rolls back (Postgres): the helper inserts before it writes the counter, so a
    // failed attempt must not leave its movements or its stock behind for the retry to find.
    const ledgerLen = ledger.length;
    const insertedLen = inserted.length;
    const stockBefore = new Map(stock);
    try {
      return await fn(tx);
    } catch (e) {
      ledger.length = ledgerLen;
      inserted.length = insertedLen;
      stock.clear();
      for (const [k, v] of stockBefore) stock.set(k, v);
      throw e;
    }
  });
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
    // SA-927: the helper writes the folded stock as an absolute value
    const next = D(data.currentStock);
    stock.set(where.id, next);
    return { currentStock: next };
  });
  (prisma.stockMovement as any).createManyAndReturn.mockImplementation(async ({ data }: any) =>
    data.map((d: any) => {
      inserted.push(d);
      ledger.push({ id: d.id, productId: d.productId, type: d.type });
      return {
        id: d.id,
        productId: d.productId,
        stockAfter: d.stockAfter,
        avgCostAfter: d.avgCostAfter,
      };
    }),
  );
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
    written: () => inserted,
    state,
    events,
    seed: (ids, currentStock = 100) => {
      for (const id of ids) stock.set(id, D(currentStock));
    },
  };
}

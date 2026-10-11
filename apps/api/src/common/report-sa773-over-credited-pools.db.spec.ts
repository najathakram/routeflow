/**
 * SA-773 census SQL on stored rows (real Postgres): the statement flags a pool credited past its billed gross value and an order
 * credited past its billed net, and nothing else. Runs the REAL script (`--list`) against the lane database and reads only this
 * run's throwaway tenants out of its output (the census itself reads every tenant, by design).
 *
 *   X1  a standalone credit note item AND an inline return for the same $20 line: over by $20, in the pool and the order sections.
 *   X2  a partial credit ($8 of $20): clean.
 *   X3  a VOID credit note item and a REJECTED inline return: clean.
 *   X4  a STANDARD return refunded by a credit note that carries the items: counted once, clean.
 *   X5  a TAXED line ($100 + 10%) credited by an item of $100: gross $110 billed against $110 credited, clean.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import {
  addCreditNote,
  addInlineReturn,
  addStandardReturn,
  cleanupSeeded,
  seedRefundable,
} from "../../test/refundable-seed";

const RUN = randomUUID().slice(0, 8);
const SPEC = "report-sa773-over-credited-pools.db.spec.ts";
const SCRIPT = path.resolve(__dirname, "../../scripts/report-sa773-over-credited-pools.mjs");

describeDb("SA-773 census SQL - real Postgres", () => {
  let prisma: PrismaService;
  const tenantIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await cleanupSeeded(prisma, tenantIds);
    await prisma?.$disconnect();
  }, 120_000);

  const seed = (label: string, line: { qty: number; subtotal: number; taxRate?: number }) =>
    seedRefundable(prisma, tenantIds, {
      run: RUN,
      spec: SPEC,
      label,
      invoices: [{ lines: [{ product: "A", ...line }] }],
    });
  const cn = () => `CN-SA773X-${RUN}-${++n}`;
  const rtn = () => `RTN-SA773X-${RUN}-${++n}`;

  /** The census rows of this run's tenants: `section orderId pool overage`. */
  const census = (): string[] => {
    const r = spawnSync(process.execPath, [SCRIPT, "--list", "--ack-ids-only"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: requireLocalDatabaseUrl() },
      timeout: 120_000,
    });
    expect(r.status).toBe(0);
    return String(r.stdout)
      .split("\n")
      .slice(1)
      .map((l) => l.split("\t"))
      .filter((c) => tenantIds.includes(c[1]))
      .map((c) => `${c[0]} ${c[2]} ${c[3]} ${c[4]}`);
  };

  it("X1-X5: only the double pay is listed (pool and order sections), with its overage", async () => {
    const x1 = await seed("x1", { qty: 4, subtotal: 20 });
    await addCreditNote(prisma, x1, { number: cn(), items: [{ line: 0, amount: 20, qty: 4 }] });
    await addInlineReturn(prisma, x1, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ line: 0, qty: 4, subtotal: 20 }],
    });

    const x2 = await seed("x2", { qty: 4, subtotal: 20 });
    await addCreditNote(prisma, x2, { number: cn(), items: [{ line: 0, amount: 8, qty: 1.6 }] });

    const x3 = await seed("x3", { qty: 4, subtotal: 20 });
    await addCreditNote(prisma, x3, {
      number: cn(),
      status: "VOID",
      items: [{ line: 0, amount: 20, qty: 4 }],
    });
    await addInlineReturn(prisma, x3, {
      number: rtn(),
      status: "REJECTED",
      items: [{ line: 0, qty: 4, subtotal: 20 }],
    });

    const x4 = await seed("x4", { qty: 4, subtotal: 20 });
    const note = await addCreditNote(prisma, x4, {
      number: cn(),
      items: [{ line: 0, amount: 20, qty: 4 }],
    });
    await addStandardReturn(prisma, x4, {
      number: rtn(),
      status: "REFUNDED",
      items: [{ product: "A", qty: 4 }],
      creditNoteId: note.id,
      refundMethod: "CREDIT_NOTE",
      refundAmount: 20,
    });

    const x5 = await seed("x5", { qty: 10, subtotal: 100, taxRate: 0.1 });
    await addCreditNote(prisma, x5, { number: cn(), items: [{ line: 0, amount: 100, qty: 10 }] });

    const rows = census();
    expect(rows.sort()).toEqual(
      [
        `pool ${x1.invoices[0].id} ${x1.products.A} 20.00`,
        `order ${x1.invoices[0].id}  20.00`,
      ].sort(),
    );
  });
});

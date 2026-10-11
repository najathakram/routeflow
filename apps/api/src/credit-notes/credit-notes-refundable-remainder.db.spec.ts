/**
 * SA-773: a standalone credit note is a value-giver on real Postgres. Goods a return already reserves (a pending STANDARD return
 * counts at its stored qty) or an earlier credit note took cannot be credited again: 409 CREDIT_EXCEEDS_REFUNDABLE with what is
 * left, nothing minted. The mirror (a refund after a credit note) is RETURN_EXCEEDS_REFUNDABLE in
 * returns-refundable-remainder.db.spec.ts.
 *
 *   C1  an APPROVED return of the whole $20 line, then a $20 credit note item for it: 409, remainingValue 0, no credit note row.
 *   C2  a RECEIVED return of 1.6 of 4 (worth $8): a credit of the remaining $12 mints; one of $13 is refused with $12 left.
 *   C3  a REJECTED return reserves nothing; a VOID credit note takes nothing.
 *   C4  an amount-only credit note is held to the invoice-level remainder ($30 reserved of $50: $25 is refused, $20 mints).
 *   C5  a credit note and a store-credit refund of the same goods racing behind the invoice lock: one wins, the other is 409, and
 *       what is credited never exceeds the line.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import type { CreditNotesService } from "./credit-notes.service";
import type { ReturnsService } from "../returns/returns.service";
import {
  addCreditNote,
  addStandardReturn,
  cleanupSeeded,
  seedRefundable,
  type Seeded,
  type SeedInvoice,
} from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg");

const RUN = randomUUID().slice(0, 8);
const SPEC = "credit-notes-refundable-remainder.db.spec.ts";

describeDb("SA-773 standalone credit notes read the refundable remainder - real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let creditNotes: CreditNotesService;
  let returns: ReturnsService;
  let ctl: any;
  const tenantIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    ctl = new Client({ connectionString: url });
    await ctl.connect();
    ({ creditNotes, returns } = await buildRefundServices(prisma, `SA773C-${RUN}`));
  }, 120_000);

  afterAll(async () => {
    await cleanupSeeded(prisma, tenantIds);
    await ctl?.end().catch(() => undefined);
    await prisma?.$disconnect();
  }, 120_000);

  const seed = (label: string, invoices: SeedInvoice[]) =>
    seedRefundable(prisma, tenantIds, { run: RUN, spec: SPEC, label, invoices });
  const asTenant = <T>(s: Seeded, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
  const credit = (s: Seeded, amount: number, items = true, line = 0) =>
    asTenant(s, () =>
      creditNotes.create({
        customerId: s.customerId,
        invoiceId: s.invoices[0].id,
        amount,
        ...(items ? { items: [{ invoiceItemId: s.invoices[0].lines[line].id, amount }] } : {}),
      } as any),
    );
  const fail = (p: Promise<unknown>): Promise<any> =>
    p.then(
      () => undefined,
      (e) => e,
    );
  const body = (e: any) => e?.getResponse?.() ?? {};
  const noteCount = (s: Seeded) => prisma.creditNote.count({ where: { tenantId: s.tenantId } });
  const rtn = () => `RTN-SA773C-${RUN}-${++n}`;
  const cn = () => `CN-SA773C-SEED-${RUN}-${++n}`;

  it("C1: an APPROVED return of the whole line, then a $20 credit note item for it: 409, remainingValue 0, no credit note", async () => {
    const s = await seed("c1", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "APPROVED",
      items: [{ product: "A", qty: 4 }],
    });
    const err = await fail(credit(s, 20));
    expect(err?.getStatus?.()).toBe(409);
    expect(body(err)).toMatchObject({
      code: "CREDIT_EXCEEDS_REFUNDABLE",
      invoiceId: s.invoices[0].id,
      productId: s.products.A,
      remainingQty: 0,
      remainingValue: 0,
    });
    expect(await noteCount(s)).toBe(0);
  });

  it("C2: a RECEIVED return of 1.6 of 4 (worth $8): the remaining $12 mints, $13 is refused with $12 left", async () => {
    const s = await seed("c2", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 1.6 }],
    });
    const err = await fail(credit(s, 13));
    expect(body(err)).toMatchObject({ code: "CREDIT_EXCEEDS_REFUNDABLE", remainingValue: 12 });
    expect(await noteCount(s)).toBe(0);
    await credit(s, 12);
    expect(await noteCount(s)).toBe(1);
  });

  it("C3: a REJECTED return reserves nothing and a VOID credit note takes nothing: the whole line mints", async () => {
    const s = await seed("c3", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "REJECTED",
      items: [{ product: "A", qty: 4 }],
    });
    await addCreditNote(prisma, s, {
      number: cn(),
      status: "VOID",
      items: [{ line: 0, amount: 20, qty: 4 }],
    });
    await credit(s, 20);
    expect(await noteCount(s)).toBe(2); // the void one and the new one
  });

  it("C4: an amount-only credit note is held to the invoice-level remainder ($30 reserved of $50 leaves $20)", async () => {
    const s = await seed("c4", [
      {
        lines: [
          { product: "A", qty: 5, subtotal: 30 },
          { product: "B", qty: 2, subtotal: 20 },
        ],
      },
    ]);
    await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 5 }],
    });
    const err = await fail(credit(s, 25, false));
    expect(body(err)).toMatchObject({
      code: "CREDIT_EXCEEDS_REFUNDABLE",
      invoiceId: s.invoices[0].id,
      remainingQty: null,
      remainingValue: 20,
    });
    await credit(s, 20, false);
    expect(await noteCount(s)).toBe(1);
  });

  it("C5: a credit note and a store-credit refund of the same goods racing behind the invoice lock never total more than the line", async () => {
    const s = await seed("c5", [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }]);
    const ret = await addStandardReturn(prisma, s, {
      number: rtn(),
      status: "RECEIVED",
      items: [{ product: "A", qty: 4 }],
    });
    const holder = new Client({ connectionString: process.env.DATABASE_URL as string });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE`, [s.invoices[0].id]);
    const refund = fail(
      asTenant(s, () =>
        returns.processRefund(
          ret.id,
          { method: "CREDIT_NOTE" } as any,
          { sub: s.userId, role: "OPERATOR" } as any,
        ),
      ),
    );
    const standalone = fail(credit(s, 20));
    // both are queued behind the holder's invoice lock (the refund claim also waits on it after its Return and Order locks)
    for (let i = 0; i < 200; i++) {
      const r = await ctl.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`,
      );
      if (r.rows[0].n >= 2) break;
      await new Promise((x) => setTimeout(x, 25));
    }
    await holder.query("COMMIT");
    await holder.end();
    const [refundErr, creditErr] = await Promise.all([refund, standalone]);
    const live = await prisma.creditNote.findMany({
      where: { tenantId: s.tenantId, status: { not: "VOID" } },
    });
    const total = live.reduce((t, c) => t + Number(c.amount), 0);
    expect(total).toBeLessThanOrEqual(20);
    // exactly one side won; the loser is a coded 409, never a 500
    const losers = [refundErr, creditErr].filter(Boolean);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.getStatus?.()).toBe(409);
  });
});

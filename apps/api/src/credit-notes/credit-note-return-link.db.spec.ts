/**
 * SA-773 row 333(a) on real Postgres: a return's credit note is linked inside the mint transaction, and a retry returns the
 * existing credit note.
 *
 *   L1  a simulated crash AFTER the mint (every after-the-commit `Return.update` throws): the refund still finishes with the
 *       return REFUNDED, linked, and exactly one credit note. Before: the link was that after-the-commit write, so the credit note
 *       was committed with nobody pointing at it.
 *   L2  a retry of the same mint (the same return) gets the first credit note back: one row, the same id.
 *   L3  two mints of one return racing: one credit note, both calls answer with it.
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
  addStandardReturn,
  cleanupSeeded,
  seedRefundable,
  type Seeded,
} from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";

const RUN = randomUUID().slice(0, 8);
const SPEC = "credit-note-return-link.db.spec.ts";

describeDb(
  "SA-773 row 333(a): the return's credit note link is part of the mint - real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let creditNotes: CreditNotesService;
    let returns: ReturnsService;
    const tenantIds: string[] = [];
    let n = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      ({ creditNotes, returns } = await buildRefundServices(prisma, `SA773L-${RUN}`));
    }, 120_000);

    afterEach(() => jest.restoreAllMocks());

    afterAll(async () => {
      await cleanupSeeded(prisma, tenantIds);
      await prisma?.$disconnect();
    }, 120_000);

    const seedReturn = async (label: string): Promise<{ s: Seeded; returnId: string }> => {
      const s = await seedRefundable(prisma, tenantIds, {
        run: RUN,
        spec: SPEC,
        label,
        invoices: [{ lines: [{ product: "A", qty: 4, subtotal: 20 }] }],
      });
      const ret = await addStandardReturn(prisma, s, {
        number: `RTN-SA773L-${RUN}-${++n}`,
        status: "RECEIVED",
        items: [{ product: "A", qty: 4 }],
      });
      return { s, returnId: ret.id };
    };
    const notes = (s: Seeded) => prisma.creditNote.findMany({ where: { tenantId: s.tenantId } });
    const mintDto = (s: Seeded) => ({
      customerId: s.customerId,
      invoiceId: s.invoices[0].id,
      amount: 20,
      reason: "SA-773 return link",
    });

    it("L1: a crash after the mint (any after-the-commit Return.update throws): the refund finishes linked, with one credit note", async () => {
      const { s, returnId } = await seedReturn("l1");
      const real = prisma.forTenant.bind(prisma);
      jest.spyOn(prisma, "forTenant").mockImplementation((...args: any[]) => {
        const client: any = (real as any)(...args);
        return new Proxy(client, {
          get: (target, prop) =>
            prop === "return"
              ? new Proxy(target.return, {
                  get: (rt, rp) =>
                    rp === "update"
                      ? async () => {
                          throw new Error("crash before the link write");
                        }
                      : rt[rp],
                })
              : target[prop],
        });
      });
      await tenantCtx.run(s.tenantId, () =>
        returns.processRefund(
          returnId,
          { method: "CREDIT_NOTE" } as any,
          { sub: s.userId, role: "OPERATOR" } as any,
        ),
      );
      const after = await prisma.return.findUniqueOrThrow({ where: { id: returnId } });
      const rows = await notes(s);
      expect(rows).toHaveLength(1);
      expect([after.status, after.creditNoteId]).toEqual(["REFUNDED", rows[0].id]);
    });

    it("L2: the same mint retried returns the first credit note: one row, the same id", async () => {
      const { s, returnId } = await seedReturn("l2");
      const first = await tenantCtx.run(s.tenantId, () =>
        creditNotes.create(mintDto(s) as any, { ledgerReversedByReturn: true, returnId }),
      );
      const again = await tenantCtx.run(s.tenantId, () =>
        creditNotes.create(mintDto(s) as any, { ledgerReversedByReturn: true, returnId }),
      );
      expect(again.id).toBe(first.id);
      expect(await notes(s)).toHaveLength(1);
      expect(
        (await prisma.return.findUniqueOrThrow({ where: { id: returnId } })).creditNoteId,
      ).toBe(first.id);
    });

    it("L3: two mints of one return racing leave one credit note, and both calls answer with it", async () => {
      const { s, returnId } = await seedReturn("l3");
      const mint = () =>
        tenantCtx.run(s.tenantId, () =>
          creditNotes.create(mintDto(s) as any, { ledgerReversedByReturn: true, returnId }),
        );
      const [a, b] = await Promise.all([mint(), mint()]);
      expect(a.id).toBe(b.id);
      expect(await notes(s)).toHaveLength(1);
    });
  },
);

/**
 * SA-773 N4 (real Postgres): approving a HELD inline return whose source invoice went VOID or WRITTEN_OFF after the capture.
 * The refundable remainder has no pool for a dead invoice (it is excluded from the creditable set), so its request was
 * unchecked and the approval minted store credit for goods nobody owes for (hold 5 units of $50, void the invoice, approve:
 * $50 credit). It is now refused 409 RETURN_NOTHING_BILLED before anything is restocked, reversed or minted.
 *
 *   N4a  VOID source invoice: refused, the hold stays as it was (RECEIVED, held, no note, no stock moved).
 *   N4b  WRITTEN_OFF source invoice: the same.
 *   N4c  the same hold on a live invoice: approved, one $50 note (the check refuses only a dead source).
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`), run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { addInlineReturn, cleanupSeeded, seedRefundable } from "../../test/refundable-seed";
import { buildRefundServices } from "../../test/refundable-services";

const RUN = randomUUID().slice(0, 8);
const SPEC = "inline-return-approve-dead-source.db.spec.ts";

describeDb(
  "SA-773 N4: approve refuses a held return whose source invoice is dead - real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let inline: any;
    const tenantIds: string[] = [];
    let n = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      ({ inline } = await buildRefundServices(prisma, `SA773N4-${RUN}`));
    }, 120_000);

    afterAll(async () => {
      await cleanupSeeded(prisma, tenantIds);
      await prisma?.$disconnect();
    }, 120_000);

    /** A held (DRIVER_CAP) inline return of 5 units / $50 on a $50 invoice. */
    const heldReturn = async (label: string) => {
      const s = await seedRefundable(prisma, tenantIds, {
        run: RUN,
        spec: SPEC,
        label,
        invoices: [{ lines: [{ product: "A", qty: 5, subtotal: 50 }] }],
      });
      const ret = await addInlineReturn(prisma, s, {
        number: `RTN-SA773N4-${RUN}-${++n}`,
        status: "RECEIVED",
        hold: { reason: "DRIVER_CAP", amount: 50 },
        items: [{ line: 0, qty: 5, subtotal: 50 }],
      });
      const staff = {
        sub: s.userId,
        username: "operator",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId: s.tenantId,
        tenantSlug: "x",
      } as any;
      const approve = () =>
        tenantCtx
          .run(s.tenantId, () => inline.approve(ret.id, staff))
          .then(
            (v: any) => ({ ok: true as const, v }),
            (e: any) => ({ ok: false as const, e }),
          );
      return { s, ret, approve };
    };
    const state = async (s: any, returnId: string) => ({
      ret: await prisma.return.findUnique({ where: { id: returnId } }),
      notes: await prisma.creditNote.count({ where: { tenantId: s.tenantId } }),
      stock: Number(
        (await prisma.product.findUnique({ where: { id: s.products.A } }))?.currentStock ?? 0,
      ),
    });

    it.each(["VOID", "WRITTEN_OFF"] as const)(
      "N4a/b: a %s source invoice: 409 RETURN_NOTHING_BILLED, the hold is untouched and nothing is minted or restocked",
      async (status) => {
        const { s, ret, approve } = await heldReturn(`dead-${status.toLowerCase()}`);
        await prisma.invoice.update({ where: { id: s.invoices[0].id }, data: { status } });

        const out = await approve();

        expect(out.ok).toBe(false);
        const e: any = (out as any).e;
        expect(e?.getStatus?.()).toBe(409);
        expect(e?.getResponse?.().code).toBe("RETURN_NOTHING_BILLED");
        expect(e?.getResponse?.().invoiceId).toBe(s.invoices[0].id);
        const after = await state(s, ret.id);
        expect(after.ret?.status).toBe("RECEIVED");
        expect(after.ret?.holdReason).toBe("DRIVER_CAP");
        expect(after.ret?.creditNoteId).toBeNull();
        expect(after.notes).toBe(0);
        expect(after.stock).toBe(0);
      },
      60_000,
    );

    it("N4c: the same hold on a live source invoice is approved: one $50 note", async () => {
      const { s, ret, approve } = await heldReturn("live");
      const out = await approve();
      expect(out.ok).toBe(true);
      const after = await state(s, ret.id);
      expect(after.ret?.status).toBe("REFUNDED");
      expect(after.notes).toBe(1);
      const note = await prisma.creditNote.findFirst({ where: { tenantId: s.tenantId } });
      expect(Number(note?.amount)).toBe(50);
    }, 60_000);
  },
);

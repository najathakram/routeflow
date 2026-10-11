/**
 * SA-773 N4 (real Postgres): approving a HELD inline return whose source invoice went VOID or WRITTEN_OFF after the capture.
 * The refundable remainder has no pool for a dead invoice (it is excluded from the creditable set), so its request was
 * unchecked and the approval minted store credit for goods nobody owes for (hold 5 units of $50, void the invoice, approve:
 * $50 credit). It is now refused 409 RETURN_NOTHING_BILLED before anything is restocked, reversed or minted.
 *
 *   N4a  VOID source invoice: refused, the hold stays as it was (RECEIVED, held, no note, no stock moved).
 *   N4b  WRITTEN_OFF source invoice: the same.
 *   N4c  the same hold on a live invoice: approved, one $50 note (the check refuses only a dead source).
 *   N4d  storeCreditInstead on a REFUND-intent capture whose invoice was voided (the refused cash refund steers the operator
 *        to it): refused 409, the refund intent stays, no note. N4e the capture replay's issueCredit: the same.
 *   N4f  a source LINE that no longer exists (a DRAFT invoice edit recreated it): approve and storeCreditInstead refuse 409
 *        (an item with no pool must not mint unchecked); N4g a live source on storeCreditInstead still converts.
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

    type Shape = "held" | "refund-intent" | "received";
    /** An inline return of 5 units / $50 on a $50 invoice: a held DRIVER_CAP one, a pending REFUND one, or a plain RECEIVED one. */
    const captured = async (label: string, shape: Shape = "held") => {
      const s = await seedRefundable(prisma, tenantIds, {
        run: RUN,
        spec: SPEC,
        label,
        invoices: [{ lines: [{ product: "A", qty: 5, subtotal: 50 }] }],
      });
      const ret = await addInlineReturn(prisma, s, {
        number: `RTN-SA773N4-${RUN}-${++n}`,
        status: "RECEIVED",
        ...(shape === "held" ? { hold: { reason: "DRIVER_CAP" as const, amount: 50 } } : {}),
        ...(shape === "refund-intent" ? { refundMethod: "EXTERNAL_REFUND" } : {}),
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
      const settle = (fn: () => Promise<any>) =>
        tenantCtx.run(s.tenantId, fn).then(
          (v: any) => ({ ok: true as const, v }),
          (e: any) => ({ ok: false as const, e }),
        );
      return {
        s,
        ret,
        approve: () => settle(() => inline.approve(ret.id, staff)),
        storeCredit: () => settle(() => inline.storeCreditInstead(ret.id, staff)),
        issue: () => settle(() => inline.issueCredit(ret.id)),
      };
    };
    const heldReturn = (label: string) => captured(label, "held");
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

    it.each(["VOID", "WRITTEN_OFF"] as const)(
      "N4d: storeCreditInstead on a REFUND-intent return whose source invoice is %s: 409, the refund intent stays, no note",
      async (status) => {
        const { s, ret, storeCredit } = await captured(
          `sci-${status.toLowerCase()}`,
          "refund-intent",
        );
        await prisma.invoice.update({ where: { id: s.invoices[0].id }, data: { status } });

        const out = await storeCredit();

        expect(out.ok).toBe(false);
        const e: any = (out as any).e;
        expect(e?.getStatus?.()).toBe(409);
        expect(e?.getResponse?.().code).toBe("RETURN_NOTHING_BILLED");
        const after = await state(s, ret.id);
        expect(after.notes).toBe(0);
        expect(after.ret?.creditNoteId).toBeNull();
        expect(after.ret?.refundMethod).toBe("EXTERNAL_REFUND");
      },
      60_000,
    );

    it("N4e: the capture replay's issueCredit on a RECEIVED return whose source invoice was voided mints nothing", async () => {
      const { s, ret, issue } = await captured("issue-void", "received");
      await prisma.invoice.update({ where: { id: s.invoices[0].id }, data: { status: "VOID" } });

      const out = await issue();

      expect(out.ok).toBe(false);
      const e: any = (out as any).e;
      expect(e?.getStatus?.()).toBe(409);
      expect(e?.getResponse?.().code).toBe("RETURN_NOTHING_BILLED");
      const after = await state(s, ret.id);
      expect(after.notes).toBe(0);
      expect(after.ret?.creditNoteId).toBeNull();
    }, 60_000);

    it("N4f: a source LINE that no longer exists is refused 409 on approve and on storeCreditInstead, nothing minted", async () => {
      const held = await captured("line-gone-held", "held");
      await prisma.invoiceItem.delete({ where: { id: held.s.invoices[0].lines[0].id } });
      const a = await held.approve();
      expect(a.ok).toBe(false);
      expect((a as any).e?.getStatus?.()).toBe(409);
      expect((a as any).e?.getResponse?.().code).toBe("RETURN_NOTHING_BILLED");
      expect((await state(held.s, held.ret.id)).notes).toBe(0);

      const refund = await captured("line-gone-refund", "refund-intent");
      await prisma.invoiceItem.delete({ where: { id: refund.s.invoices[0].lines[0].id } });
      const c = await refund.storeCredit();
      expect(c.ok).toBe(false);
      expect((c as any).e?.getStatus?.()).toBe(409);
      expect((c as any).e?.getResponse?.().code).toBe("RETURN_NOTHING_BILLED");
      const after = await state(refund.s, refund.ret.id);
      expect(after.notes).toBe(0);
      expect(after.ret?.refundMethod).toBe("EXTERNAL_REFUND");
    }, 60_000);

    it("N4g: storeCreditInstead on a live source invoice still converts: one $50 note", async () => {
      const { s, ret, storeCredit } = await captured("sci-live", "refund-intent");
      const out = await storeCredit();
      expect(out.ok).toBe(true);
      const after = await state(s, ret.id);
      expect(after.notes).toBe(1);
      expect(after.ret?.refundMethod).toBe("CREDIT_NOTE");
    }, 60_000);
  },
);

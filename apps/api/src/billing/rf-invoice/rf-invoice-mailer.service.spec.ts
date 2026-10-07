// PR3 MAIL-2, MAIL-3, API-6, API-7 (service half), SEC-4 and the mode matrix: the RouteFlow invoice
// mailer (manual resend, bulk, issue email, d0/d7/d14 reminders). A real BillingNotificationService over
// a fake Prisma that enforces the claim's unique key, so "rerun sends nothing" is proved end to end.
// The CAS cooldown RACE needs a real database: rf-invoice-mailer.db.spec.ts.
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import * as fs from "fs";
import * as path from "path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { BillingNotificationService } from "../billing-notification.service";
import { RfInvoiceMailerService } from "./rf-invoice-mailer.service";

const NOW = new Date("2026-10-20T14:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const TODAY = new Date("2026-10-20T00:00:00.000Z");
const dueIn = (days: number) => new Date(TODAY.getTime() + days * DAY);
const ADMIN = "sa-1";

function inv(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: "tenant-acme",
    number: `RF-2026-${id.replace(/\D/g, "").padStart(4, "0")}`,
    amount: 149,
    currency: "USD",
    cycle: "MONTHLY",
    status: "OPEN",
    periodStart: dueIn(0),
    periodEnd: dueIn(30),
    dueDate: dueIn(0),
    lastSentAt: null as Date | null,
    sendCount: 0,
    lines: [
      {
        kind: "PLAN",
        code: "STARTER",
        label: "Starter plan",
        quantity: 1,
        unitAmount: 149,
        amount: 149,
      },
    ],
    ...over,
  };
}

/** The slice of Prisma `where` the mailer uses, evaluated for real. */
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(row, w));
    if (k === "tenant") return true;
    const actual = row[k];
    if (v === null) return actual === null || actual === undefined;
    if (v instanceof Date) return actual instanceof Date && actual.getTime() === v.getTime();
    if (v && typeof v === "object") {
      if ("lt" in v && !(actual != null && actual.getTime() < v.lt.getTime())) return false;
      if ("gte" in v && !(actual != null && actual.getTime() >= v.gte.getTime())) return false;
      if ("not" in v && actual === v.not) return false;
      return true;
    }
    return actual === v;
  });
}

function make(
  opts: {
    invoices?: any[];
    admins?: { email: string; username: string | null }[];
    deliver?: boolean;
  } = {},
) {
  const invoices = (opts.invoices ?? []).map((r) => ({ ...r }));
  const audits: any[] = [];
  const claims = new Set<string>();
  const prisma: any = {
    rfInvoice: {
      // copies, like the real client: a later updateMany must not rewrite a row already read
      findFirst: jest.fn(async ({ where }: any) => {
        const r = invoices.find((x) => matches(x, where));
        return r ? { ...r } : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        invoices.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = invoices.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = invoices.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        for (const [k, v] of Object.entries<any>(data)) {
          r[k] = v && typeof v === "object" && "increment" in v ? r[k] + v.increment : v;
        }
        return r;
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
    },
    billingNotificationLog: {
      create: jest.fn(async ({ data }: any) => {
        const k = `${data.tenantId}/${data.milestone}/${data.key}`;
        if (claims.has(k)) throw Object.assign(new Error("dup"), { code: "P2002" });
        claims.add(k);
        return {};
      }),
      delete: jest.fn(async ({ where }: any) => {
        const k = where.tenantId_milestone_key;
        claims.delete(`${k.tenantId}/${k.milestone}/${k.key}`);
        return {};
      }),
    },
    user: {
      findMany: jest.fn(async () =>
        opts.admins === undefined
          ? [
              { email: "jamie@acme.test", username: "Jamie" },
              { email: "sam@acme.test", username: "Sam" },
            ]
          : opts.admins,
      ),
    },
    tenant: { findUnique: jest.fn(async () => ({ name: "Acme Retail", slug: "acme" })) },
    tenantConfig: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const sendPlatform = jest.fn(async (_mail?: any) => ({
    delivered: opts.deliver !== false,
    transport: "smtp",
  }));
  const notifier = new BillingNotificationService(prisma, { sendPlatform } as any);
  const svc = new RfInvoiceMailerService(prisma, notifier);
  return { svc, prisma, invoices, audits, sendPlatform };
}

const sent = (audits: any[]) => audits.filter((a) => a.action === "RF_INVOICE_SENT");

describe("RfInvoiceMailerService", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.RF_INVOICING_MODE = "live";
    delete process.env.RF_INVOICE_TEST_TENANT_SLUGS;
  });
  afterAll(() => {
    process.env = { ...OLD };
  });

  describe("modes", () => {
    it("off (and unset): no manual send, no bulk send, no issue email, no reminders - zero sends, zero writes", async () => {
      for (const mode of ["off", undefined]) {
        if (mode === undefined) delete process.env.RF_INVOICING_MODE;
        else process.env.RF_INVOICING_MODE = mode;
        const { svc, prisma, sendPlatform } = make({
          invoices: [inv("inv-1", { dueDate: dueIn(-7) })],
        });
        await expect(svc.sendManual("inv-1", ADMIN, NOW)).rejects.toMatchObject({
          response: { code: API_ERROR_CODES.RF_INVOICING_OFF },
        });
        await expect(svc.sendMany(["inv-1"], ADMIN, NOW)).rejects.toBeInstanceOf(ConflictException);
        await svc.sendAuto("inv-1", "issue", NOW);
        const r = await svc.runRemind(NOW);
        expect(r.sent).toBe(0);
        expect(sendPlatform).not.toHaveBeenCalled();
        expect(prisma.rfInvoice.updateMany).not.toHaveBeenCalled();
        expect(prisma.rfInvoice.update).not.toHaveBeenCalled();
        expect(prisma.rfInvoice.findMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      }
    });

    it("silent: manual resend works; the issue email and the reminders send nothing", async () => {
      process.env.RF_INVOICING_MODE = "silent";
      const { svc, sendPlatform, audits } = make({
        invoices: [inv("inv-1"), inv("inv-2", { dueDate: dueIn(-7) })],
      });
      const r = await svc.sendManual("inv-1", ADMIN, NOW);
      expect(r.outcome).toBe("sent");
      expect(sendPlatform).toHaveBeenCalledTimes(2);
      sendPlatform.mockClear();
      await svc.sendAuto("inv-2", "issue", NOW);
      expect((await svc.runRemind(NOW)).sent).toBe(0);
      expect(sendPlatform).not.toHaveBeenCalled();
      expect(sent(audits)).toHaveLength(1);
    });
  });

  describe("manual resend", () => {
    it("sends to every admin, stamps lastSentAt, bumps sendCount, and writes ONE RF_INVOICE_SENT audit row", async () => {
      const { svc, invoices, audits, sendPlatform } = make({ invoices: [inv("inv-1")] });
      const r = await svc.sendManual("inv-1", ADMIN, NOW);
      expect(r).toMatchObject({ id: "inv-1", outcome: "sent", recipients: 2 });
      expect(sendPlatform).toHaveBeenCalledTimes(2);
      expect(invoices[0].lastSentAt).toEqual(NOW);
      expect(invoices[0].sendCount).toBe(1);
      expect(sent(audits)).toHaveLength(1);
      expect(sent(audits)[0]).toMatchObject({
        tenantId: "tenant-acme",
        userId: ADMIN,
        meta: expect.objectContaining({ number: "RF-2026-0001", trigger: "manual", recipients: 2 }),
      });
    });

    it("SEC-4: the audit row carries a numeric recipient COUNT and no address anywhere", async () => {
      const { svc, audits } = make({ invoices: [inv("inv-1")] });
      await svc.sendManual("inv-1", ADMIN, NOW);
      const row = sent(audits)[0];
      expect(typeof row.meta.recipients).toBe("number");
      expect(JSON.stringify(row)).not.toContain("@");
      expect(JSON.stringify(row)).not.toContain("acme.test");
    });

    it("API-6: inside the 10-minute cooldown it sends nothing and reports when it may be sent again", async () => {
      const last = new Date(NOW.getTime() - 5 * MIN);
      const { svc, invoices, sendPlatform, audits } = make({
        invoices: [inv("inv-1", { lastSentAt: last, sendCount: 1 })],
      });
      const r = await svc.sendManual("inv-1", ADMIN, NOW);
      expect(r.outcome).toBe("cooldown");
      expect(new Date(r.nextAllowedAt as string).getTime()).toBe(last.getTime() + 10 * MIN);
      expect(sendPlatform).not.toHaveBeenCalled();
      expect(invoices[0].sendCount).toBe(1);
      expect(invoices[0].lastSentAt).toEqual(last);
      expect(sent(audits)).toHaveLength(0);
    });

    it("API-6: a second immediate resend is the cooldown (the claim is the CAS), one email batch total", async () => {
      const { svc, sendPlatform } = make({ invoices: [inv("inv-1")] });
      expect((await svc.sendManual("inv-1", ADMIN, NOW)).outcome).toBe("sent");
      expect((await svc.sendManual("inv-1", ADMIN, new Date(NOW.getTime() + MIN))).outcome).toBe(
        "cooldown",
      );
      expect(sendPlatform).toHaveBeenCalledTimes(2);
    });

    it("API-6: just past the cooldown it sends again", async () => {
      const last = new Date(NOW.getTime() - 10 * MIN - 1);
      const { svc } = make({ invoices: [inv("inv-1", { lastSentAt: last, sendCount: 1 })] });
      const r = await svc.sendManual("inv-1", ADMIN, NOW);
      expect(r.outcome).toBe("sent");
    });

    it("a PAID or VOID invoice is not_open and sends nothing", async () => {
      const { svc, sendPlatform } = make({
        invoices: [inv("inv-1", { status: "PAID" }), inv("inv-2", { status: "VOID" })],
      });
      expect((await svc.sendManual("inv-1", ADMIN, NOW)).outcome).toBe("not_open");
      expect((await svc.sendManual("inv-2", ADMIN, NOW)).outcome).toBe("not_open");
      expect(sendPlatform).not.toHaveBeenCalled();
    });

    it("an unknown id is a 404 on the single route", async () => {
      const { svc } = make();
      await expect(svc.sendManual("nope", ADMIN, NOW)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("MAIL-3: no admins -> no_recipients, lastSentAt restored, sendCount unchanged, no audit row", async () => {
      const prev = new Date(NOW.getTime() - 3 * DAY);
      const { svc, invoices, audits, sendPlatform } = make({
        admins: [],
        invoices: [inv("inv-1", { lastSentAt: prev, sendCount: 2 })],
      });
      const r = await svc.sendManual("inv-1", ADMIN, NOW);
      expect(r.outcome).toBe("no_recipients");
      expect(invoices[0].lastSentAt).toEqual(prev);
      expect(invoices[0].sendCount).toBe(2);
      expect(sent(audits)).toHaveLength(0);
      expect(sendPlatform).not.toHaveBeenCalled();
    });

    it("MAIL-3: never sent before -> lastSentAt restored to null", async () => {
      const { svc, invoices } = make({ admins: [], invoices: [inv("inv-1")] });
      await svc.sendManual("inv-1", ADMIN, NOW);
      expect(invoices[0].lastSentAt).toBeNull();
    });

    it("MAIL-3: a transport that delivers nothing -> failed, restored, no audit row", async () => {
      const { svc, invoices, audits } = make({ deliver: false, invoices: [inv("inv-1")] });
      const r = await svc.sendManual("inv-1", ADMIN, NOW);
      expect(r.outcome).toBe("failed");
      expect(invoices[0].lastSentAt).toBeNull();
      expect(invoices[0].sendCount).toBe(0);
      expect(sent(audits)).toHaveLength(0);
    });

    it("the lookup is scoped to PRODUCTION tenants (plus the allowlist)", async () => {
      const { svc, prisma } = make({ invoices: [inv("inv-1")] });
      await svc.sendManual("inv-1", ADMIN, NOW);
      expect(prisma.rfInvoice.findFirst.mock.calls[0][0].where).toMatchObject({
        id: "inv-1",
        tenant: { class: "PRODUCTION", deletedAt: null },
      });
    });
  });

  describe("bulk", () => {
    it("API-7: more than 50 ids is a 400 and nothing is sent", async () => {
      const { svc, sendPlatform } = make();
      const ids = Array.from({ length: 51 }, (_, i) => `inv-${i + 1}`);
      await expect(svc.sendMany(ids, ADMIN, NOW)).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.sendMany([], ADMIN, NOW)).rejects.toBeInstanceOf(BadRequestException);
      expect(sendPlatform).not.toHaveBeenCalled();
    });

    it("API-7: mixed outcomes, in request order, one result per id", async () => {
      const { svc, sendPlatform } = make({
        invoices: [
          inv("inv-1"),
          inv("inv-2", { lastSentAt: new Date(NOW.getTime() - MIN), sendCount: 1 }),
          inv("inv-3", { status: "PAID" }),
          inv("inv-4"),
        ],
      });
      const res = await svc.sendMany(["inv-1", "inv-2", "inv-3", "ghost", "inv-4"], ADMIN, NOW);
      expect(res.results.map((r: any) => [r.id, r.outcome])).toEqual([
        ["inv-1", "sent"],
        ["inv-2", "cooldown"],
        ["inv-3", "not_open"],
        ["ghost", "not_found"],
        ["inv-4", "sent"],
      ]);
      expect(res.results[1].nextAllowedAt).toBeDefined();
      expect(sendPlatform).toHaveBeenCalledTimes(4); // two invoices x two admins
    });

    it("API-7: a repeated id is processed once", async () => {
      const { svc, sendPlatform } = make({ invoices: [inv("inv-1")] });
      const res = await svc.sendMany(["inv-1", "inv-1"], ADMIN, NOW);
      expect(res.results).toHaveLength(1);
      expect(sendPlatform).toHaveBeenCalledTimes(2);
    });

    it("exactly 50 ids is accepted", async () => {
      const ids = Array.from({ length: 50 }, (_, i) => `inv-${i + 1}`);
      const { svc } = make({ invoices: ids.map((id) => inv(id)) });
      const res = await svc.sendMany(ids, ADMIN, NOW);
      expect(res.results).toHaveLength(50);
    });
  });

  describe("issue email", () => {
    it("live: sent once under the '<number>:issued' claim, with an RF_INVOICE_SENT trigger issue audit", async () => {
      const { svc, sendPlatform, invoices, audits, prisma } = make({ invoices: [inv("inv-1")] });
      await svc.sendAuto("inv-1", "issue", NOW);
      expect(sendPlatform).toHaveBeenCalledTimes(2);
      expect(prisma.billingNotificationLog.create).toHaveBeenCalledWith({
        data: { tenantId: "tenant-acme", milestone: "rf-invoice", key: "RF-2026-0001:issued" },
      });
      expect(invoices[0].sendCount).toBe(1);
      expect(invoices[0].lastSentAt).toEqual(NOW);
      expect(sent(audits)[0].meta).toMatchObject({ trigger: "issue", recipients: 2 });
      expect(sent(audits)[0].userId).toBeNull();
      sendPlatform.mockClear();
      await svc.sendAuto("inv-1", "issue", NOW);
      expect(sendPlatform).not.toHaveBeenCalled();
    });

    it("never throws, and sends nothing for an invoice that is no longer OPEN", async () => {
      const { svc, sendPlatform } = make({ invoices: [inv("inv-1", { status: "PAID" })] });
      await expect(svc.sendAuto("inv-1", "issue", NOW)).resolves.toBeUndefined();
      await expect(svc.sendAuto("ghost", "issue", NOW)).resolves.toBeUndefined();
      expect(sendPlatform).not.toHaveBeenCalled();
    });
  });

  describe("reminders", () => {
    it("MAIL-2: d7 is sent once; a rerun the same day sends nothing", async () => {
      const { svc, sendPlatform, audits } = make({
        invoices: [inv("inv-1", { dueDate: dueIn(-7) })],
      });
      const first = await svc.runRemind(NOW);
      expect(first.sent).toBe(1);
      expect(sendPlatform).toHaveBeenCalledTimes(2);
      expect(sendPlatform.mock.calls[0][0]).toMatchObject({
        subject: "Reminder: RouteFlow invoice RF-2026-0001 is 7 days overdue",
      });
      expect(sent(audits)[0].meta).toMatchObject({ trigger: "d7", recipients: 2 });
      sendPlatform.mockClear();
      const again = await svc.runRemind(NOW);
      expect(again.sent).toBe(0);
      expect(sendPlatform).not.toHaveBeenCalled();
      expect(sent(audits)).toHaveLength(1);
    });

    it("MAIL-2: a PAID or VOID invoice is never reminded", async () => {
      const { svc, sendPlatform } = make({
        invoices: [
          inv("inv-1", { dueDate: dueIn(-7), status: "PAID" }),
          inv("inv-2", { dueDate: dueIn(-7), status: "VOID" }),
        ],
      });
      expect((await svc.runRemind(NOW)).sent).toBe(0);
      expect(sendPlatform).not.toHaveBeenCalled();
    });

    it("d0 (due today), d7 and d14 each fire on their own day, with their own claim key", async () => {
      const { svc, prisma } = make({
        invoices: [
          inv("inv-1", { dueDate: dueIn(0) }),
          inv("inv-2", { dueDate: dueIn(-7) }),
          inv("inv-3", { dueDate: dueIn(-14) }),
        ],
      });
      expect((await svc.runRemind(NOW)).sent).toBe(3);
      const keys = prisma.billingNotificationLog.create.mock.calls.map((c: any) => c[0].data.key);
      expect(keys.sort()).toEqual(["RF-2026-0001:d0", "RF-2026-0002:d7", "RF-2026-0003:d14"]);
    });

    it("nothing on a day that is not a stage, nothing before the due date, and NOTHING after d14", async () => {
      const { svc, sendPlatform } = make({
        invoices: [
          inv("inv-1", { dueDate: dueIn(3) }),
          inv("inv-2", { dueDate: dueIn(-1) }),
          inv("inv-3", { dueDate: dueIn(-3) }),
          inv("inv-4", { dueDate: dueIn(-10) }),
          inv("inv-5", { dueDate: dueIn(-15) }),
          inv("inv-6", { dueDate: dueIn(-30) }),
          inv("inv-7", { dueDate: dueIn(-120) }),
        ],
      });
      expect((await svc.runRemind(NOW)).sent).toBe(0);
      expect(sendPlatform).not.toHaveBeenCalled();
    });

    it("only OPEN invoices within the 14-day window of PRODUCTION tenants are read", async () => {
      const { svc, prisma } = make();
      await svc.runRemind(NOW);
      const where = prisma.rfInvoice.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        status: "OPEN",
        tenant: { class: "PRODUCTION", deletedAt: null },
      });
      expect(where.dueDate.gte).toEqual(dueIn(-14));
      expect(where.dueDate.lt).toEqual(dueIn(1));
    });

    it("an approved test tenant on RF_INVOICE_TEST_TENANT_SLUGS widens the scope", async () => {
      process.env.RF_INVOICE_TEST_TENANT_SLUGS = "e2e-acme";
      const { svc, prisma } = make();
      await svc.runRemind(NOW);
      expect(prisma.rfInvoice.findMany.mock.calls[0][0].where.tenant).toEqual({
        deletedAt: null,
        OR: [{ class: "PRODUCTION" }, { slug: { in: ["e2e-acme"] } }],
      });
    });

    it("a failed delivery is retried on the next tick (the claim is released)", async () => {
      const { svc, sendPlatform, invoices } = make({
        deliver: false,
        invoices: [inv("inv-1", { dueDate: dueIn(-7) })],
      });
      expect((await svc.runRemind(NOW)).sent).toBe(0);
      expect(invoices[0].sendCount).toBe(0);
      sendPlatform.mockClear();
      await svc.runRemind(NOW);
      expect(sendPlatform).toHaveBeenCalled(); // not suppressed as "already sent"
    });

    it("flag-only (SEC-5): the mailer never writes a tenant, a subscription, an event or a status", () => {
      const src = fs.readFileSync(path.join(__dirname, "rf-invoice-mailer.service.ts"), "utf8");
      for (const banned of [
        /tenant\.update/,
        /tenantSubscription\.(update|create|upsert|delete)/,
        /billingEvent/i,
        /SUSPENDED/,
        /\$executeRaw/,
      ]) {
        expect(src).not.toMatch(banned);
      }
    });
  });
});

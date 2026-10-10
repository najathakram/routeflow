import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  RECURRING_INVOICES_CRON,
  calcNextRunAt,
  firstTickAtOrAfter,
  resumeSchedulesOnRestore,
} from "./recurring-schedule";

/**
 * F-05 (SA-290, SA-308): a customer RESTORE ends a pause, but only cycles the removal actually skipped are skipped.
 * A template is advanced iff a billing tick T fell INSIDE the removal: max(nextRunAt, deletedAt) <= T <= now, with T
 * from the cron's OWN schedule (RECURRING_INVOICES_CRON). Otherwise nextRunAt is untouched and the cron bills it.
 */
describe("firstTickAtOrAfter: the cron's own schedule", () => {
  it("is the next local midnight, and a tick exactly at t is 'at'", () => {
    expect(firstTickAtOrAfter(new Date(2026, 8, 25, 9, 0, 0))).toEqual(
      new Date(2026, 8, 26, 0, 0, 0),
    );
    expect(firstTickAtOrAfter(new Date(2026, 8, 26, 0, 0, 0))).toEqual(
      new Date(2026, 8, 26, 0, 0, 0),
    );
  });
});

describe("resumeSchedulesOnRestore", () => {
  // all times are LOCAL, like the cron
  const now = new Date(2026, 8, 25, 9, 5, 0); // today 09:05
  const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m, 0);
  const row = (id: string, nextRunAt: Date, extra: object = {}) => ({
    id,
    frequency: "WEEKLY",
    dayOfWeek: 1,
    dayOfMonth: 1,
    nextRunAt,
    ...extra,
  });
  let tx: any;
  beforeEach(() => {
    tx = {
      recurringInvoice: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  });
  const customer = (deletedAt: Date | null) => ({ id: "c1", tenantId: "t1", deletedAt });
  const run = (rows: object[], deletedAt: Date | null, actor: string | null = "u9") => {
    tx.recurringInvoice.findMany.mockResolvedValue(rows);
    return resumeSchedulesOnRestore(tx, customer(deletedAt), actor, now);
  };

  it("selects only ACTIVE templates of THIS customer that are due (nextRunAt <= now: the cron's own rule)", async () => {
    await run([], at(24, 10));
    expect(tx.recurringInvoice.findMany.mock.calls[0][0].where).toEqual({
      customerId: "c1",
      isActive: true,
      nextRunAt: { lte: now },
    });
  });

  it("no templates: zero writes of any kind", async () => {
    expect(await run([], at(24, 10))).toBe(0);
    expect(tx.recurringInvoice.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("(i) an Undo within the same day: no tick fell inside the removal, so it is untouched and billed at the next tick", async () => {
    // due today 00:00 but NOT yet billed; removed today 09:00, restored 09:05
    const advanced = await run([row("w", at(25, 0, 0))], at(25, 9, 0));
    expect(advanced).toBe(0);
    expect(tx.recurringInvoice.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("(ii) a removal across ONE midnight: advanced once, with the skipped cycle and the actor in the audit", async () => {
    const due = at(23, 0, 0); // due two days ago, billed nothing since the removal
    const advanced = await run([row("w", due)], at(24, 10, 0)); // removed yesterday 10:00; today 00:00 tick passed
    expect(advanced).toBe(1);
    const u = tx.recurringInvoice.updateMany.mock.calls[0][0];
    expect(u.where).toEqual({ id: "w", isActive: true, nextRunAt: due });
    expect(u.data.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(u.data.nextRunAt).toEqual(calcNextRunAt("WEEKLY" as never, 1, 1, now));
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      userId: "u9",
      action: "recurring-invoice.reactivated",
      entityId: "w",
      meta: {
        reason: "CUSTOMER_RESTORED",
        skippedCycleDueAt: due.toISOString(),
        resumedAt: calcNextRunAt("WEEKLY" as never, 1, 1, now).toISOString(),
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("a template weeks overdue after a LONG removal resumes at the first occurrence strictly after NOW, never a past date (no make-up invoice)", async () => {
    // due Mon Aug 31 (3+ weekly cycles before `now`, Fri Sep 25), removed Aug 20 and restored now
    const old = new Date(2026, 7, 31);
    expect(await run([row("w", old)], new Date(2026, 7, 20, 10, 0, 0))).toBe(1);
    const next = tx.recurringInvoice.updateMany.mock.calls[0][0].data.nextRunAt as Date;
    expect(next).toEqual(new Date(2026, 8, 28)); // the Monday after now, not Sep 7 / 14 / 21 (all in the past)
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(tx.auditLog.create.mock.calls[0][0].data.meta.resumedAt).toBe(next.toISOString());
  });

  it("an Undo STRADDLING midnight: removed 23:50, restored 00:10 the next day, the 00:00 tick fell inside, so it is advanced", async () => {
    const restoredAt = at(25, 0, 10);
    tx.recurringInvoice.findMany.mockResolvedValue([row("w", at(24, 0, 0))]);
    expect(await resumeSchedulesOnRestore(tx, customer(at(24, 23, 50)), "u9", restoredAt)).toBe(1);
    expect(tx.recurringInvoice.updateMany.mock.calls[0][0].data.nextRunAt).toEqual(
      calcNextRunAt("WEEKLY" as never, 1, 1, restoredAt),
    );
  });

  it("a removal EXACTLY on a tick (deletedAt = 00:00): that tick counts as inside the removal (inclusive), so it is advanced", async () => {
    expect(await run([row("w", at(24, 0, 0))], at(25, 0, 0))).toBe(1);
  });

  it("(iii) a failed-retry row (due BEFORE the removal): advanced iff a tick fell inside the window", async () => {
    const retry = row("r", at(24, 0, 0), { lastRunStatus: "FAILED" }); // failed yesterday, given back for retry
    // removed yesterday 10:00, restored today 09:05: the 00:00 tick passed inside the window -> advanced
    expect(await run([retry], at(24, 10, 0))).toBe(1);
    tx.recurringInvoice.updateMany.mockClear();
    tx.auditLog.create.mockClear();
    // removed today 09:00, restored 09:05: no tick inside -> untouched, the cron retries it tonight
    expect(await run([retry], at(25, 9, 0))).toBe(0);
    expect(tx.recurringInvoice.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a lost race (the row changed since we read it) is a no-op: no advance, no audit", async () => {
    tx.recurringInvoice.updateMany.mockResolvedValue({ count: 0 });
    expect(await run([row("w", at(23, 0, 0))], at(24, 10, 0))).toBe(0);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("structure: the restore hand-off and the cron's own schedule", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
  const calls = (root: ts.Node, sf: ts.SourceFile, suffix: string) => {
    const found: ts.CallExpression[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText(sf).endsWith(suffix)) found.push(n);
      ts.forEachChild(n, walk);
    };
    walk(root);
    return found;
  };

  it("restoreCustomer calls resumeSchedulesOnRestore INSIDE the arrow passed as tenantTransaction's first argument, passing THAT arrow's tx", () => {
    const sf = parse("customers/customers.service.ts");
    let method: ts.MethodDeclaration | undefined;
    const find = (n: ts.Node) => {
      if (ts.isMethodDeclaration(n) && n.name.getText(sf) === "restoreCustomer") method = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    const txCalls = calls(method!.body!, sf, "tenantTransaction");
    expect(txCalls).toHaveLength(1);
    const arrow = txCalls[0].arguments[0];
    expect(ts.isArrowFunction(arrow) || ts.isFunctionExpression(arrow)).toBe(true);
    const fn = arrow as ts.ArrowFunction;
    const txName = fn.parameters[0].name.getText(sf);
    const inside = calls(fn.body, sf, "resumeSchedulesOnRestore");
    expect(inside).toHaveLength(1);
    expect(inside[0].arguments[0].getText(sf)).toBe(txName); // the SAME tx the un-delete ran in
    // and it is the ONLY call anywhere in the method (never one after the transaction)
    expect(calls(method!.body!, sf, "resumeSchedulesOnRestore")).toHaveLength(1);
  });

  it("the cron and the restore share ONE schedule definition: the same CronExpression member, never a re-typed expression", () => {
    const svc = read("recurring-invoices/recurring-invoices.service.ts");
    expect(svc).toMatch(
      /@LeaderCron\(\s*CronExpression\.EVERY_DAY_AT_MIDNIGHT,\s*"recurring-invoices\.generateDueRecurringInvoices"/,
    );
    const sched = read("recurring-invoices/recurring-schedule.ts");
    expect(sched).toMatch(/RECURRING_INVOICES_CRON = CronExpression\.EVERY_DAY_AT_MIDNIGHT;/);
    expect(sched).toMatch(/new CronTime\(RECURRING_INVOICES_CRON\)/);
    expect(RECURRING_INVOICES_CRON).toBe("0 0 * * *");
  });
});

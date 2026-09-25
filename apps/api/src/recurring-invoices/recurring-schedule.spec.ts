import { calcNextRunAt, resumeSchedulesOnRestore } from "./recurring-schedule";

/**
 * F-05 (SA-290, SA-268): a customer RESTORE is a pause ending. Its ACTIVE templates whose nextRunAt has passed are
 * advanced to the next occurrence after now, in the restore's own tx, with a CUSTOMER_RESTORED audit naming the
 * skipped cycle; the missed cycle is never a make-up (only an explicit Run now).
 */
describe("resumeSchedulesOnRestore", () => {
  const now = new Date("2026-09-25T12:00:00");
  const day = 24 * 3600 * 1000;
  const row = (id: string, frequency: string, nextRunAt: Date, extra: object = {}) => ({
    id,
    frequency,
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
  const run = (rows: object[]) => {
    tx.recurringInvoice.findMany.mockResolvedValue(rows);
    return resumeSchedulesOnRestore(tx, { customerId: "c1", tenantId: "t1", now });
  };

  it("selects only ACTIVE templates of THIS customer whose nextRunAt has passed (a future date is untouched)", async () => {
    await run([]);
    expect(tx.recurringInvoice.findMany.mock.calls[0][0].where).toEqual({
      customerId: "c1",
      isActive: true,
      nextRunAt: { lte: now },
    });
  });

  it("advances each past-due template per its own frequency to a date strictly after now, and audits the skipped cycle", async () => {
    const weeklyDue = new Date(now.getTime() - 3 * day);
    const monthlyDue = new Date(now.getTime() - 20 * day);
    const advanced = await run([row("w", "WEEKLY", weeklyDue), row("m", "MONTHLY", monthlyDue)]);
    expect(advanced).toBe(2);
    const updates = tx.recurringInvoice.updateMany.mock.calls.map((c: any) => c[0]);
    expect(updates[0].where).toEqual({ id: "w", isActive: true, nextRunAt: weeklyDue });
    for (const u of updates) expect(u.data.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(updates[0].data.nextRunAt).toEqual(calcNextRunAt("WEEKLY" as never, 1, 1, now));
    expect(updates[1].data.nextRunAt).toEqual(calcNextRunAt("MONTHLY" as never, 1, 1, now));
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "recurring-invoice.reactivated",
      entityId: "w",
      meta: { reason: "CUSTOMER_RESTORED", skippedCycleDueAt: weeklyDue.toISOString() },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it("a lost race (the row changed since we read it) is a no-op: no advance, no audit", async () => {
    tx.recurringInvoice.updateMany.mockResolvedValue({ count: 0 });
    const advanced = await run([row("w", "WEEKLY", new Date(now.getTime() - day))]);
    expect(advanced).toBe(0);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("remove past a due date, restore: the missed cycle is skipped and the NEXT cycle is the only one that can bill", async () => {
    const missed = new Date(now.getTime() - 3 * day);
    await run([row("w", "WEEKLY", missed)]);
    const resumed = tx.recurringInvoice.updateMany.mock.calls[0][0].data.nextRunAt as Date;
    expect(resumed.getTime()).toBeGreaterThan(now.getTime()); // the cron (nextRunAt <= now) does not select it tonight
    expect(resumed.getTime()).toBeGreaterThan(missed.getTime());
    // the next occurrence is exactly the schedule's own next date, one cycle, not a backlog
    expect(resumed).toEqual(calcNextRunAt("WEEKLY" as never, 1, 1, now));
  });
});

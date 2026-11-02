import { Logger } from "@nestjs/common";
import { DemoBookingRetentionService } from "./demo-booking-retention.service";
import { RETENTION_MAX_ROWS_PER_RUN } from "./retention-run";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const CUTOFF = new Date("2025-11-02T12:00:00.000Z");

function make(opts: {
  mode?: "report" | "enforce";
  pages?: { id: string; googleEventId: string | null }[][];
  findMany?: jest.Mock;
  deleteEvent?: jest.Mock;
  audit?: jest.Mock;
}) {
  const queue = [...(opts.pages ?? [])];
  const findMany = opts.findMany ?? jest.fn(async () => queue.shift() ?? []);
  const deleteMany = jest.fn(async (a: any) => ({ count: a.where.id.in.length }));
  const count = jest.fn(async () => 0);
  const audit = opts.audit ?? jest.fn(async () => ({}));
  const deleteEvent = opts.deleteEvent ?? jest.fn(async () => undefined);
  const prisma = {
    demoBooking: { count, findMany, deleteMany },
    auditLog: { create: audit },
  } as any;
  const switches = { modeOf: jest.fn(async () => opts.mode ?? "enforce") } as any;
  const job = new DemoBookingRetentionService(prisma, switches, { deleteEvent } as any);
  return { job, count, findMany, deleteMany, deleteEvent, audit };
}

describe("SA-1083: DemoBookingRetentionService", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("the cutoff is 12 calendar months, on the booked time", async () => {
    const { job, count } = make({ mode: "report" });
    const out = await job.run(NOW);
    expect(out.cutoff).toEqual(CUTOFF);
    expect(count.mock.calls[0][0].where.startsAt).toEqual({ lt: CUTOFF });
  });

  it("report-only never selects, never calls the calendar, never deletes", async () => {
    const { job, findMany, deleteMany, deleteEvent } = make({ mode: "report" });
    const out = await job.run(NOW);
    expect(out).toMatchObject({ mode: "report", deleted: 0 });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("a failed event keeps only its own row, and the walk moves past it", async () => {
    const deleteEvent = jest
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(undefined);
    const { job, findMany, deleteMany } = make({
      deleteEvent,
      pages: [
        [
          { id: "a", googleEventId: "ev-a" },
          { id: "b", googleEventId: "ev-b" },
          { id: "c", googleEventId: null },
        ],
      ],
    });
    const out = await job.run(NOW);
    expect(deleteMany.mock.calls[0][0].where.id).toEqual({ in: ["b", "c"] });
    expect(findMany.mock.calls[1][0].where.id).toEqual({ gt: "c" });
    expect(out).toMatchObject({ deleted: 2, calendarFailed: 1 });
  });

  it("the delete repeats the removable test, so a booking that gained a tenant stays", async () => {
    const { job, deleteMany } = make({ pages: [[{ id: "a", googleEventId: null }]] });
    await job.run(NOW);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.startsAt).toEqual({ lt: CUTOFF });
    expect(where.OR).toEqual([
      { onboardingCase: { is: null } },
      { onboardingCase: { is: { tenantId: null } } },
    ]);
  });

  it("a page where every event failed deletes nothing and still ends", async () => {
    const deleteEvent = jest.fn().mockRejectedValue(new Error("down"));
    const { job, deleteMany, findMany } = make({
      deleteEvent,
      pages: [[{ id: "a", googleEventId: "ev-a" }]],
    });
    const out = await job.run(NOW);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ deleted: 0, calendarFailed: 1, capped: false });
  });

  it("one run stops at the cap and says so", async () => {
    let n = 0;
    const findMany = jest.fn(async (a: any) =>
      Array.from({ length: a.take }, () => ({ id: `b${++n}`, googleEventId: null })),
    );
    const { job } = make({ findMany });
    const out = await job.run(NOW);
    expect(out.deleted).toBe(RETENTION_MAX_ROWS_PER_RUN);
    expect(out.capped).toBe(true);
  });

  it("the audit row holds counts only, and a failed write doesn't fail the run", async () => {
    const audit = jest.fn().mockRejectedValueOnce(new Error("down"));
    const { job } = make({ audit, mode: "report" });
    await expect(job.run(NOW)).resolves.toMatchObject({ mode: "report" });
    expect(audit.mock.calls[0][0].data).toEqual({
      action: "retention.demo-bookings.run",
      entityType: "RetentionRun",
      meta: {
        mode: "report",
        cutoff: CUTOFF.toISOString(),
        due: 0,
        dueWithEvent: 0,
        deleted: 0,
        keptWithTenant: 0,
        calendarFailed: 0,
        capped: false,
      },
    });
  });
});

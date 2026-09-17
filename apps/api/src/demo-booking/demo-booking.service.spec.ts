/**
 * `create`/`reschedule` now serialise their check-then-write window through
 * `withAdvisoryLock` (`common/db-locks.ts`, review finding 4) — the same
 * primitive `addon.service.ts`'s B342 fix uses. This mock is the identical
 * per-key FIFO mutex `addon.service.spec.ts` uses: a second call for the SAME
 * lock key does not start its callback until the first call's callback has
 * fully settled, the same observable effect the real Postgres advisory lock
 * gives across replicas. For every non-concurrent test this is a transparent
 * pass-through; only the dedicated race test below relies on the actual
 * serialisation. The real cross-connection behaviour is proved separately in
 * demo-booking.db.spec.ts against a live Postgres.
 */
const lockQueues = new Map<string, Promise<unknown>>();
const mockWithAdvisoryLock = jest.fn(async (opts: { key: string }, fn: () => Promise<unknown>) => {
  const prior = lockQueues.get(opts.key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((res) => {
    release = res;
  });
  lockQueues.set(
    opts.key,
    prior.then(() => done),
  );
  await prior;
  try {
    const value = await fn();
    return { acquired: true as const, value };
  } finally {
    release();
  }
});

class MockLockTimeoutError extends Error {
  constructor(
    public readonly family: string,
    public readonly key: string,
    public readonly waitMs: number,
  ) {
    super(`lock timeout: ${family}/${key} after ${waitMs}ms`);
    this.name = "LockTimeoutError";
  }
}

class MockLockUnavailableError extends Error {
  constructor(public readonly cause?: unknown) {
    super("lock unavailable");
    this.name = "LockUnavailableError";
  }
}

jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, DemoBookingStatus } from "@prisma/client";
import { DemoBookingService } from "./demo-booking.service";
import { DemoBookingConfig, loadDemoBookingConfig } from "./demo-booking.config";
import { BusyBlock } from "./google-calendar.service";

/**
 * Availability is the dangerous half of this feature: every slot it publishes
 * is a promise someone's calendar is free. The cases below pin the two failure
 * modes that matter — offering a slot that is actually busy, and offering slots
 * at all when the calendar could not be read.
 */

const BASE_CONFIG: DemoBookingConfig = {
  ...loadDemoBookingConfig({} as NodeJS.ProcessEnv),
  saEmail: "sa@routeflow-506615.iam.gserviceaccount.com",
  saPrivateKey: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----",
  impersonate: "admin@routeflow.info",
  calendarId: "primary",
  tokenSecret: "test-secret-that-is-long-enough",
  businessTimeZone: "America/Chicago",
};

// A Thursday, 08:00 Chicago — before the 09:00 open, so the whole day is ahead.
const NOW = new Date("2026-10-15T13:00:00.000Z");

class TestCalendar {
  busy: BusyBlock[] | null = [];
  created: unknown[] = [];
  deleted: string[] = [];
  updated: Array<{ id: string; input: unknown }> = [];

  isConfigured() {
    return true;
  }
  async getBusy() {
    return this.busy;
  }
  async createEvent(input: unknown) {
    this.created.push(input);
    return { id: "evt-1", meetUrl: "https://meet.google.com/abc-defg-hij", htmlLink: null };
  }
  async updateEvent(id: string, input: unknown) {
    this.updated.push({ id, input });
    return { id, meetUrl: "https://meet.google.com/abc-defg-hij", htmlLink: null };
  }
  async deleteEvent(id: string) {
    this.deleted.push(id);
  }
}

type Row = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: DemoBookingStatus;
  manageTokenHash: string;
  [key: string]: unknown;
};

class TestPrisma {
  rows: Row[] = [];
  demoBooking = {
    findMany: async ({ where }: any) =>
      this.rows.filter(
        (row) =>
          row.status === where.status &&
          row.startsAt < where.startsAt.lt &&
          row.endsAt > where.endsAt.gt,
      ),
    findFirst: async ({ where }: any) =>
      this.rows.find(
        (row) =>
          row.status === where.status &&
          row.startsAt < where.startsAt.lt &&
          row.endsAt > where.endsAt.gt &&
          (!where.id?.not || row.id !== where.id.not),
      ) ?? null,
    findUnique: async ({ where }: any) =>
      this.rows.find((row) => row.manageTokenHash === where.manageTokenHash) ?? null,
    create: async ({ data }: any) => {
      // Mirrors the partial unique index (migration 20260916031500): a
      // CONFIRMED row already at this startsAt makes the DB itself refuse the
      // insert, regardless of what the in-process lock or the prior
      // assertSlotStillFree check believed.
      if (
        this.rows.some(
          (row) =>
            row.status === DemoBookingStatus.CONFIRMED &&
            row.startsAt.getTime() === (data.startsAt as Date).getTime(),
        )
      ) {
        throw fakeP2002();
      }
      // Mirror the column defaults in platform.prisma — without them this fake
      // would hide exactly the fields the service reads back after a create.
      const row: Row = {
        id: `row-${this.rows.length + 1}`,
        status: DemoBookingStatus.CONFIRMED,
        cancelledAt: null,
        cancelReason: null,
        googleEventId: null,
        meetUrl: null,
        rescheduledFrom: null,
        rescheduleCount: 0,
        ...data,
      };
      this.rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      if (
        "startsAt" in data &&
        this.rows.some(
          (row) =>
            row.id !== where.id &&
            row.status === DemoBookingStatus.CONFIRMED &&
            row.startsAt.getTime() === (data.startsAt as Date).getTime(),
        )
      ) {
        throw fakeP2002();
      }
      const row = this.rows.find((candidate) => candidate.id === where.id)!;
      for (const [key, value] of Object.entries(data)) {
        row[key] =
          value && typeof value === "object" && "increment" in (value as object)
            ? ((row[key] as number) ?? 0) + (value as { increment: number }).increment
            : value;
      }
      return row;
    },
  };
}

/** A minimal stand-in for the shape `demo-booking.service.ts`'s P2002 catch checks. */
function fakeP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

class TestEmail {
  sent: Array<{ to: string; subject: string; html: string }> = [];
  async send(params: { to: string; subject: string; html: string }) {
    this.sent.push(params);
    return { delivered: true, transport: "resend" as const };
  }
}

/** Exposes the protected seams so tests control the clock and the env. */
class Subject extends DemoBookingService {
  nowOverride: Date | null = null;
  constructor(
    prisma: TestPrisma,
    calendar: TestCalendar,
    email: TestEmail,
    private readonly overrides: Partial<DemoBookingConfig> = {},
  ) {
    super(prisma as never, calendar as never, email as never);
  }
  protected config(): DemoBookingConfig {
    return { ...BASE_CONFIG, ...this.overrides };
  }
  protected now(): Date {
    return this.nowOverride ?? NOW;
  }
}

function build(overrides: Partial<DemoBookingConfig> = {}) {
  const prisma = new TestPrisma();
  const calendar = new TestCalendar();
  const email = new TestEmail();
  return { prisma, calendar, email, service: new Subject(prisma, calendar, email, overrides) };
}

// 09:00 Chicago on Fri 2026-10-16 = 14:00Z (CDT, UTC-5).
const FRIDAY_9AM = "2026-10-16T14:00:00.000Z";
const WINDOW = { from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z" };

describe("DemoBookingService.getAvailability", () => {
  it("generates the business-hours grid in the visitor's zone", async () => {
    const { service } = build();
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/New_York");

    expect(result.status).toBe("ok");
    expect(result.timeZone).toBe("America/New_York");
    expect(result.durationMinutes).toBe(30);
    const friday = result.days.find((day) => day.date === "2026-10-16");
    expect(friday).toBeDefined();
    // 09:00–17:00 Chicago at 30-minute steps = 16 slots.
    expect(friday!.slots).toHaveLength(16);
    expect(friday!.slots[0].startsAt).toBe(FRIDAY_9AM);
  });

  it("removes a slot Google reports busy", async () => {
    const { calendar, service } = build();
    calendar.busy = [{ start: new Date(FRIDAY_9AM), end: new Date("2026-10-16T15:00:00.000Z") }];
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    const starts = result.days.flatMap((day) => day.slots.map((slot) => slot.startsAt));

    expect(starts).not.toContain(FRIDAY_9AM);
    expect(starts).not.toContain("2026-10-16T14:30:00.000Z");
    expect(starts).toContain("2026-10-16T15:00:00.000Z");
  });

  it("removes a slot already held by another RouteFlow booking", async () => {
    const { prisma, service } = build();
    prisma.rows.push({
      id: "existing",
      startsAt: new Date(FRIDAY_9AM),
      endsAt: new Date("2026-10-16T14:30:00.000Z"),
      status: DemoBookingStatus.CONFIRMED,
      manageTokenHash: "hash",
    });
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    const starts = result.days.flatMap((day) => day.slots.map((slot) => slot.startsAt));

    expect(starts).not.toContain(FRIDAY_9AM);
  });

  // B500: "the calendar is unreachable" is an outage, not "fully booked" —
  // the client must be able to tell them apart.
  it("offers nothing when the calendar cannot be read — never guesses free, and reports unavailable (B500)", async () => {
    const { calendar, service } = build();
    calendar.busy = null;
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    expect(result.days).toEqual([]);
    expect(result.status).toBe("unavailable");
  });

  it("offers nothing when Google credentials are absent, and reports unavailable (B500)", async () => {
    const { service } = build({ saEmail: "", saPrivateKey: "" });
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    expect(result.days).toEqual([]);
    expect(result.status).toBe("unavailable");
  });

  // Review round-2 finding C: an interval shorter than the duration lets the
  // grid offer two different, overlapping slots — go dark the same way as
  // "not configured" rather than publish an unsafe grid.
  it("REG-review-round2-C: offers nothing when the slot interval is shorter than the duration, and reports unavailable", async () => {
    const { service } = build({ slotIntervalMinutes: 15, durationMinutes: 30 });
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    expect(result.days).toEqual([]);
    expect(result.status).toBe("unavailable");
  });

  // These are the "ok" side of B500: the service is working, there is just
  // nothing bookable in this particular window — never "unavailable".
  it("honours the minimum-notice window, reporting ok with an empty grid", async () => {
    // NOW is 08:00 Chicago Thursday; 12h notice rules out the rest of Thursday.
    const { service } = build({ minNoticeHours: 12 });
    const result = await service.getAvailability(
      "2026-10-15T00:00:00.000Z",
      "2026-10-16T00:00:00.000Z",
      "America/Chicago",
    );
    expect(result.days).toEqual([]);
    expect(result.status).toBe("ok");
  });

  it("skips weekends, reporting ok with an empty grid", async () => {
    const { service } = build();
    const result = await service.getAvailability(
      "2026-10-17T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
      "America/Chicago",
    );
    expect(result.days).toEqual([]);
    expect(result.status).toBe("ok");
  });

  it("reports ok with an empty grid when the requested range collapses to nothing", async () => {
    const { service } = build();
    // `to` before `from` clamps windowEnd <= windowStart — an empty request,
    // not a service problem.
    const result = await service.getAvailability(
      "2026-10-16T00:00:00.000Z",
      "2026-10-15T00:00:00.000Z",
      "America/Chicago",
    );
    expect(result.days).toEqual([]);
    expect(result.status).toBe("ok");
  });

  it("logs the not-configured state at warn level once per throttle window, not once per request (B500)", async () => {
    const { service } = build({ saEmail: "", saPrivateKey: "" });
    const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    expect(warn).toHaveBeenCalledTimes(1);

    // Past the throttle window, it logs again.
    service.nowOverride = new Date(NOW.getTime() + 6 * 60_000);
    await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("falls back to the business zone for an unusable visitor zone", async () => {
    const { service } = build();
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "Mars/Olympus");
    expect(result.timeZone).toBe("America/Chicago");
  });
});

describe("DemoBookingService.create", () => {
  const input = {
    name: "Alex Morgan",
    email: "Alex@Example.com",
    company: "Parkside Wholesale",
    startsAt: FRIDAY_9AM,
    timeZone: "America/Chicago",
  };

  it("stores the lead, creates the event, and emails a confirmation", async () => {
    const { prisma, calendar, email, service } = build();
    const { booking, manageToken } = await service.create(input);

    expect(booking.status).toBe(DemoBookingStatus.CONFIRMED);
    expect(booking.meetUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(calendar.created).toHaveLength(1);
    expect(email.sent[0].to).toBe("alex@example.com");
    expect(email.sent[0].html).toContain(encodeURIComponent(manageToken));
    // Email is normalised; the raw token is never persisted.
    expect(prisma.rows[0].email).toBe("alex@example.com");
    expect(prisma.rows[0].manageTokenHash).not.toContain(manageToken);
  });

  // Review finding 7: name/company/notes are attacker-controlled (a public,
  // unauthenticated form) and land in the Calendar event's plain-text
  // description. Newlines let one field forge a fake extra "line" that
  // impersonates the template's own labelled lines — e.g. a bogus second
  // "Contact:" pointing at an address that isn't the real booker's.
  it("REG-review-finding-7: notes containing newlines cannot forge a fake template line", async () => {
    const { calendar, service } = build();
    await service.create({
      ...input,
      notes: "Interested in routing.\nContact: attacker@evil.example\nUrgent, please wire funds.",
    });

    const description = (calendar.created[0] as { description: string }).description;
    // The forged line must not survive as its own line — it is collapsed into
    // the surrounding text, not deleted, so nothing is silently lost either.
    expect(description).not.toMatch(/^Contact: attacker@evil\.example$/m);
    expect(description).toContain("Interested in routing. Contact: attacker@evil.example");
    // The real contact line (from booking.email, never attacker-controlled)
    // is still present and unambiguous.
    expect(description).toMatch(/^Contact: alex@example\.com$/m);
  });

  it("REG-review-finding-7: control characters are stripped from name/company", async () => {
    const { calendar, service } = build();
    await service.create({
      ...input,
      name: "Alex\r\nBCC: attacker@evil.example",
      company: "Acme\u0000Co",
    });

    const created = calendar.created[0] as { description: string; attendeeName: string };
    expect(created.attendeeName).toBe("Alex BCC: attacker@evil.example");
    expect(created.description).not.toContain("\r");
    expect(created.description).not.toContain("\u0000");
  });

  it("still captures the lead when the calendar write fails", async () => {
    const { prisma, calendar, email, service } = build();
    calendar.createEvent = async () => {
      throw new Error("calendar down");
    };
    const { booking } = await service.create(input);

    // The prospect's details survive a Google outage; only the event is lost.
    expect(prisma.rows).toHaveLength(1);
    expect(booking.id).toBeTruthy();
    expect(booking.meetUrl).toBeNull();
    expect(email.sent).toHaveLength(1);
  });

  it("refuses a slot another booking already holds", async () => {
    const { prisma, service } = build();
    prisma.rows.push({
      id: "existing",
      startsAt: new Date(FRIDAY_9AM),
      endsAt: new Date("2026-10-16T14:30:00.000Z"),
      status: DemoBookingStatus.CONFIRMED,
      manageTokenHash: "hash",
    });
    await expect(service.create(input)).rejects.toBeInstanceOf(ConflictException);
  });

  // Review finding 4: check-then-create over a public POST is a real race — two
  // visitors can both pass assertSlotStillFree for the SAME slot before either
  // has written a row. `create` now serialises the check+write through a
  // `demo-booking` advisory lock keyed on the slot's start instant (mocked
  // above as a real per-key FIFO mutex, not a stub — the second call's
  // callback genuinely does not start until the first's has settled).
  it("REG-review-finding-4: two concurrent bookings for the same slot — exactly one succeeds", async () => {
    const { service } = build();

    const results = await Promise.allSettled([service.create(input), service.create(input)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });

  it("REG-review-finding-4: the DB-level partial-index guard (P2002) is caught and mapped to a clean 409", async () => {
    // Bypasses the in-process check entirely — this proves the SECOND, DB-level
    // line of defence on its own, independent of the lock/assertSlotStillFree.
    const { prisma, service } = build();
    const originalFindFirst = prisma.demoBooking.findFirst;
    prisma.demoBooking.findFirst = async () => null; // in-process check sees it as free
    prisma.rows.push({
      id: "existing",
      startsAt: new Date(FRIDAY_9AM),
      endsAt: new Date("2026-10-16T14:30:00.000Z"),
      status: DemoBookingStatus.CONFIRMED,
      manageTokenHash: "hash",
    });

    await expect(service.create(input)).rejects.toBeInstanceOf(ConflictException);
    prisma.demoBooking.findFirst = originalFindFirst;
  });

  it("REG-review-finding-4: locks reschedule on the TARGET slot, so it serialises against a concurrent create for that slot", async () => {
    const { service } = build();
    const existing = await service.create({ ...input, startsAt: "2026-10-16T15:00:00.000Z" });

    const results = await Promise.allSettled([
      service.create(input), // targets FRIDAY_9AM
      service.reschedule(existing.manageToken, FRIDAY_9AM), // also targets FRIDAY_9AM
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("refuses a slot that went busy on the calendar since availability was read", async () => {
    const { calendar, service } = build();
    calendar.busy = [{ start: new Date(FRIDAY_9AM), end: new Date("2026-10-16T14:30:00.000Z") }];
    await expect(service.create(input)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses when the calendar cannot be reached rather than double-booking", async () => {
    const { calendar, service } = build();
    calendar.busy = null;
    await expect(service.create(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("refuses a time outside business hours", async () => {
    const { service } = build();
    await expect(
      service.create({ ...input, startsAt: "2026-10-16T05:00:00.000Z" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a time that is not on the published slot grid", async () => {
    const { service } = build();
    await expect(
      service.create({ ...input, startsAt: "2026-10-16T14:07:00.000Z" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // B500: confirms the missing-DEMO_BOOKING_TOKEN_SECRET 503 already carries a
  // readable, visitor-facing message rather than a raw error — not a
  // NestJS-internal string, and no config detail (which env var, etc.) leaked.
  it("refuses booking when the feature is unconfigured, with a readable message (B500)", async () => {
    const { service } = build({ tokenSecret: "" });
    await expect(service.create(input)).rejects.toThrow(
      new ServiceUnavailableException(
        "Demo booking is not available right now. Please email us and we will arrange a time.",
      ),
    );
  });

  it("REG-review-round2-C: refuses booking when the slot interval is shorter than the duration", async () => {
    const { service } = build({ slotIntervalMinutes: 15, durationMinutes: 30 });
    await expect(service.create(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("DemoBookingService manage-token lifecycle", () => {
  const input = {
    name: "Alex Morgan",
    email: "alex@example.com",
    company: "Parkside Wholesale",
    startsAt: FRIDAY_9AM,
    timeZone: "America/Chicago",
  };

  it("reads a booking back by its token", async () => {
    const { service } = build();
    const { manageToken, booking } = await service.create(input);
    await expect(service.getByToken(manageToken)).resolves.toMatchObject({ id: booking.id });
  });

  it("rejects a forged token without touching the database", async () => {
    const { prisma, service } = build();
    await service.create(input);
    const findUnique = jest.spyOn(prisma.demoBooking, "findUnique");
    await expect(service.getByToken("abcdefghijklmnop.forged")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findUnique).not.toHaveBeenCalled();
  });

  // Review finding 8: a manage token has no other expiry, so without this it
  // would grant cancel/reschedule access to a slot forever.
  it("REG-review-finding-8: a manage token still works 6 days after the slot ended", async () => {
    const { service } = build();
    const { manageToken } = await service.create(input);
    (service as Subject).nowOverride = new Date(new Date(FRIDAY_9AM).getTime() + 6 * 86_400_000);
    await expect(service.getByToken(manageToken)).resolves.toMatchObject({ status: "CONFIRMED" });
  });

  it("REG-review-finding-8: a manage token stops working 8 days after the slot ended", async () => {
    const { service } = build();
    const { manageToken } = await service.create(input);
    (service as Subject).nowOverride = new Date(new Date(FRIDAY_9AM).getTime() + 8 * 86_400_000);
    await expect(service.getByToken(manageToken)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("REG-review-finding-8: an expired token cannot cancel or reschedule either", async () => {
    const { service } = build();
    const { manageToken } = await service.create(input);
    (service as Subject).nowOverride = new Date(new Date(FRIDAY_9AM).getTime() + 8 * 86_400_000);
    await expect(service.cancel(manageToken)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.reschedule(manageToken, "2026-10-16T15:00:00.000Z"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cancels the booking and removes the calendar event", async () => {
    const { calendar, email, service } = build();
    const { manageToken } = await service.create(input);
    const cancelled = await service.cancel(manageToken, "Changed our plans");

    expect(cancelled.status).toBe(DemoBookingStatus.CANCELLED);
    expect(calendar.deleted).toEqual(["evt-1"]);
    expect(email.sent).toHaveLength(2);
    expect(email.sent[1].subject).toContain("cancelled");
  });

  it("cancels the row even when the calendar delete fails", async () => {
    const { calendar, service } = build();
    const { manageToken } = await service.create(input);
    calendar.deleteEvent = async () => {
      throw new Error("calendar down");
    };
    await expect(service.cancel(manageToken)).resolves.toMatchObject({
      status: DemoBookingStatus.CANCELLED,
    });
  });

  it("is idempotent on a second cancel", async () => {
    const { service } = build();
    const { manageToken } = await service.create(input);
    await service.cancel(manageToken);
    await expect(service.cancel(manageToken)).resolves.toMatchObject({
      status: DemoBookingStatus.CANCELLED,
    });
  });

  it("moves the booking and patches the same event", async () => {
    const { calendar, service } = build();
    const { manageToken } = await service.create(input);
    const moved = await service.reschedule(manageToken, "2026-10-16T15:00:00.000Z");

    expect(moved.startsAt).toBe("2026-10-16T15:00:00.000Z");
    expect(calendar.updated).toHaveLength(1);
    expect(calendar.updated[0].id).toBe("evt-1");
  });

  it("refuses to reschedule a cancelled booking", async () => {
    const { service } = build();
    const { manageToken } = await service.create(input);
    await service.cancel(manageToken);
    await expect(
      service.reschedule(manageToken, "2026-10-16T15:00:00.000Z"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not let a reschedule collide with its own slot check", async () => {
    const { service } = build();
    const { manageToken } = await service.create(input);
    // Same slot — the booking must not conflict with itself.
    await expect(service.reschedule(manageToken, FRIDAY_9AM)).resolves.toMatchObject({
      startsAt: FRIDAY_9AM,
    });
  });
});

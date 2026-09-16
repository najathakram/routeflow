import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DemoBookingStatus } from "@prisma/client";
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

class TestEmail {
  sent: Array<{ to: string; subject: string; html: string }> = [];
  async send(params: { to: string; subject: string; html: string }) {
    this.sent.push(params);
    return { delivered: true, transport: "resend" as const };
  }
}

/** Exposes the protected seams so tests control the clock and the env. */
class Subject extends DemoBookingService {
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
    return NOW;
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

  it("offers nothing when the calendar cannot be read — never guesses free", async () => {
    const { calendar, service } = build();
    calendar.busy = null;
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    expect(result.days).toEqual([]);
  });

  it("offers nothing when Google credentials are absent", async () => {
    const { service } = build({ saEmail: "", saPrivateKey: "" });
    const result = await service.getAvailability(WINDOW.from, WINDOW.to, "America/Chicago");
    expect(result.days).toEqual([]);
  });

  it("honours the minimum-notice window", async () => {
    // NOW is 08:00 Chicago Thursday; 12h notice rules out the rest of Thursday.
    const { service } = build({ minNoticeHours: 12 });
    const result = await service.getAvailability(
      "2026-10-15T00:00:00.000Z",
      "2026-10-16T00:00:00.000Z",
      "America/Chicago",
    );
    expect(result.days).toEqual([]);
  });

  it("skips weekends", async () => {
    const { service } = build();
    const result = await service.getAvailability(
      "2026-10-17T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
      "America/Chicago",
    );
    expect(result.days).toEqual([]);
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

  it("refuses booking when the feature is unconfigured", async () => {
    const { service } = build({ tokenSecret: "" });
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

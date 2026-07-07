import { BadRequestException } from "@nestjs/common";
import { ProrationService } from "./proration.service";

function catalog() {
  return {
    definitions: [
      { planKey: "STARTER", name: "Starter", monthlyPrice: 59, annualPrice: 590, isCustom: false },
      { planKey: "TEAM", name: "Team", monthlyPrice: 149, annualPrice: 1490, isCustom: false },
      {
        planKey: "BUSINESS",
        name: "Business",
        monthlyPrice: 349,
        annualPrice: 3490,
        isCustom: false,
      },
      {
        planKey: "ENTERPRISE",
        name: "Enterprise",
        monthlyPrice: null,
        annualPrice: null,
        isCustom: true,
      },
    ],
    addonSkus: [
      { sku: "SEAT_EXTRA", name: "Extra seat", monthlyPrice: 12, includedAtPlan: null },
      { sku: "BUYER_PORTAL", name: "Buyer portal", monthlyPrice: 49, includedAtPlan: "BUSINESS" },
      { sku: "OCR_PACK_250", name: "OCR pack", monthlyPrice: 19, includedAtPlan: null },
    ],
  };
}

function makeService(sub?: { cycle?: string; periodStart: Date; periodEnd: Date } | null) {
  const prisma = {
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(sub ?? null) },
  } as any;
  const cat = { getPublishedCatalog: jest.fn().mockResolvedValue(catalog()) } as any;
  return new ProrationService(prisma, cat);
}

const DAY = 24 * 60 * 60 * 1000;

describe("ProrationService.quote", () => {
  it("prices a monthly plan + non-included add-on", async () => {
    const q = await makeService().quote({
      planKey: "TEAM",
      cycle: "MONTHLY",
      addons: [{ sku: "SEAT_EXTRA", quantity: 2 }],
    });
    expect(q.lines).toEqual([
      expect.objectContaining({ type: "plan", key: "TEAM", monthly: 149, cyclePrice: 149 }),
      expect.objectContaining({
        type: "addon",
        key: "SEAT_EXTRA",
        quantity: 2,
        monthly: 24,
        cyclePrice: 24,
      }),
    ]);
    expect(q.subtotalMonthly).toBe(173);
    expect(q.dueToday).toBe(173);
    expect(q.annualSaving).toBe(0);
  });

  it("charges ×10 for annual and reports the 2-month saving", async () => {
    const q = await makeService().quote({ planKey: "TEAM", cycle: "ANNUAL" });
    expect(q.dueToday).toBe(1490); // 149 × 10
    expect(q.subtotalMonthly).toBe(149);
    expect(q.annualSaving).toBe(298); // 2 months
  });

  it("treats an add-on bundled at the plan as included (price 0)", async () => {
    const q = await makeService().quote({
      planKey: "BUSINESS",
      cycle: "MONTHLY",
      addons: [{ sku: "BUYER_PORTAL" }],
    });
    const portal = q.lines.find((l) => l.key === "BUYER_PORTAL");
    expect(portal).toMatchObject({ included: true, monthly: 0, cyclePrice: 0 });
    expect(q.dueToday).toBe(349); // portal free at Business
  });

  it("charges the à-la-carte add-on below its included plan", async () => {
    const q = await makeService().quote({
      planKey: "STARTER",
      cycle: "MONTHLY",
      addons: [{ sku: "BUYER_PORTAL" }],
    });
    expect(q.lines.find((l) => l.key === "BUYER_PORTAL")).toMatchObject({
      included: false,
      monthly: 49,
    });
    expect(q.dueToday).toBe(108); // 59 + 49
  });

  it("annual saving excludes included add-ons", async () => {
    const q = await makeService().quote({
      planKey: "BUSINESS",
      cycle: "ANNUAL",
      addons: [{ sku: "BUYER_PORTAL" }],
    });
    expect(q.annualSaving).toBe(698); // 2×349 only; portal is free, contributes 0
  });

  it("marks Enterprise as custom with nothing due today", async () => {
    const q = await makeService().quote({ planKey: "ENTERPRISE", cycle: "MONTHLY" });
    expect(q.isCustom).toBe(true);
    expect(q.dueToday).toBe(0);
  });

  it("rejects an unknown plan or add-on, and duplicate add-ons", async () => {
    const svc = makeService();
    await expect(svc.quote({ planKey: "NOPE", cycle: "MONTHLY" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.quote({ planKey: "TEAM", cycle: "MONTHLY", addons: [{ sku: "NOPE" }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.quote({
        planKey: "TEAM",
        cycle: "MONTHLY",
        addons: [{ sku: "SEAT_EXTRA" }, { sku: "SEAT_EXTRA" }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("ProrationService.prorationPreview", () => {
  it("wires the sku price + a sane prorated charge (calendar-month fallback)", async () => {
    const p = await makeService(null).prorationPreview("t1", "SEAT_EXTRA");
    expect(p.sku).toBe("SEAT_EXTRA");
    expect(p.monthly).toBe(12);
    expect(p.daysInCycle).toBeGreaterThanOrEqual(28);
    expect(p.daysInCycle).toBeLessThanOrEqual(31);
    expect(p.proratedToday).toBeGreaterThanOrEqual(0);
    expect(p.proratedToday).toBeLessThanOrEqual(12);
  });

  it("rejects an unknown sku", async () => {
    await expect(makeService(null).prorationPreview("t1", "NOPE")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("prorates an ANNUAL subscriber over a MONTHLY window (never the 365-day period)", async () => {
    // Regression: add-ons bill monthly; dividing $12/mo over 365 days ~12× undercharges.
    const svc = makeService({
      cycle: "ANNUAL",
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2027-07-01T00:00:00Z"),
    });
    const p = await svc.prorationPreview("t1", "SEAT_EXTRA");
    expect(p.daysInCycle).toBeLessThanOrEqual(31); // calendar month, not 365
    expect(p.proratedToday).toBeLessThanOrEqual(12); // a month's fraction, never < $1 for a fresh enable
  });

  it("uses the MONTHLY subscription period as the window", async () => {
    const now = new Date();
    const svc = makeService({
      cycle: "MONTHLY",
      periodStart: new Date(now.getTime() - 5 * DAY),
      periodEnd: new Date(now.getTime() + 25 * DAY),
    });
    const p = await svc.prorationPreview("t1", "SEAT_EXTRA");
    expect(p.daysInCycle).toBe(30); // the 30-day billing period, not the calendar month
    expect(p.proratedToday).toBeGreaterThan(0);
    expect(p.proratedToday).toBeLessThanOrEqual(12);
  });
});

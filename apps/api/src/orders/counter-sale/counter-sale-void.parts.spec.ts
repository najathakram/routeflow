import "reflect-metadata";
import { readFileSync } from "fs";
import { join } from "path";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ROLES_KEY } from "../../auth/decorators/roles.decorator";
import { voidWindowAllows, COUNTER_VOID_WINDOW } from "../../auth/permissions/staff-capabilities";
import { CounterSaleVoidController } from "./counter-sale-void.controller";
import { CounterSaleVoidDto, cleanVoidReason } from "./counter-sale-void.dto";
import { handBackOf } from "./counter-sale-void-handback";
import { tenantDayWindow } from "./counter-sale-void-window";

describe("the void reason (3-200 characters, trimmed, control characters stripped)", () => {
  const errorsFor = async (reason: unknown) =>
    (await validate(plainToInstance(CounterSaleVoidDto, { reason }))).length;
  const stored = (reason: string) => plainToInstance(CounterSaleVoidDto, { reason }).reason;

  it("cleanVoidReason strips C0/C1 controls and DEL, then trims; non-strings pass through to the validator", () => {
    expect(cleanVoidReason("  a\u0007b\nc\u007f\u009f  ")).toBe("abc");
    expect(cleanVoidReason(42)).toBe(42);
  });

  it.each([
    ["two characters", "ab", false],
    ["two characters padded", "  ab  ", false],
    ["only controls", "a\u0000\u001f\u007f", false],
    ["three characters", "abc", true],
    ["three characters padded", "  abc  ", true],
    ["200 characters", "x".repeat(200), true],
    ["201 characters", "x".repeat(201), false],
    ["200 after trimming", `  ${"x".repeat(200)}  `, true],
  ])("%s", async (_name, reason, ok) => {
    expect((await errorsFor(reason)) === 0).toBe(ok);
  });

  it("a missing or non-string reason is a validation error", async () => {
    expect(await errorsFor(undefined)).toBeGreaterThan(0);
    expect(await errorsFor(12345)).toBeGreaterThan(0);
  });

  it("the stored reason is the cleaned one", () => {
    expect(stored("  wrong\u0007 item\n")).toBe("wrong item");
  });
});

describe("handBackOf", () => {
  const row = (method: string, amount: unknown, status = "PAID") => ({ method, amount, status });
  it("sums the PAID tender per method in cents and names the card as CARD", () => {
    expect(
      handBackOf([
        row("CASH", "0.10"),
        row("CASH", "0.20"),
        row("CREDIT_CARD", 20),
        row("CHECK", 5.5),
      ]),
    ).toEqual({ CASH: 0.3, CARD: 20, CHECK: 5.5 });
  });
  it("leaves out a PENDING or VOID row, a non-counter method and a zero total", () => {
    expect(
      handBackOf([
        row("CHECK", 9, "PENDING"),
        row("CASH", 4, "VOID"),
        row("ACH", 3),
        row("CASH", 0),
      ]),
    ).toEqual({});
  });
});

describe("tenantDayWindow (the register's day, in the tenant zone)", () => {
  it("is [local midnight, next local midnight) as real instants", () => {
    const w = tenantDayWindow(new Date("2026-10-07T20:00:00.000Z"), "America/New_York");
    expect(w.start.toISOString()).toBe("2026-10-07T04:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-08T04:00:00.000Z");
  });
  it("is DST-safe (a 25-hour fall-back day) and falls back to UTC for no or an unknown zone", () => {
    const fall = tenantDayWindow(new Date("2026-11-01T12:00:00.000Z"), "America/Chicago");
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 3600_000);
    expect(tenantDayWindow(new Date("2026-10-07T20:00:00.000Z"), null).start.toISOString()).toBe(
      "2026-10-07T00:00:00.000Z",
    );
    expect(
      tenantDayWindow(new Date("2026-10-07T20:00:00.000Z"), "Not/AZone").start.toISOString(),
    ).toBe("2026-10-07T00:00:00.000Z");
  });
  it("feeds voidWindowAllows: 23:59 tenant-local on the day is inside, 00:00 the next day is out (not the UTC day)", () => {
    const now = new Date("2026-10-07T20:00:00.000Z");
    const nowTenantDay = tenantDayWindow(now, "America/New_York");
    const ctx = (saleCreatedAt: Date) => ({ saleCreatedAt, nowTenantDay, windowClosed: false });
    expect(voidWindowAllows(COUNTER_VOID_WINDOW, ctx(new Date("2026-10-08T03:59:00.000Z")))).toBe(
      true,
    );
    expect(voidWindowAllows(COUNTER_VOID_WINDOW, ctx(new Date("2026-10-08T04:00:00.000Z")))).toBe(
      false,
    );
    expect(voidWindowAllows(COUNTER_VOID_WINDOW, ctx(new Date("2026-10-07T03:59:00.000Z")))).toBe(
      false,
    );
  });
});

describe("POST /orders/counter-sale/:orderId/void (route shape)", () => {
  const handler = CounterSaleVoidController.prototype.voidSale;
  it("is a POST at counter-sale/:orderId/void under orders, OPERATOR only, answering 200", () => {
    expect(Reflect.getMetadata("path", CounterSaleVoidController)).toBe("orders");
    expect(Reflect.getMetadata("path", handler)).toBe("counter-sale/:orderId/void");
    expect(Reflect.getMetadata("method", handler)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata("__httpCode__", handler)).toBe(200);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(["OPERATOR"]);
  });
  it("is wired into the orders module (controller and service)", () => {
    const mod = readFileSync(join(__dirname, "..", "orders.module.ts"), "utf8");
    expect(mod).toMatch(/controllers:\s*\[[^\]]*CounterSaleVoidController/);
    expect(mod).toMatch(/providers:\s*\[[^\]]*CounterSaleVoidService/s);
  });
});

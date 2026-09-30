/**
 * #1965 (spec 10) — the single trigger registry. `NOTIFICATION_TRIGGERS` lists every
 * NotificationEvent that has a firing site; the notifications page hides/“Coming soon”s the rest,
 * so a switch can never render for an event nothing ever fires. This walks the tree (precedent:
 * `default-on-is-wired.spec.ts`, `common/no-bare-cron.spec.ts`) so a NEW firing site or a NEW
 * event that is not registered fails here instead of shipping a lying switch.
 */
import * as fs from "fs";
import * as path from "path";
import { NotificationEvent } from "@prisma/client";
import {
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_TRIGGERS,
  notificationAudience,
} from "./notification-triggers";

const SRC_ROOT = path.resolve(__dirname, "..");
const MESSAGING_DIR = path.resolve(__dirname);

function collect(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || full === MESSAGING_DIR) continue;
      collect(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}
const FILES = collect(SRC_ROOT);
const SOURCES = FILES.map((f) => fs.readFileSync(f, "utf8"));
const ALL_EVENTS = Object.values(NotificationEvent) as NotificationEvent[];

function firedOutsideMessaging(ev: string): boolean {
  return SOURCES.some((t) => t.includes(`NotificationEvent.${ev}`));
}

describe("scanner harness integrity (pin)", () => {
  it("walks a non-trivial tree and sees a known wired event and a known unwired one", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(firedOutsideMessaging("DELIVERED")).toBe(true);
    expect(firedOutsideMessaging("LOW_STOCK")).toBe(false);
  });
});

describe("NOTIFICATION_TRIGGERS (#1965)", () => {
  it("REG-1965 T1: equals the set of events with a firing site outside messaging/", () => {
    const wired = ALL_EVENTS.filter(firedOutsideMessaging).sort();
    expect([...NOTIFICATION_TRIGGERS].sort()).toEqual(wired);
  });

  it("REG-1965 T1b: PAYMENT_REMINDER (no firing site) is NOT registered, so it can never render a switch", () => {
    expect(NOTIFICATION_TRIGGERS.has(NotificationEvent.PAYMENT_REMINDER)).toBe(false);
  });

  it("REG-1965 T2: every NotificationEvent has an audience; the five internal events are STAFF, the rest CUSTOMER", () => {
    for (const ev of ALL_EVENTS) expect(["CUSTOMER", "STAFF"]).toContain(notificationAudience(ev));
    const staff = ALL_EVENTS.filter((e) => notificationAudience(e) === "STAFF").sort();
    expect(staff).toEqual(
      [
        NotificationEvent.URGENT_ORDER_PLACED,
        NotificationEvent.LOW_STOCK,
        NotificationEvent.FAILED_DELIVERY,
        NotificationEvent.PAYMENT_FAILED_NSF,
        NotificationEvent.CHECK_RETURNED,
      ].sort(),
    );
    expect(Object.keys(NOTIFICATION_AUDIENCE).sort()).toEqual([...ALL_EVENTS].sort());
  });
});

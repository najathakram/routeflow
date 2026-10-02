/**
 * #1965 (spec 10) — the single trigger registry. `NOTIFICATION_TRIGGERS` lists every
 * NotificationEvent that has a firing site; the notifications page hides/“Coming soon”s the rest,
 * so a switch can never render for an event nothing ever fires. This walks the tree (precedent:
 * `default-on-is-wired.spec.ts`, `common/no-bare-cron.spec.ts`) so a NEW firing site or a NEW
 * event that is not registered fails here instead of shipping a lying switch.
 */
import * as fs from "fs";
import * as path from "path";
import { MessageChannel, NotificationEvent } from "@prisma/client";
import { CHANNEL_STATUS_CHANNEL_VALUES } from "@routeflow/types";
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

/**
 * The events a source text passes to `notifyEvent(` — the actual firing sites, not any mention of
 * `NotificationEvent.X`. The first argument may be `NotificationEvent.X`, a string literal
 * (`"X"`/`'X'`/`` `X` ``), or an identifier (a variable/map lookup); an identifier cannot be
 * resolved statically, so it falls back to the `NotificationEvent.X` references in the same file
 * (documented limitation: `orders.service.ts` routes its status→event map through one variable).
 */
function eventsFiredIn(text: string): Set<NotificationEvent> {
  const fired = new Set<NotificationEvent>();
  const known = new Set<string>(ALL_EVENTS);
  const refs = [...text.matchAll(/NotificationEvent\.([A-Z_]+)/g)].map((m) => m[1]);
  for (const m of text.matchAll(/notifyEvent\(\s*([^,)]+)/g)) {
    const arg = m[1].trim();
    const direct = arg.match(/^NotificationEvent\.([A-Z_]+)$/)?.[1];
    const literal = arg.match(/^["'`]([A-Z_]+)["'`]$/)?.[1];
    if (direct && known.has(direct)) fired.add(direct as NotificationEvent);
    else if (literal && known.has(literal)) fired.add(literal as NotificationEvent);
    else if (!direct && !literal) {
      for (const r of refs) if (known.has(r)) fired.add(r as NotificationEvent);
    }
  }
  return fired;
}

const WIRED = new Set<NotificationEvent>(SOURCES.flatMap((t) => [...eventsFiredIn(t)]));
function firedOutsideMessaging(ev: string): boolean {
  return WIRED.has(ev as NotificationEvent);
}

describe("eventsFiredIn — mutant pins (#1965)", () => {
  it("reads a NotificationEvent.X first argument, across lines and method chains", () => {
    expect([
      ...eventsFiredIn("this.messaging\n  .notifyEvent(\n    NotificationEvent.DELIVERED, {})"),
    ]).toEqual(["DELIVERED"]);
  });

  it("reads a string-literal first argument (a mutant that only matched NotificationEvent.X would miss it)", () => {
    expect([...eventsFiredIn('await svc.notifyEvent("LOW_STOCK", { productName })')]).toEqual([
      "LOW_STOCK",
    ]);
    expect([...eventsFiredIn("svc.notifyEvent('FAILED_DELIVERY', {})")]).toEqual([
      "FAILED_DELIVERY",
    ]);
  });

  it("ignores a mention that is not a notifyEvent( call site", () => {
    expect(
      eventsFiredIn("const label = NotificationEvent.LOW_STOCK; log(NotificationEvent.DELIVERED)")
        .size,
    ).toBe(0);
  });

  it("falls back to the file's own NotificationEvent.X references for an identifier argument", () => {
    const src =
      "const map = { a: NotificationEvent.OUT_FOR_DELIVERY, b: NotificationEvent.CANCELLED };\n" +
      "svc.notifyEvent(messagingEvent, {})";
    expect([...eventsFiredIn(src)].sort()).toEqual(["CANCELLED", "OUT_FOR_DELIVERY"]);
  });

  it("does not count an unknown literal", () => {
    expect(eventsFiredIn('svc.notifyEvent("NOT_AN_EVENT", {})').size).toBe(0);
  });
});

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

  it("REG-1965 T2: every NotificationEvent has an audience; the five internal events and the three SA-603c buyer-order events are STAFF, the rest CUSTOMER", () => {
    for (const ev of ALL_EVENTS) expect(["CUSTOMER", "STAFF"]).toContain(notificationAudience(ev));
    const staff = ALL_EVENTS.filter((e) => notificationAudience(e) === "STAFF").sort();
    expect(staff).toEqual(
      [
        NotificationEvent.URGENT_ORDER_PLACED,
        NotificationEvent.LOW_STOCK,
        NotificationEvent.FAILED_DELIVERY,
        NotificationEvent.PAYMENT_FAILED_NSF,
        NotificationEvent.CHECK_RETURNED,
        // SA-603c / SA-606 WS4: emailed to the tenant's staff admins (no firing site yet).
        NotificationEvent.STAFF_NEW_ORDER,
        NotificationEvent.BUYER_ORDER_EDITED,
        NotificationEvent.BUYER_ORDER_CANCELLED,
      ].sort(),
    );
    expect(Object.keys(NOTIFICATION_AUDIENCE).sort()).toEqual([...ALL_EVENTS].sort());
  });
});

describe("channelStatus channel list (#1965)", () => {
  it("CHANNEL_STATUS_CHANNEL_VALUES is exactly MessageChannel minus INTERNAL (L-072 pin)", () => {
    const expected = (Object.values(MessageChannel) as string[])
      .filter((c) => c !== MessageChannel.INTERNAL)
      .sort();
    expect([...CHANNEL_STATUS_CHANNEL_VALUES].sort()).toEqual(expected);
  });
});

import { MessageChannel, NotificationEvent } from "@prisma/client";
import {
  DEFAULT_ON,
  DEFAULT_TEMPLATES,
  EVENT_CHANNELS,
  SEED_ENABLED_FROM,
  seedDefaultsFor,
} from "./messaging-config.service";

/**
 * SA-1101 §4.1 (RO-11): a missing ORDER_REFUSED rule copies `enabled` from the tenant's DELIVERED rule on the
 * same channel, so a business that turned "Delivered" email off stays off. No DELIVERED rule falls back to
 * DEFAULT_ON (EMAIL and PORTAL). One migration folder: no SQL seed for the new event.
 */
const { EMAIL, PORTAL } = MessageChannel;

function fakeDb() {
  const created: { rules: any[]; templates: any[] } = { rules: [], templates: [] };
  return {
    created,
    db: {
      notificationRule: {
        createMany: jest
          .fn()
          .mockImplementation(async ({ data }: any) => void created.rules.push(...data)),
      },
      messageTemplate: {
        createMany: jest
          .fn()
          .mockImplementation(async ({ data }: any) => void created.templates.push(...data)),
      },
    } as any,
  };
}
/** Every rule except ORDER_REFUSED's already exists, so only the new event is seeded. */
function everyRuleExceptRefused(overrides: Record<string, boolean>) {
  const rules: { eventKey: NotificationEvent; channel: MessageChannel; enabled: boolean }[] = [];
  for (const eventKey of Object.keys(EVENT_CHANNELS) as NotificationEvent[]) {
    if (eventKey === NotificationEvent.ORDER_REFUSED) continue;
    for (const channel of EVENT_CHANNELS[eventKey]) {
      const key = `${eventKey}:${channel}`;
      rules.push({ eventKey, channel, enabled: overrides[key] ?? DEFAULT_ON.has(key) });
    }
  }
  return rules;
}
const refusedRules = (created: { rules: any[] }) =>
  Object.fromEntries(
    created.rules
      .filter((r) => r.eventKey === NotificationEvent.ORDER_REFUSED)
      .map((r) => [r.channel, r.enabled]),
  );

describe("ORDER_REFUSED rule seeding (SA-1101 RO-11)", () => {
  it("is wired: a customer event on every customer channel, mapped to DELIVERED", () => {
    expect(EVENT_CHANNELS[NotificationEvent.ORDER_REFUSED]).toEqual(
      EVENT_CHANNELS[NotificationEvent.DELIVERED],
    );
    expect(SEED_ENABLED_FROM).toEqual({
      [NotificationEvent.ORDER_REFUSED]: NotificationEvent.DELIVERED,
    });
    expect(DEFAULT_ON.has(`${NotificationEvent.ORDER_REFUSED}:${EMAIL}`)).toBe(true);
    expect(DEFAULT_ON.has(`${NotificationEvent.ORDER_REFUSED}:${PORTAL}`)).toBe(true);
  });

  it("a tenant with DELIVERED:EMAIL off gets ORDER_REFUSED:EMAIL off (PORTAL follows its own DELIVERED rule)", async () => {
    const { db, created } = fakeDb();
    const rules = everyRuleExceptRefused({ [`${NotificationEvent.DELIVERED}:${EMAIL}`]: false });
    await seedDefaultsFor(db, rules, []);
    expect(refusedRules(created)[EMAIL]).toBe(false);
    expect(refusedRules(created)[PORTAL]).toBe(true);
  });

  it("a tenant with DELIVERED:PORTAL off gets ORDER_REFUSED:PORTAL off and EMAIL on", async () => {
    const { db, created } = fakeDb();
    await seedDefaultsFor(
      db,
      everyRuleExceptRefused({ [`${NotificationEvent.DELIVERED}:${PORTAL}`]: false }),
      [],
    );
    expect(refusedRules(created)).toMatchObject({ [EMAIL]: true, [PORTAL]: false });
  });

  it("a tenant with no DELIVERED rows gets the defaults: EMAIL and PORTAL on, the rest off", async () => {
    const { db, created } = fakeDb();
    await seedDefaultsFor(db, [], []);
    const r = refusedRules(created);
    expect(r[EMAIL]).toBe(true);
    expect(r[PORTAL]).toBe(true);
    for (const [channel, enabled] of Object.entries(r)) {
      if (channel !== EMAIL && channel !== PORTAL) expect(enabled).toBe(false);
    }
  });

  it("an existing ORDER_REFUSED rule is never rewritten", async () => {
    const { db, created } = fakeDb();
    const rules = [
      ...everyRuleExceptRefused({}),
      { eventKey: NotificationEvent.ORDER_REFUSED, channel: EMAIL, enabled: false },
    ];
    await seedDefaultsFor(db, rules, []);
    expect(refusedRules(created)[EMAIL]).toBeUndefined();
  });

  it("the default template is the owner's line: no total, never the word delivered", () => {
    const t = DEFAULT_TEMPLATES[NotificationEvent.ORDER_REFUSED];
    expect(t.label).toBe("Order refused");
    expect(t.body).toBe(
      "Hi {{customerName}}, your order {{orderNumber}} was refused at delivery. Contact us if this is wrong.",
    );
    expect(t.body).not.toMatch(/total|delivered on|\{\{orderTotal\}\}/i);
  });
});

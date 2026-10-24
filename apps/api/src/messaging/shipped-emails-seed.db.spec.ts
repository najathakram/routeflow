/**
 * Carrier-shipped emails: real-Postgres proof of migration 20261003120100_shipped_emails_seed_rules.
 * The migration's own SQL is READ from disk and executed against spec-owned throwaway tenants:
 *   - inserts the 2 events x 4 channels of rule + template rows for a tenant that lacks them;
 *   - copies the tenant's OUT_FOR_DELIVERY enabled / isActive per channel (never forces DEFAULT_ON);
 *   - falls back to DEFAULT_ON (EMAIL / PORTAL on, WA / SMS off) for a tenant that was never seeded;
 *   - is idempotent (a second run changes nothing) and changes no existing row.
 * The migration touches every tenant, so the spec only asserts on rows of its own tenants.
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  MessageChannel,
  NotificationEvent,
  PrismaClient,
  TenantClass,
  TenantStatus,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { DEFAULT_TEMPLATES, EVENT_CHANNELS } from "./messaging-config.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SEED_SQL = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20261003120100_shipped_emails_seed_rules",
    "migration.sql",
  ),
  "utf8",
);
const NEW_EVENTS = [
  NotificationEvent.ORDER_SHIPPED,
  NotificationEvent.SHIPMENT_TRACKING_ADDED,
  NotificationEvent.READY_FOR_PICKUP,
];
const CHANNELS = EVENT_CHANNELS[NotificationEvent.ORDER_SHIPPED];

describeDb("shipped-emails seed migration (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
  });

  afterAll(async () => {
    if (tenantIds.length) {
      // Rule/template rows first: their tenant FK is SET NULL and the T6 CHECK refuses a NULL tenantId.
      await prisma.notificationRule.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.messageTemplate.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function throwawayTenant(label: string): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-shipemail-${run}-${seq}-${label}`,
      "shipped-emails-seed.db.spec.ts",
    );
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE } as any,
    });
    tenantIds.push(t.id);
    return t.id;
  }

  /** The tenant's pre-existing OUT_FOR_DELIVERY rows: per-channel enabled / isActive. */
  async function seedOutForDelivery(
    tenantId: string,
    cells: Partial<Record<MessageChannel, { enabled: boolean; isActive: boolean }>>,
  ) {
    for (const [channel, cell] of Object.entries(cells) as [
      MessageChannel,
      { enabled: boolean; isActive: boolean },
    ][]) {
      await prisma.notificationRule.create({
        data: {
          tenantId,
          eventKey: NotificationEvent.OUT_FOR_DELIVERY,
          channel,
          enabled: cell.enabled,
        },
      });
      await prisma.messageTemplate.create({
        data: {
          tenantId,
          eventKey: NotificationEvent.OUT_FOR_DELIVERY,
          channel,
          body: "Our own wording {{orderNumber}}",
          variables: ["orderNumber"],
          isActive: cell.isActive,
        },
      });
    }
  }

  const rulesOf = (tenantId: string) =>
    prisma.notificationRule.findMany({
      where: { tenantId, eventKey: { in: NEW_EVENTS } },
      orderBy: [{ eventKey: "asc" }, { channel: "asc" }],
    });
  const templatesOf = (tenantId: string) =>
    prisma.messageTemplate.findMany({
      where: { tenantId, eventKey: { in: NEW_EVENTS } },
      orderBy: [{ eventKey: "asc" }, { channel: "asc" }],
    });
  const enabledMap = (rows: { eventKey: string; channel: string; enabled: boolean }[]) =>
    Object.fromEntries(rows.map((r) => [`${r.eventKey}:${r.channel}`, r.enabled]));

  it("a never-seeded tenant gets DEFAULT_ON: EMAIL and PORTAL on, WHATSAPP and SMS off, with the default bodies", async () => {
    const t = await throwawayTenant("fresh");
    await pool.query(SEED_SQL);

    const rules = await rulesOf(t);
    expect(rules).toHaveLength(NEW_EVENTS.length * CHANNELS.length);
    for (const e of NEW_EVENTS) {
      expect(enabledMap(rules)).toMatchObject({
        [`${e}:EMAIL`]: true,
        [`${e}:PORTAL`]: true,
        [`${e}:WHATSAPP`]: false,
        [`${e}:SMS`]: false,
      });
    }
    const templates = await templatesOf(t);
    expect(templates).toHaveLength(NEW_EVENTS.length * CHANNELS.length);
    for (const tpl of templates) {
      expect(tpl.isActive).toBe(true);
      expect(tpl.body).toBe(DEFAULT_TEMPLATES[tpl.eventKey].body);
    }
    const shipped = templates.find((x) => x.eventKey === "ORDER_SHIPPED")!;
    expect(shipped.variables).toEqual(["customerName", "orderNumber", "carrier", "trackingLine"]);
    const tracking = templates.find((x) => x.eventKey === "SHIPMENT_TRACKING_ADDED")!;
    expect(tracking.variables).toEqual([
      "customerName",
      "orderNumber",
      "trackingNumber",
      "trackingUrl",
    ]);
  });

  it("copies each channel's OUT_FOR_DELIVERY enabled / isActive instead of forcing DEFAULT_ON", async () => {
    const t = await throwawayTenant("chosen");
    await seedOutForDelivery(t, {
      EMAIL: { enabled: false, isActive: true }, // switched off: stays off
      PORTAL: { enabled: true, isActive: false }, // template deactivated: stays inactive
      SMS: { enabled: true, isActive: true }, // opted in to SMS: keeps it
      // WHATSAPP: no row at all: DEFAULT_ON fallback (off)
    });
    await pool.query(SEED_SQL);

    const rules = enabledMap(await rulesOf(t));
    for (const e of NEW_EVENTS) {
      expect(rules[`${e}:EMAIL`]).toBe(false);
      expect(rules[`${e}:PORTAL`]).toBe(true);
      expect(rules[`${e}:SMS`]).toBe(true);
      expect(rules[`${e}:WHATSAPP`]).toBe(false);
    }
    const active = Object.fromEntries(
      (await templatesOf(t)).map((x) => [`${x.eventKey}:${x.channel}`, x.isActive]),
    );
    for (const e of NEW_EVENTS) {
      expect(active[`${e}:PORTAL`]).toBe(false);
      expect(active[`${e}:EMAIL`]).toBe(true);
    }
  });

  it("is idempotent and changes no existing row", async () => {
    const t = await throwawayTenant("idem");
    await seedOutForDelivery(t, { EMAIL: { enabled: true, isActive: true } });
    await pool.query(SEED_SQL);
    const before = { rules: await rulesOf(t), templates: await templatesOf(t) };
    // The tenant's own customised OUT_FOR_DELIVERY row is untouched too.
    const outBefore = await prisma.messageTemplate.findFirstOrThrow({
      where: { tenantId: t, eventKey: NotificationEvent.OUT_FOR_DELIVERY, channel: "EMAIL" },
    });

    // The business later switches one new cell off and edits a new body; a re-run must not undo that.
    await prisma.notificationRule.updateMany({
      where: { tenantId: t, eventKey: "ORDER_SHIPPED", channel: "EMAIL" },
      data: { enabled: false },
    });
    await prisma.messageTemplate.updateMany({
      where: { tenantId: t, eventKey: "ORDER_SHIPPED", channel: "EMAIL" },
      data: { body: "edited by the business" },
    });
    await pool.query(SEED_SQL);

    const after = { rules: await rulesOf(t), templates: await templatesOf(t) };
    expect(after.rules).toHaveLength(before.rules.length);
    expect(after.templates).toHaveLength(before.templates.length);
    expect(
      after.rules.find((r) => r.eventKey === "ORDER_SHIPPED" && r.channel === "EMAIL")?.enabled,
    ).toBe(false);
    expect(
      after.templates.find((x) => x.eventKey === "ORDER_SHIPPED" && x.channel === "EMAIL")?.body,
    ).toBe("edited by the business");
    const outAfter = await prisma.messageTemplate.findFirstOrThrow({ where: { id: outBefore.id } });
    expect(outAfter.body).toBe(outBefore.body);
    expect(outAfter.updatedAt.getTime()).toBe(outBefore.updatedAt.getTime());
  });
});

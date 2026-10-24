import { readFileSync } from "fs";
import { join } from "path";
import { NotificationEvent } from "@prisma/client";
import { extractVariables } from "../messaging/messaging.helpers";
import { DEFAULT_TEMPLATES } from "../messaging/messaging-config.service";

/**
 * Carrier-shipped emails: the two migration files are READ at test time and pinned by shape.
 *   A (events + marker): ADD VALUE x2 + one nullable Order column.
 *   B (seed rows): a SEPARATE, later migration (an enum value cannot be used in the transaction that
 *   adds it), INSERT-only, ON CONFLICT DO NOTHING; its template bodies equal DEFAULT_TEMPLATES.
 */
const MIGRATIONS_DIR = join(__dirname, "..", "..", "prisma", "migrations");
const A = "20261003120000_shipped_emails_events_and_marker";
const B = "20261003120100_shipped_emails_seed_rules";

function load(folder: string) {
  const raw = readFileSync(join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");
  const sql = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const stmts = sql
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { raw, sql, stmts };
}

describe("shipped-emails migration A (events + marker)", () => {
  const { sql, stmts } = load(A);

  it("sorts after the prior migrations, and B sorts after A", () => {
    // Pinned to the newest folder at authoring time, not "every folder": a later migration may land.
    expect(A > "20260929220000_sitting_b_bundle").toBe(true);
    expect(B > A).toBe(true);
  });

  it("is one transaction with a bounded lock_timeout right after BEGIN", () => {
    expect(stmts[0]).toBe("BEGIN");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts[stmts.length - 1]).toBe("COMMIT");
    expect((sql.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((sql.match(/^COMMIT;/gm) ?? []).length).toBe(1);
  });

  it("adds exactly the three enum values", () => {
    const adds = stmts.filter((s) => /ADD VALUE/i.test(s));
    expect(adds).toEqual([
      `ALTER TYPE "NotificationEvent" ADD VALUE 'ORDER_SHIPPED'`,
      `ALTER TYPE "NotificationEvent" ADD VALUE 'SHIPMENT_TRACKING_ADDED'`,
      `ALTER TYPE "NotificationEvent" ADD VALUE 'READY_FOR_PICKUP'`,
    ]);
  });

  it("adds exactly one nullable TIMESTAMP(3) column to Order and nothing else", () => {
    const alters = stmts.filter((s) => /^ALTER TABLE/.test(s));
    expect(alters).toEqual([`ALTER TABLE "Order" ADD COLUMN "trackingNotifiedAt" TIMESTAMP(3)`]);
  });

  it("is additive: no DROP / NOT NULL / RENAME / UPDATE / DELETE / INSERT, and never USES the new values", () => {
    expect(sql).not.toMatch(/\b(DROP|RENAME|UPDATE|DELETE|INSERT|TRUNCATE)\b|NOT NULL/i);
    // the only mentions of the new values are the three ADD VALUE statements
    expect(
      (sql.match(/ORDER_SHIPPED|SHIPMENT_TRACKING_ADDED|READY_FOR_PICKUP/g) ?? []).length,
    ).toBe(3);
  });
});

describe("shipped-emails migration B (seed rules)", () => {
  const { sql, stmts } = load(B);

  it("is one transaction with a bounded lock_timeout right after BEGIN", () => {
    expect(stmts[0]).toBe("BEGIN");
    expect(stmts[1]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts[stmts.length - 1]).toBe("COMMIT");
  });

  it("is INSERT-only: two inserts, each ON CONFLICT DO NOTHING, no UPDATE/DELETE/DDL", () => {
    const inserts = stmts.filter((s) => /^INSERT INTO/.test(s));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatch(/^INSERT INTO "NotificationRule"/);
    expect(inserts[1]).toMatch(/^INSERT INTO "MessageTemplate"/);
    for (const i of inserts)
      expect(i).toMatch(/ON CONFLICT \("tenantId", "eventKey", "channel"\) DO NOTHING$/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
  });

  it("covers every existing tenant and the four customer channels, copying the OUT_FOR_DELIVERY choice", () => {
    expect(sql).toContain('FROM "Tenant" t');
    expect(sql).toMatch(/\('WHATSAPP'\), \('SMS'\), \('EMAIL'\), \('PORTAL'\)/);
    expect(sql).toContain(`COALESCE(o."enabled", c.ch IN ('EMAIL', 'PORTAL'))`);
    expect(sql).toContain(`COALESCE(o."isActive", true)`);
    expect(sql).toMatch(/o\."eventKey" = 'OUT_FOR_DELIVERY'::"NotificationEvent"/);
  });

  it.each([
    NotificationEvent.ORDER_SHIPPED,
    NotificationEvent.SHIPMENT_TRACKING_ADDED,
    NotificationEvent.READY_FOR_PICKUP,
  ])("%s: the seeded body and variables equal DEFAULT_TEMPLATES (drift guard)", (e) => {
    const body = DEFAULT_TEMPLATES[e].body;
    expect(sql).toContain(`('${e}',\n   '${body}',`);
    const vars = extractVariables(body);
    expect(sql).toContain(`ARRAY[${vars.map((v) => `'${v}'`).join(", ")}]::TEXT[]`);
  });
});

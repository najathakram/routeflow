/**
 * Row 509 PR3 — edit a rule's settings IN PLACE, with history, on REAL Postgres. Pins:
 *  - preview direction per field (state add TIGHTENS, remove LOOSENS, BUYER_PORTAL -> ALL TIGHTENS always (the
 *    tenant switch is gone, row 510), a wider window TIGHTENS);
 *  - the impact counts an OPEN order / a DRAFT whose customer is newly restricted by a state add, and not a
 *    delivered order, not a customer the old settings already restricted, not a line outside the rule's targets;
 *  - a stale expectedRevision is 409 RULE_STALE and a changed impact is 409 RULE_IMPACT_CHANGED, each with nothing
 *    written; a lifted rule is RULE_NOT_EDITABLE;
 *  - an all-customer rule (or an edit INTO one) is TENANT_ADMIN-only: an operator gets 403, an admin succeeds;
 *  - history: n rows after n-1 edits, old rows never touched, one audit row per edit;
 *  - the engine reads the new values at once, an open order is NOT touched by the edit, and its lines are refused at
 *    the existing choke point (assertLinesSellable) when next touched;
 *  - the migration's revision-1 backfill gives every existing rule its current values, idempotently.
 *
 * Collected only by `jest.db.config.js` (`npm run test:db`). The tenant is a throwaway `qa-r509e-<run>` slug approved
 * by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RuleEditService, ruleRevisions } from "./rule-edit.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const FROM = new Date("2026-01-01T00:00:00Z");
const REASON = `R509E ${RUN}`;

/** The revision-1 backfill statement exactly as the migration ships it. */
function backfillSql(): string {
  const sql = readFileSync(
    join(
      __dirname,
      "../../prisma/migrations/20261014130000_selling_restriction_revisions/migration.sql",
    ),
    "utf8",
  );
  const start = sql.indexOf('INSERT INTO "SellingRestrictionRevision"');
  if (start < 0) throw new Error("backfill INSERT not found in the migration");
  return sql.slice(start, sql.indexOf(";", start) + 1);
}

describeDb("row 509 PR3: edit a rule in place, with history — real Postgres", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let engine: SellingRestrictionsService;
  let service: RuleEditService;
  let tenantId: string;
  let admin: JwtPayload;
  let operator: JwtPayload;
  const cust: Record<string, string> = {};
  const p: Record<string, string> = {};
  let invoiceSeq = 0;

  const as = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);
  const body = (over: Record<string, unknown> = {}) =>
    ({ jurisdiction: "STATE", states: ["TX"], surface: "ALL", reason: REASON, ...over }) as never;
  const commitBody = (rev: number, hash: string, over: Record<string, unknown> = {}) =>
    ({ ...(body(over) as object), expectedRevision: rev, confirmImpactHash: hash }) as never;
  const setSwitch = async (on: boolean) => {
    await prisma.systemConfig.upsert({
      where: { tenantId_key: { tenantId, key: "selling_restrictions.enabled" } },
      create: { tenantId, key: "selling_restrictions.enabled", value: on ? "true" : "false" },
      update: { value: on ? "true" : "false" },
    });
  };

  /** A rule as the app creates it: the row, its target, and revision 1. */
  const mkRule = async (over: Record<string, unknown> = {}) => {
    const rule = await prisma.sellingRestriction.create({
      data: {
        tenantId,
        productId: p.a,
        jurisdiction: "STATE",
        states: ["TX"],
        surface: "ALL",
        reason: REASON,
        effectiveFrom: FROM,
        createdById: admin.sub,
        createdByName: admin.username,
        ...over,
      } as never,
    });
    await prisma.sellingRestrictionTarget.create({
      data: { tenantId, ruleId: rule.id, productId: p.a, addedAt: FROM },
    });
    await prisma.sellingRestrictionRevision.create({
      data: {
        tenantId,
        ruleId: rule.id,
        revision: 1,
        jurisdiction: rule.jurisdiction,
        states: rule.states,
        surface: rule.surface,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        reason: rule.reason,
        editedById: admin.sub,
        editedByName: admin.username,
        editedAt: rule.createdAt,
      },
    });
    return rule;
  };
  const mkOrder = async (
    customer: string,
    productKey: string,
    status: "PENDING" | "DRAFT" | "DELIVERED" | "CONFIRMED" = "PENDING",
  ) => {
    const order = await prisma.order.create({
      data: { tenantId, customerId: customer, status, subtotal: 10, tax: 0, total: 10 },
    });
    await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: p[productKey],
        qty: 1,
        unitPrice: 10,
        subtotal: 10,
      },
    });
    return order.id;
  };
  const mkDraftInvoice = async (customer: string, productKey: string) => {
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer,
        invoiceNumber: `INV-R509E-${RUN}-${++invoiceSeq}`,
        status: "DRAFT",
        subtotal: 10,
        total: 10,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: inv.id,
        description: "line",
        productId: p[productKey],
        qty: 1,
        unitPrice: 10,
        subtotal: 10,
      },
    });
    return inv.id;
  };
  const ruleRow = (id: string) => prisma.sellingRestriction.findUniqueOrThrow({ where: { id } });
  const revisions = (ruleId: string) =>
    prisma.sellingRestrictionRevision.findMany({ where: { ruleId }, orderBy: { revision: "asc" } });
  const preview = (id: string, over: Record<string, unknown> = {}, user = admin) =>
    as(() => service.preview(id, body(over), user));
  const commit = (
    id: string,
    rev: number,
    hash: string,
    over: Record<string, unknown> = {},
    user = admin,
  ) => as(() => service.commit(id, commitBody(rev, hash, over), user));
  /** The 409 / 403 a call throws, as { status, code }. */
  const refusal = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      const err = e as { getStatus?: () => number; getResponse?: () => { code?: string } };
      const res = err.getResponse?.();
      return { status: err.getStatus?.(), code: typeof res === "object" ? res?.code : undefined };
    }
    return null;
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const labels = new ProductLabelsService(prisma);
    engine = new SellingRestrictionsService(prisma, labels);
    service = new RuleEditService(prisma, engine, labels);

    const slug = assertTestTenant(`qa-r509e-${RUN}`, "rule-edit.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `R509E ${slug}` } })).id;
    const mkUser = async (key: string, role: "TENANT_ADMIN" | "OPERATOR" | "CUSTOMER") =>
      prisma.user.create({
        data: {
          email: `r509e-${key}-${RUN}@example.invalid`,
          username: `r509e-${key}-${RUN}`,
          role,
          tenantId,
        },
      });
    const au = await mkUser("admin", "TENANT_ADMIN");
    const ou = await mkUser("op", "OPERATOR");
    admin = { sub: au.id, username: au.username, role: "TENANT_ADMIN", tenantId } as JwtPayload;
    operator = { sub: ou.id, username: ou.username, role: "OPERATOR", tenantId } as JwtPayload;

    for (const [key, state] of [
      ["tx", "TX"],
      ["ca", "CA"],
      ["ny", "NY"],
    ] as const) {
      const u = await mkUser(`c-${key}`, "CUSTOMER");
      cust[key] = (
        await prisma.customer.create({
          data: { userId: u.id, businessName: `R509E ${key}`, contactName: key, tenantId },
        })
      ).id;
      await prisma.customerAddress.create({
        data: {
          tenantId,
          customerId: cust[key],
          line1: "1 Test St",
          city: "Testville",
          state,
          stateCode: state,
          zip: "00000",
          isDefault: true,
          addressType: "BILLING",
        },
      });
    }
    for (const k of ["a", "other"]) {
      p[k] = (
        await prisma.product.create({
          data: { tenantId, name: `R509E ${k} ${RUN}`, unit: "each", pricePerUnit: 10 },
        })
      ).id;
    }
  }, 120_000);

  const cleanRules = async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.sellingRestrictionRevision.deleteMany({ where: { tenantId } });
    await prisma.sellingRestrictionTarget.deleteMany({ where: { tenantId } });
    await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
  };

  afterEach(cleanRules);

  afterAll(async () => {
    if (tenantId) {
      await cleanRules();
      await prisma.systemConfig.deleteMany({ where: { tenantId } });
      await prisma.customerAddress.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  }, 120_000);

  beforeEach(async () => {
    // row 510: the tenant switch is gone and never read; a stored value of it must change no result below
    await setSwitch(true);
  });

  // ─── preview: direction ──────────────────────────────────────────────────────────────────────
  it("preview names the direction of each changed field and the revision it was computed against", async () => {
    const rule = await mkRule();
    expect((await preview(rule.id)).changes).toEqual([]);
    expect((await preview(rule.id, { states: ["TX", "CA"] })).changes).toEqual([
      { field: "states", direction: "TIGHTENS" },
    ]);
    const loosen = await preview(rule.id, { states: ["TX"] });
    expect(loosen.revision).toBe(1);
    const two = await mkRule({ states: ["TX", "CA"] });
    expect((await preview(two.id, { states: ["TX"] })).changes).toEqual([
      { field: "states", direction: "LOOSENS" },
    ]);
    expect((await preview(rule.id, { effectiveFrom: "2025-06-01T00:00:00.000Z" })).changes).toEqual(
      [{ field: "window", direction: "TIGHTENS" }],
    );
    expect((await preview(rule.id, { effectiveTo: "2027-01-01T00:00:00.000Z" })).changes).toEqual([
      { field: "window", direction: "LOOSENS" },
    ]);
  });

  it("BUYER_PORTAL -> ALL TIGHTENS, always (row 510: staff are judged; a stored enabled=false row changes nothing) and the impact counts staff-channel open work", async () => {
    const rule = await mkRule({ surface: "BUYER_PORTAL" }); // TX, portal-only
    expect((await preview(rule.id, { surface: "ALL" })).changes).toEqual([
      { field: "surface", direction: "TIGHTENS" },
    ]);
    // the removed switch, stored as false, is never read
    await setSwitch(false);
    const stored = await preview(rule.id, { surface: "ALL" });
    expect(stored.changes).toEqual([{ field: "surface", direction: "TIGHTENS" }]);
    // staff-channel open work in TX: an open order and a draft invoice are reached, a delivered order is not
    await mkOrder(cust.tx, "a", "PENDING");
    await mkOrder(cust.tx, "a", "DELIVERED");
    await mkDraftInvoice(cust.tx, "a");
    const withWork = await preview(rule.id, { surface: "ALL" });
    expect(withWork.impact).toEqual({ openOrders: 1, drafts: 1 });
    expect(withWork.impact).toEqual((await preview(rule.id, { surface: "ALL" })).impact);
  });

  // ─── preview: impact ─────────────────────────────────────────────────────────────────────────
  it("impact counts open orders and drafts of customers the edit NEWLY restricts, and nothing else", async () => {
    const rule = await mkRule(); // TX only
    await mkOrder(cust.ca, "a", "PENDING"); // counted
    await mkOrder(cust.ca, "a", "CONFIRMED"); // counted
    await mkOrder(cust.ca, "a", "DELIVERED"); // not open
    await mkOrder(cust.tx, "a", "PENDING"); // already restricted by the old settings
    await mkOrder(cust.ca, "other", "PENDING"); // line outside the rule's targets
    await mkOrder(cust.ny, "a", "PENDING"); // NY is not added
    await mkOrder(cust.ca, "a", "DRAFT"); // a draft
    await mkDraftInvoice(cust.ca, "a"); // a draft
    const res = await preview(rule.id, { states: ["TX", "CA"] });
    expect(res.impact).toEqual({ openOrders: 2, drafts: 2 });
    expect(res.impactHash).toMatch(/^[0-9a-f]{64}$/);
    // a LOOSENING edit has no impact, even though CA customers have orders
    const both = await mkRule({ states: ["TX", "CA"] });
    expect((await preview(both.id, { states: ["TX"] })).impact).toEqual({
      openOrders: 0,
      drafts: 0,
    });
  });

  it("validation is exactly create's: a STATE rule needs states, an all-customer one takes none, the end follows the start", async () => {
    const rule = await mkRule();
    const bad = async (over: Record<string, unknown>) =>
      (await refusal(() => preview(rule.id, over)))?.status;
    expect(await bad({ states: [] })).toBe(400);
    expect(await bad({ states: ["Tex"] })).toBe(400);
    expect(await bad({ jurisdiction: "FEDERAL", states: ["TX"] })).toBe(400);
    expect(await bad({ effectiveTo: "2025-01-01T00:00:00.000Z" })).toBe(400);
    const body400 = await refusal(() => commit(rule.id, 1, "x", { states: [] }));
    expect(body400?.status).toBe(400);
    expect(await revisions(rule.id)).toHaveLength(1);
  });

  it("impact reads a LEGACY rule (no target rows) by its legacy product column", async () => {
    const legacy = await prisma.sellingRestriction.create({
      data: {
        tenantId,
        productId: p.a,
        jurisdiction: "STATE",
        states: ["TX"],
        surface: "ALL",
        reason: REASON,
        effectiveFrom: FROM,
      },
    });
    await prisma.sellingRestrictionRevision.create({
      data: {
        tenantId,
        ruleId: legacy.id,
        revision: 1,
        jurisdiction: "STATE",
        states: ["TX"],
        surface: "ALL",
        effectiveFrom: FROM,
        reason: REASON,
      },
    });
    await mkOrder(cust.ca, "a", "PENDING");
    await mkOrder(cust.ca, "other", "PENDING");
    expect((await preview(legacy.id, { states: ["TX", "CA"] })).impact.openOrders).toBe(1);
  });

  // ─── commit: guards ──────────────────────────────────────────────────────────────────────────
  it("a stale expectedRevision is 409 RULE_STALE and nothing is written", async () => {
    const rule = await mkRule();
    const pre = await preview(rule.id, { states: ["TX", "CA"] });
    const r = await refusal(() => commit(rule.id, 7, pre.impactHash, { states: ["TX", "CA"] }));
    expect(r).toEqual({ status: 409, code: "RULE_STALE" });
    expect((await ruleRow(rule.id)).states).toEqual(["TX"]);
    expect((await ruleRow(rule.id)).revision).toBe(1);
    expect(await revisions(rule.id)).toHaveLength(1);
    expect(
      await prisma.auditLog.count({ where: { tenantId, action: "selling_restriction.edited" } }),
    ).toBe(0);
  });

  it("a changed impact between preview and commit is 409 RULE_IMPACT_CHANGED, nothing written", async () => {
    const rule = await mkRule();
    await mkOrder(cust.ca, "a", "PENDING");
    const pre = await preview(rule.id, { states: ["TX", "CA"] });
    expect(pre.impact.openOrders).toBe(1);
    await mkOrder(cust.ca, "a", "PENDING"); // a NEW matching open order after the preview
    const r = await refusal(() =>
      commit(rule.id, pre.revision, pre.impactHash, { states: ["TX", "CA"] }),
    );
    expect(r).toEqual({ status: 409, code: "RULE_IMPACT_CHANGED" });
    expect((await ruleRow(rule.id)).states).toEqual(["TX"]);
    expect(await revisions(rule.id)).toHaveLength(1);
    // previewing again and confirming that works
    const again = await preview(rule.id, { states: ["TX", "CA"] });
    expect(again.impact.openOrders).toBe(2);
    await commit(rule.id, again.revision, again.impactHash, { states: ["TX", "CA"] });
    expect((await ruleRow(rule.id)).states).toEqual(["TX", "CA"]);
  });

  it("a lifted rule is 409 RULE_NOT_EDITABLE, on preview and on commit", async () => {
    const rule = await mkRule({ liftedAt: new Date(Date.now() - 60_000), liftReason: "done" });
    expect(await refusal(() => preview(rule.id, { states: ["TX", "CA"] }))).toEqual({
      status: 409,
      code: "RULE_NOT_EDITABLE",
    });
    expect(await refusal(() => commit(rule.id, 1, "x", { states: ["TX", "CA"] }))).toEqual({
      status: 409,
      code: "RULE_NOT_EDITABLE",
    });
    expect(await revisions(rule.id)).toHaveLength(1);
  });

  it("another tenant's (or an unknown) rule id is a 404", async () => {
    expect(await refusal(() => preview(randomUUID()))).toEqual({ status: 404, code: undefined });
  });

  it("an operator may not edit an all-customer rule, nor edit a rule INTO one (403); an admin may", async () => {
    const fed = await mkRule({ jurisdiction: "FEDERAL", states: [] });
    const pf = await preview(fed.id, { jurisdiction: "FEDERAL", states: undefined }, admin);
    expect(
      (
        await refusal(() =>
          preview(fed.id, { jurisdiction: "FEDERAL", states: undefined }, operator),
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await refusal(() =>
          commit(
            fed.id,
            1,
            pf.impactHash,
            { jurisdiction: "FEDERAL", states: undefined, reason: "Changed" },
            operator,
          ),
        )
      )?.status,
    ).toBe(403);

    const st = await mkRule();
    const toFed = { jurisdiction: "FEDERAL", states: undefined };
    const pre = await preview(st.id, toFed, admin);
    expect(pre.changes).toContainEqual({ field: "jurisdiction", direction: "TIGHTENS" });
    expect((await refusal(() => commit(st.id, 1, pre.impactHash, toFed, operator)))?.status).toBe(
      403,
    );
    expect((await ruleRow(st.id)).jurisdiction).toBe("STATE");
    expect(await revisions(st.id)).toHaveLength(1);

    const done = await commit(st.id, 1, pre.impactHash, toFed, admin);
    expect(done).toMatchObject({ jurisdiction: "FEDERAL", states: [], revision: 2 });
    // and an operator CAN edit an ordinary STATE rule
    const ord = await mkRule();
    const po = await preview(ord.id, { states: ["TX", "NY"] }, operator);
    await commit(ord.id, 1, po.impactHash, { states: ["TX", "NY"] }, operator);
    expect((await ruleRow(ord.id)).states).toEqual(["TX", "NY"]);
  });

  // ─── commit: history, audit, engine ──────────────────────────────────────────────────────────
  it("history: n rows after n-1 edits, old rows never touched, newest first through ruleRevisions", async () => {
    const rule = await mkRule();
    const snapshot = async () => JSON.stringify((await revisions(rule.id)).map((r) => ({ ...r })));
    let rev = 1;
    const edits: Array<Record<string, unknown>> = [
      { states: ["TX", "CA"], note: "add California" },
      { states: ["TX", "CA"], reason: "Legal advice 2" },
      { states: ["CA"], surface: "BUYER_PORTAL", reason: "Legal advice 2" },
    ];
    let before = await snapshot();
    for (const over of edits) {
      const pre = await preview(rule.id, over);
      const out = await commit(rule.id, rev, pre.impactHash, over, rev % 2 ? admin : operator);
      rev += 1;
      expect(out.revision).toBe(rev);
      const after = await revisions(rule.id);
      expect(after).toHaveLength(rev);
      // every earlier row is byte-for-byte what it was
      expect(JSON.stringify(after.slice(0, rev - 1))).toBe(before);
      before = await snapshot();
    }
    const rows = await revisions(rule.id);
    expect(rows.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ states: ["TX"], surface: "ALL", reason: REASON });
    expect(rows[1]).toMatchObject({
      states: ["TX", "CA"],
      note: "add California",
      editedById: admin.sub,
      editedByName: admin.username,
    });
    expect(rows[2]).toMatchObject({ reason: "Legal advice 2", editedById: operator.sub });
    expect(rows[3]).toMatchObject({ states: ["CA"], surface: "BUYER_PORTAL" });
    // the rule row holds the current values
    expect(await ruleRow(rule.id)).toMatchObject({
      states: ["CA"],
      surface: "BUYER_PORTAL",
      revision: 4,
      reason: "Legal advice 2",
    });

    const listed = await as(() =>
      prisma.tenantTransaction((tx) => ruleRevisions(tx, tenantId, rule.id)),
    );
    expect(listed.map((r) => r.revision)).toEqual([4, 3, 2, 1]);
    expect(listed[3]).toMatchObject({
      jurisdiction: "STATE",
      states: ["TX"],
      surface: "ALL",
      reason: REASON,
      effectiveTo: null,
    });
    expect(typeof listed[0].editedAt).toBe("string");

    const audits = await prisma.auditLog.findMany({
      where: { tenantId, action: "selling_restriction.edited", entityId: rule.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(3);
    expect(audits[0].meta).toMatchObject({
      ruleId: rule.id,
      fromRevision: 1,
      toRevision: 2,
      changes: [{ field: "states", direction: "TIGHTENS" }],
    });
  });

  it("an edit that changes nothing is a no-op: same revision, no history row, no audit row", async () => {
    const rule = await mkRule();
    const pre = await preview(rule.id);
    const out = await commit(rule.id, 1, pre.impactHash);
    expect(out.revision).toBe(1);
    expect(await revisions(rule.id)).toHaveLength(1);
    expect(
      await prisma.auditLog.count({ where: { tenantId, action: "selling_restriction.edited" } }),
    ).toBe(0);
  });

  it("the engine reads the new values at once; an open order is untouched by the edit and refused at the choke point", async () => {
    const rule = await mkRule();
    const orderId = await mkOrder(cust.ca, "a", "PENDING");
    const lineBefore = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
    const decide = (channel: "STAFF" | "BUYER_PORTAL") =>
      as(
        async () =>
          (await engine.evaluate(tenantId, cust.ca, [{ productId: p.a }], { channel })).outcome,
      );
    expect(await decide("STAFF")).toBe("ALLOW"); // CA is not in the rule yet

    const pre = await preview(rule.id, { states: ["TX", "CA"] });
    await commit(rule.id, 1, pre.impactHash, { states: ["TX", "CA"] });

    expect(await decide("STAFF")).toBe("BLOCK");
    expect(await decide("BUYER_PORTAL")).toBe("BLOCK");
    // never retroactive: the order and its line are exactly as they were
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PENDING");
    expect(await prisma.orderItem.findFirstOrThrow({ where: { orderId } })).toEqual(lineBefore);
    // ... and the existing choke point refuses its line the next time it is touched
    await expect(
      as(() =>
        engine.assertLinesSellable({
          tenantId,
          customerId: cust.ca,
          lines: [{ productId: p.a }],
          channel: "STAFF",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  // ─── the migration's backfill ────────────────────────────────────────────────────────────────
  it("the migration backfill gives every existing rule revision 1 = its current values, idempotently", async () => {
    const r1 = await prisma.sellingRestriction.create({
      data: {
        tenantId,
        productId: p.a,
        jurisdiction: "STATE",
        states: ["TX", "CA"],
        surface: "BUYER_PORTAL",
        reason: "one",
        effectiveFrom: FROM,
        effectiveTo: new Date("2027-01-01T00:00:00Z"),
        createdById: admin.sub,
        createdByName: "R509E Admin",
      },
    });
    const r2 = await prisma.sellingRestriction.create({
      data: {
        tenantId,
        productId: p.other,
        jurisdiction: "FEDERAL",
        states: [],
        surface: "ALL",
        reason: "two",
        effectiveFrom: FROM,
        liftedAt: new Date(Date.now() - 1000),
        liftReason: "done",
      },
    });
    const keep = await mkRule(); // already has revision 1: untouched
    expect((await ruleRow(r1.id)).revision).toBe(1);

    await prisma.$executeRawUnsafe(backfillSql());
    await prisma.$executeRawUnsafe(backfillSql());
    const rows = await prisma.sellingRestrictionRevision.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(3);
    const byRule = new Map(rows.map((r) => [r.ruleId, r]));
    expect(byRule.get(r1.id)).toMatchObject({
      revision: 1,
      jurisdiction: "STATE",
      states: ["TX", "CA"],
      surface: "BUYER_PORTAL",
      reason: "one",
      effectiveFrom: FROM,
      effectiveTo: new Date("2027-01-01T00:00:00Z"),
      editedById: admin.sub,
      editedByName: "R509E Admin",
      editedAt: r1.createdAt,
    });
    expect(byRule.get(r2.id)).toMatchObject({
      revision: 1,
      jurisdiction: "FEDERAL",
      states: [],
      surface: "ALL",
      editedById: null,
    });
    expect(byRule.get(keep.id)?.editedByName).toBe(admin.username);
  });
});

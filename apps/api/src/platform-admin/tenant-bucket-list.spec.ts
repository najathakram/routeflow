import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { TENANT_BUCKET_VALUES } from "@routeflow/types";
import { MrrService } from "../billing/mrr.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  TENANT_BUCKET_SCAN_CAP,
  TENANT_LIST_MAX_LIMIT,
  assertListLimit,
  listTenantsByBucket,
  parseBucketParam,
  tenantBucketWire,
} from "./tenant-bucket-list";

/**
 * SA-1535 / W-1462 PR-1: the list classifies in one slim scan, counts every tab in the same call, and pages the open tab.
 * Fixtures: approved test slugs and acme placeholders only.
 */
const NOW = new Date("2026-11-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const sub = (o: Record<string, unknown> = {}) => ({
  planKey: "GROWTH",
  couponFull: false,
  pastDueSince: null,
  needsReconcile: false,
  cancelAtPeriodEnd: false,
  stripeSubId: null,
  stripeCustomerId: null,
  catchupState: null,
  basePriceSnapshot: 149,
  discount: 0,
  ...o,
});
const t = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  slug: `acme-${id}`,
  class: "PRODUCTION",
  status: "ACTIVE",
  deletedAt: null,
  trialEndsAt: null,
  readOnlyReason: null,
  subscription: sub(),
  ...o,
});

const FIXTURE = [
  t("p1"),
  t("p2", { subscription: sub({ pastDueSince: NOW }) }),
  t("n1", { subscription: null }),
  // red on master: master ignores ?bucket and returns it. Paying set, but no price snapshot: not paying, subscribed_zero.
  t("z1", { subscription: sub({ basePriceSnapshot: null }) }),
  t("tr1", { status: "TRIAL", trialEndsAt: new Date(NOW.getTime() + 3 * DAY) }),
  t("pa1", { status: "READ_ONLY" }),
  t("c1", { status: "CANCELLED" }),
  t("c2", { deletedAt: new Date(NOW.getTime() - DAY) }),
  t("x1", { slug: "qa-acme", class: "TEST", subscription: null }),
  t("x2", { slug: "e2e-acme", class: "TEST", deletedAt: new Date(NOW.getTime() - DAY) }),
  t("i1", { slug: "routeflow-hq", class: "INTERNAL", subscription: null }),
];

const addonFindMany = jest.fn(async () => [] as any[]);
const mrr = new MrrService({ tenantAddon: { findMany: addonFindMany } } as any);
beforeEach(() => addonFindMany.mockClear());

function fakePrisma(rows: any[]) {
  const findMany = jest.fn(async (args: any) => {
    if (args.select) return rows.slice(0, args.take ?? rows.length);
    if (args.where?.id?.in) return rows.filter((r) => args.where.id.in.includes(r.id)).reverse();
    return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length));
  });
  const count = jest.fn(async (_args?: unknown) => 2);
  return { prisma: { tenant: { findMany, count } } as any, findMany, count };
}

const base = {
  scopeWhere: {},
  orderBy: { createdAt: "desc" },
  page: 1,
  limit: 50,
  status: null,
  includeDeleted: false,
  buckets: null,
  attention: false,
  include: { _count: true },
  now: NOW,
};
const ids = (r: { tenants: Array<{ id: string }> }) => r.tenants.map((x) => x.id);

describe("parseBucketParam / assertListLimit", () => {
  it("an unknown bucket value is a 400 that names the allowed values", () => {
    expect(() => parseBucketParam("paying,nope")).toThrow(BadRequestException);
    expect(() => parseBucketParam("nope")).toThrow(/paying, trial, not_billed/);
  });
  it("a comma list, spaces, repeats and empty parts are tolerated; absent or empty is no filter", () => {
    expect(parseBucketParam(" paying , trial,paying")).toEqual(["paying", "trial"]);
    expect(parseBucketParam("")).toBeNull();
    expect(parseBucketParam(undefined)).toBeNull();
  });
  it("inherited object keys are not buckets", () => {
    expect(() => parseBucketParam("constructor")).toThrow(BadRequestException);
  });
  it("limit above the cap is a 400; the cap itself is fine", () => {
    expect(TENANT_LIST_MAX_LIMIT).toBe(200);
    expect(() => assertListLimit(201)).toThrow(BadRequestException);
    expect(() => assertListLimit(200)).not.toThrow();
  });
});

describe("listTenantsByBucket", () => {
  it("?bucket=paying returns only the paying rows (red on master: the param was ignored and every row came back)", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, { ...base, buckets: ["paying"] });
    expect(ids(r).sort()).toEqual(["p1", "p2"]);
    expect(r.meta.total).toBe(2);
  });

  it("a paying-set row with no price snapshot is Not billed with subscribed_zero, never Paying (SA-1539)", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const nb = await listTenantsByBucket(prisma, mrr, { ...base, buckets: ["not_billed"] });
    expect(ids(nb).sort()).toEqual(["n1", "z1"]);
    expect(nb.verdicts.get("z1")!.attention).toContain("subscribed_zero");
  });

  it("prices the paying-set rows in ONE add-on read, for exactly those ids", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    await listTenantsByBucket(prisma, mrr, base);
    expect(addonFindMany).toHaveBeenCalledTimes(1);
    const w = (addonFindMany.mock.calls[0] as any)[0].where;
    expect(w).toMatchObject({ active: true, isComp: false });
    expect([...w.tenantId.in].sort()).toEqual(["p1", "p2", "z1"]);
  });

  it("a test account and a real paying business are never in the same tab", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const test = await listTenantsByBucket(prisma, mrr, {
      ...base,
      buckets: ["test_demo", "internal"],
    });
    expect(ids(test).sort()).toEqual(["i1", "x1"]);
  });

  it("counts come back in the same call: one number per bucket, summing to the rows shown on All", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, base);
    const counts = r.meta.bucketCounts!;
    expect(Object.keys(counts).sort()).toEqual([...TENANT_BUCKET_VALUES].sort());
    expect(counts).toEqual({
      paying: 2,
      trial: 1,
      not_billed: 2, // n1 and z1
      paused: 1,
      // c1 is CANCELLED and c2 deleted: both PRODUCTION, both under Closed, even though All hides c2
      closed: 2,
      // x2 is a deleted test account: hidden and not counted until Show deleted is on
      test_demo: 1,
      internal: 1,
      unknown: 0,
    });
    expect(ids(r)).not.toContain("c2");
    expect(ids(r)).not.toContain("x2");
    expect(r.meta.total).toBe(9);
    expect(r.meta.truncated).toBe(false);
  });

  it("with Show deleted on, every row counts and every row is listed on All", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, { ...base, includeDeleted: true });
    const sum = Object.values(r.meta.bucketCounts!).reduce((a, b) => a + b, 0);
    expect(sum).toBe(FIXTURE.length);
    expect(r.meta.total).toBe(FIXTURE.length);
  });

  it("the Closed tab lists a deleted real-customer business without the Show deleted toggle", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, { ...base, buckets: ["closed"] });
    expect(ids(r).sort()).toEqual(["c1", "c2"]);
  });

  it("attention: attentionCount counts every business with a reason; ?attention filters whichever tab is open", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const all = await listTenantsByBucket(prisma, mrr, base);
    // p2 overdue, z1 subscribed_zero, tr1 trial_ending, c-rows none, x1/i1 none (class matches slug)
    expect(all.meta.attentionCount).toBe(3);
    const paying = await listTenantsByBucket(prisma, mrr, {
      ...base,
      buckets: ["paying"],
      attention: true,
    });
    expect(ids(paying)).toEqual(["p2"]);
    // counts ignore bucket and attention: the tabs keep their numbers while one is open
    expect(paying.meta.bucketCounts).toEqual(all.meta.bucketCounts);
    expect(paying.meta.attentionCount).toBe(3);
  });

  it("the status filter narrows the list but not the counts", async () => {
    const { prisma } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, { ...base, status: "TRIAL" });
    expect(ids(r)).toEqual(["tr1"]);
    expect(r.meta.bucketCounts!.paying).toBe(2);
  });

  it("counts respect search and plan: the scan is run with the caller's scope", async () => {
    const { prisma, findMany } = fakePrisma(FIXTURE);
    const scopeWhere = { slug: { contains: "acme", mode: "insensitive" } };
    await listTenantsByBucket(prisma, mrr, { ...base, scopeWhere });
    const scanArgs = findMany.mock.calls[0][0];
    expect(scanArgs.where).toBe(scopeWhere);
    expect(scanArgs.where).not.toHaveProperty("status");
    expect(scanArgs.where).not.toHaveProperty("deletedAt");
  });

  it("the scan is slim (id plus the helper's inputs), stably ordered (id last) and capped one past the cap", async () => {
    const { prisma, findMany } = fakePrisma(FIXTURE);
    await listTenantsByBucket(prisma, mrr, base);
    const scanArgs = findMany.mock.calls[0][0];
    expect(Object.keys(scanArgs.select).sort()).toEqual(
      [
        "class",
        "deletedAt",
        "id",
        "readOnlyReason",
        "slug",
        "status",
        "subscription",
        "trialEndsAt",
      ].sort(),
    );
    expect(Object.keys(scanArgs.select.subscription.select).sort()).toEqual(
      [
        "basePriceSnapshot",
        "cancelAtPeriodEnd",
        "couponFull",
        "discount",
        "needsReconcile",
        "pastDueSince",
        "planKey",
        "stripeCustomerId",
        "stripeSubId",
        "catchupState",
      ].sort(),
    );
    expect(scanArgs.orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
    expect(scanArgs.take).toBe(TENANT_BUCKET_SCAN_CAP + 1);
  });

  it("the page is sliced in scan order and re-ordered to it after the by-id fetch (an unordered `id in` never leaks)", async () => {
    const { prisma, findMany } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, { ...base, limit: 2, page: 2 });
    // All view, 9 visible rows in scan order: p1 p2 n1 z1 tr1 pa1 c1 x1 i1 -> page 2 = n1, z1
    expect(ids(r)).toEqual(["n1", "z1"]);
    expect(r.meta).toMatchObject({ total: 9, page: 2, limit: 2, pages: 5 });
    const fetchArgs = findMany.mock.calls[1][0];
    expect(fetchArgs.where).toEqual({ id: { in: ["n1", "z1"] } });
    expect(fetchArgs.include).toEqual({ _count: true });
  });

  it("two reads where there were three for a page (scan, page) plus the global deleted count", async () => {
    const { prisma, findMany, count } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, base);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0][0]).toEqual({ where: { deletedAt: { not: null } } });
    expect(r.meta.deletedCount).toBe(2);
  });

  it("an empty page does not fetch", async () => {
    const { prisma, findMany } = fakePrisma(FIXTURE);
    const r = await listTenantsByBucket(prisma, mrr, { ...base, buckets: ["paying"], page: 9 });
    expect(r.tenants).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  describe("above the scan cap", () => {
    const many = Array.from({ length: TENANT_BUCKET_SCAN_CAP + 1 }, (_, i) => t(`m${i}`));

    it("a bucket request is a coded 409 and nothing is paged", async () => {
      const { prisma, findMany } = fakePrisma(many);
      const err = await listTenantsByBucket(prisma, mrr, { ...base, buckets: ["paying"] }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        statusCode: 409,
        code: API_ERROR_CODES.TENANT_BUCKET_SCAN_CAP_EXCEEDED,
      });
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("an attention request is refused the same way", async () => {
      const { prisma } = fakePrisma(many);
      await expect(
        listTenantsByBucket(prisma, mrr, { ...base, attention: true }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("the plain list still pages, with null counts, truncated true and the old filters applied in the database", async () => {
      const { prisma, findMany, count } = fakePrisma(many);
      const r = await listTenantsByBucket(prisma, mrr, {
        ...base,
        limit: 2,
        page: 3,
        status: "ACTIVE",
      });
      expect(r.meta).toMatchObject({
        bucketCounts: null,
        attentionCount: null,
        truncated: true,
        page: 3,
        limit: 2,
      });
      const pageArgs = findMany.mock.calls[1][0];
      expect(pageArgs).toMatchObject({ skip: 4, take: 2 });
      expect(pageArgs.where).toEqual({ deletedAt: null, status: "ACTIVE" });
      expect(count).toHaveBeenCalledWith({ where: { deletedAt: null, status: "ACTIVE" } });
    });

    it("exactly the cap still classifies", async () => {
      const { prisma } = fakePrisma(many.slice(0, TENANT_BUCKET_SCAN_CAP));
      const r = await listTenantsByBucket(prisma, mrr, { ...base, buckets: ["paying"], limit: 1 });
      expect(r.meta.bucketCounts!.paying).toBe(TENANT_BUCKET_SCAN_CAP);
    });
  });
});

describe("tenantBucketWire", () => {
  it("returns exactly class, bucket, attention and trialDaysLeft as top-level fields", () => {
    const verdict = { bucket: "trial", attention: ["trial_ending"], trialDaysLeft: 3 } as const;
    expect(tenantBucketWire({ class: "PRODUCTION" }, verdict as any)).toEqual({
      class: "PRODUCTION",
      bucket: "trial",
      attention: ["trial_ending"],
      trialDaysLeft: 3,
    });
  });
});

describe("source pin: the list file restates no paying rule", () => {
  it("tenant-bucket-list.ts calls no isPayingRow and compares no planKey or couponFull", () => {
    const src = readFileSync(join(__dirname, "tenant-bucket-list.ts"), "utf8");
    expect(src).not.toMatch(/isPayingRow\(/);
    // the add-on filter has a name (billableAddonWhere); list code never spells isComp
    expect(src).not.toMatch(/isComp/);
    expect(src).not.toMatch(/planKey\s*(==|!=)/);
    expect(src).not.toMatch(/couponFull\s*(===|!==|==|!=)/);
  });
});

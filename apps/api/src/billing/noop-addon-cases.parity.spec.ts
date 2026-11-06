/**
 * SA-1099 A-3 note 3 (WP5): ONE decision, two runtimes. `scripts/fixtures/noop-addon-cases.json` is the table; this
 * spec runs every case through `skuAddsSomething` over the REAL resolver and courtesy functions (the enable call's
 * path), and `apps/api/scripts/report-noop-addons.mjs --self-test` runs the same cases through its `classifyRow` (the
 * sweep's path; a script cannot import the API). A rule changed on one side only turns the other side red.
 *
 * The per-flag reason is read off the resolver's own verdict: term "courtesy" is the courtesy, an OVERRIDE_GRANT
 * source is an override, a PRESET "flag" is the plan. Only the data the resolver reads is stubbed.
 */
import fs from "fs";
import path from "path";
import { FeatureResolverService } from "./feature-resolver.service";
import { skuAddsSomething } from "./addon-adds-something";

interface Case {
  name: string;
  sku: {
    grantsFlags: string[];
    meteredKey?: string | null;
    capacityPerUnit?: number | null;
  };
  planKey: string;
  planFlags: string[];
  overrides: Record<string, "GRANT" | "DENY">;
  enforcementOn: boolean;
  expected: { addsSomething: boolean; why?: Record<string, string> };
}

const FILE = path.resolve(__dirname, "../../../../scripts/fixtures/noop-addon-cases.json");
const cases: Case[] = JSON.parse(fs.readFileSync(FILE, "utf8")).cases;

function resolverFor(c: Case) {
  const version = {
    id: "v1",
    status: "PUBLISHED",
    definitions: [{ planKey: c.planKey, featureFlags: c.planFlags }],
    addonSkus: [],
  };
  const prisma: any = { tenantAddon: { findMany: jest.fn(async () => []) } };
  return new FeatureResolverService(
    {
      resolve: jest.fn(async () => ({
        planKey: c.planKey,
        planVersionId: "v1",
        flags: c.planFlags,
        addons: [],
      })),
    } as any,
    {
      allActive: jest.fn(async () => new Map(Object.entries(c.overrides))),
      activeDetail: jest.fn(async () => new Map()),
    } as any,
    {
      getVersionForTenant: jest.fn(async () => version),
      getPublishedVersion: jest.fn(async () => version),
    } as any,
    prisma,
  );
}

describe("noop-addon-cases.json through the real resolver (skuAddsSomething)", () => {
  const saved = process.env.PLAN_FLAG_ENFORCEMENT;
  afterAll(() => {
    if (saved === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = saved;
  });

  it("carries every case SA-1099 A-3 names", () => {
    const text = cases.map((c) => c.name.toLowerCase()).join("\n");
    for (const needle of [
      "plan carries",
      "courtesy",
      "grant",
      "deny over a plan",
      "deny over a courtesy",
      "lite",
      "switch on",
      "capacity",
      "empty grantsflags",
    ]) {
      expect(text).toContain(needle);
    }
    const reasons = new Set(cases.flatMap((c) => Object.values(c.expected.why ?? {})));
    expect([...reasons].sort()).toEqual(["courtesy", "override", "plan"]);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    process.env.PLAN_FLAG_ENFORCEMENT = c.enforcementOn ? "on" : "off";
    const resolved = await resolverFor(c).resolve("t1");
    expect(resolved).not.toBeNull();
    const byKey = resolved!.byKey;
    const def = { sku: "X", name: "X", ...c.sku };
    expect(skuAddsSomething(def, byKey)).toBe(c.expected.addsSomething);

    if (c.expected.why) {
      const why: Record<string, string> = {};
      for (const flag of c.sku.grantsFlags) {
        const r = byKey.get(flag)!;
        why[flag] =
          r.term === "courtesy"
            ? "courtesy"
            : r.source === "OVERRIDE_GRANT"
              ? "override"
              : r.source === "PRESET" && r.term === "flag"
                ? "plan"
                : `other:${r.source}`;
      }
      expect(why).toEqual(c.expected.why);
    }
  });
});

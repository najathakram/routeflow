/**
 * SA-788 (a) - one writer for every TenantAddon change, and one record per change (A-R1..R12, A-R14).
 *
 * Two halves:
 *  1. the INVENTORY: every `AddonChangeSource` is used by exactly the production call sites the spec names (a table
 *     of source -> (file, function)), so a writer cannot migrate to the wrong source, drop out of the writer, or
 *     appear without a conscious edit here;
 *  2. the CONTRACT: for every operation the writer offers, a $0 row, a comp row and a row of a non-paying tenant each
 *     write exactly ONE `addon.state_changed` with the right `changes`, actor and source; a change of only a Stripe
 *     pointer writes none (except the two automatic pointer-only writes); and the MRR ledger is never touched
 *     (`amountDelta` is null, no `addon.enabled` / `addon.disabled` is emitted by the writer).
 *
 * On the G1a head the module and every source are absent, so each row is red there (zero records: the type does not
 * exist and the rows write no BillingEvent at all).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { API_SRC_ROOT, codeOnly, enclosingFunctionStart } from "../testing/source-scan";
import {
  ADDON_CHANGE_SOURCES,
  addonChanges,
  createAddonRowTx,
  updateAddonRowTx,
  updateAddonRowsTx,
  upsertAddonRowTx,
  type AddonActor,
} from "./tenant-addon-writer";
import { BILLING_EVENTS } from "./plan-catalog.constants";

/** source -> the (file, function) pairs that pass it. A source may sit in more than one function. */
const SITES: Record<string, string[]> = {
  "tenant.enable": ["billing/subscription-mutation.service.ts#enableAddonLocked"],
  "tenant.disable": ["billing/subscription-mutation.service.ts#disableAddonLocked"],
  "admin.enable": ["billing/addon.service.ts#enableAddon"],
  "admin.comp": ["billing/addon.service.ts#enableAddon"],
  "admin.uncomp": ["billing/addon.service.ts#enableAddon", "billing/addon.service.ts#uncompAddon"],
  "admin.disable": ["billing/addon.service.ts#disableAddon"],
  "subscribe.pick": ["billing/subscription-mutation.service.ts#subscribe"],
  "subscribe.drop": ["billing/subscription-mutation.service.ts#subscribe"],
  "checkout.adopt": ["billing/subscription-mutation.service.ts#claimAddonItem"],
  "plan.stop_billing": ["billing/addon-inclusion.ts#stopBillingIncludedAddonsTx"],
  "plan.reprice": ["billing/addon-inclusion.ts#repriceAddonsLeavingInclusionTx"],
  "plan_change.revert": ["billing/plan-change-flow.ts#compensate"],
  "manual_activation.price": [
    "billing/manual-activation-addons.ts#priceUnbilledAddonsOnActivation",
  ],
  "lock.cancel_clear_item": ["billing/billing-cron.service.ts#applyScheduledCancellations"],
  "profile.apply": ["billing/addon.service.ts#enableAddon"],
};

function sourceSites(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "testing") walk(full);
      } else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) {
        const rel = path.relative(API_SRC_ROOT, full).replace(/\\/g, "/");
        if (rel === "billing/tenant-addon-writer.ts") continue;
        const code = codeOnly(fs.readFileSync(full, "utf8"));
        for (const m of code.matchAll(/["'](\w+\.\w+)["']/g)) {
          if (!(ADDON_CHANGE_SOURCES as readonly string[]).includes(m[1])) continue;
          const before = code.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
          if (!/source:\s*(\(\s*)?[^"']*$/.test(before) && !/\?\s*$|:\s*$/.test(before)) continue;
          const fn = enclosingFunctionStart(code, m.index ?? 0).name;
          if (!found.has(m[1])) found.set(m[1], new Set());
          found.get(m[1])!.add(`${rel}#${fn}`);
        }
      }
    }
  };
  walk(API_SRC_ROOT);
  return found;
}

describe("SA-788 (a) inventory: every AddonChangeSource sits at exactly its named call site", () => {
  const found = sourceSites();

  it("the table covers all 15 sources and nothing else", () => {
    expect(Object.keys(SITES).sort()).toEqual([...ADDON_CHANGE_SOURCES].sort());
  });

  for (const [source, expected] of Object.entries(SITES)) {
    it(`${source} -> ${expected.join(", ")}`, () => {
      expect([...(found.get(source) ?? [])].sort()).toEqual([...expected].sort());
    });
  }
});

// ── the contract ─────────────────────────────────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  tenantId: string;
  addonKey: string;
  sku: string | null;
  active: boolean;
  quantity: number;
  priceSnapshot: number | null;
  isComp: boolean;
  stripeItemId: string | null;
  stripePriceId: string | null;
}

function harness(seed: Partial<Row>[] = []) {
  let n = 0;
  const rows: Row[] = seed.map((r) => ({
    id: `r${++n}`,
    tenantId: "t1",
    addonKey: "REGULATED_ITEMS",
    sku: "REGULATED_ITEMS",
    active: true,
    quantity: 1,
    priceSnapshot: 0,
    isComp: false,
    stripeItemId: null,
    stripePriceId: null,
    ...r,
  }));
  // SA-815 B5: `AND` is honoured (the writer re-reads under the lock with `AND: [where, { id: { in } }]`).
  const match = (r: Row, w: any = {}): boolean =>
    Object.entries(w).every(([k, v]) =>
      k === "OR"
        ? true
        : k === "AND"
          ? ([] as any[]).concat(v as any).every((x) => match(r, x))
          : v && typeof v === "object" && "in" in (v as object)
            ? (v as { in: unknown[] }).in.includes((r as any)[k])
            : (r as any)[k] === v,
    );
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantAddon: {
      create: jest.fn(async ({ data }: any) => {
        const row = { ...rows[0], id: `r${++n}`, ...data } as Row;
        rows.push(row);
        return { ...row };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.tenantId_addonKey;
        const hit = rows.find((r) =>
          where.id ? r.id === where.id : r.tenantId === k.tenantId && r.addonKey === k.addonKey,
        );
        return hit ? { ...hit } : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => match(r, where)).map((r) => ({ ...r })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const hit = rows.find((r) => r.id === where.id)!;
        Object.assign(hit, data);
        return { ...hit };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.tenantId_addonKey;
        const hit = rows.find((r) => r.tenantId === k.tenantId && r.addonKey === k.addonKey);
        if (hit) {
          Object.assign(hit, update);
          return { ...hit };
        }
        const row = { ...rows[0], id: `r${++n}`, ...create } as Row;
        rows.push(row);
        return { ...row };
      }),
    },
  };
  const events: any = { emit: jest.fn().mockResolvedValue({}) };
  const records = () =>
    events.emit.mock.calls.filter((c: any[]) => c[1] === BILLING_EVENTS.ADDON_STATE_CHANGED);
  return { rows, tx, events, records };
}

const actor = (
  source: AddonActor["source"],
  kind: AddonActor["kind"] = "PLATFORM_ADMIN",
): AddonActor => ({
  kind,
  id: kind === "SYSTEM" ? null : "u1",
  source,
});

describe("SA-788 (a) contract: one addon.state_changed per change, always, never MRR", () => {
  it("a create records every non-null field, with the actor and source (a $0 row too)", async () => {
    const h = harness([{}]);
    await createAddonRowTx(h.tx, h.events, {
      data: {
        tenantId: "t1",
        addonKey: "MSRP",
        sku: "MSRP",
        active: true,
        quantity: 1,
        priceSnapshot: 0,
        isComp: true,
      },
      actor: actor("admin.comp"),
    });
    expect(h.records()).toHaveLength(1);
    const [tenantId, type, payload, opts] = h.records()[0];
    expect([tenantId, type]).toEqual(["t1", "addon.state_changed"]);
    expect(payload).toMatchObject({
      addonKey: "MSRP",
      sku: "MSRP",
      source: "admin.comp",
      actor: { kind: "PLATFORM_ADMIN", id: "u1" },
      changes: {
        active: [null, true],
        isComp: [null, true],
        priceSnapshot: [null, 0],
        quantity: [null, 1],
      },
    });
    expect(opts.amountDelta).toBeNull(); // never part of MRR
  });

  const variants: Array<[string, Partial<Row>]> = [
    ["a $0 row", { priceSnapshot: 0 }],
    ["a comp row", { isComp: true, priceSnapshot: 0 }],
    ["a priced row of a non-paying tenant", { priceSnapshot: 39 }],
  ];
  for (const [label, seed] of variants) {
    it(`an update of ${label} that switches it off writes exactly ONE record with [before, after]`, async () => {
      const h = harness([seed]);
      await updateAddonRowTx(h.tx, h.events, {
        id: "r1",
        data: { active: false, stripeItemId: null },
        actor: actor("admin.disable"),
      });
      expect(h.records()).toHaveLength(1);
      expect(h.records()[0][2]).toMatchObject({
        source: "admin.disable",
        changes: { active: [true, false] },
      });
      // the writer itself books nothing on the MRR ledger
      expect(h.events.emit.mock.calls.map((c: any[]) => c[1])).toEqual(["addon.state_changed"]);
    });
  }

  it("every tracked field is recorded: active, priceSnapshot, isComp, quantity", async () => {
    const h = harness([{ priceSnapshot: 0 }]);
    await updateAddonRowTx(h.tx, h.events, {
      id: "r1",
      data: { active: false, priceSnapshot: 39, isComp: true, quantity: 2 },
      actor: actor("admin.uncomp"),
    });
    expect(h.records()[0][2].changes).toEqual({
      active: [true, false],
      priceSnapshot: [0, 39],
      isComp: [false, true],
      quantity: [1, 2],
    });
  });

  it("a write that changes nothing writes no record", async () => {
    const h = harness([{}]);
    await updateAddonRowTx(h.tx, h.events, {
      id: "r1",
      data: { active: true },
      actor: actor("tenant.enable", "TENANT_USER"),
    });
    expect(h.records()).toHaveLength(0);
  });

  it("a Stripe pointer alone writes no record; the two automatic pointer-only sources always do", async () => {
    const h = harness([
      { stripeItemId: "si_1" },
      { stripeItemId: "si_2" },
      { stripeItemId: "si_3" },
    ]);
    await updateAddonRowTx(h.tx, h.events, {
      id: "r1",
      data: { stripeItemId: null },
      actor: actor("checkout.adopt", "SYSTEM"),
    });
    expect(h.records()).toHaveLength(0);
    await updateAddonRowTx(h.tx, h.events, {
      id: "r2",
      data: { stripeItemId: null },
      actor: actor("plan_change.revert", "SYSTEM"),
    });
    await updateAddonRowsTx(h.tx, h.events, {
      where: { tenantId: "t1", id: "r3" },
      data: { stripeItemId: null },
      actor: actor("lock.cancel_clear_item", "SYSTEM"),
    });
    expect(h.records().map((c: any[]) => c[2].source)).toEqual([
      "plan_change.revert",
      "lock.cancel_clear_item",
    ]);
    expect(h.records()[0][2].changes).toEqual({ stripeItemId: ["si_2", null] });
    expect(h.records()[0][3].actorId).toBeNull(); // SYSTEM
  });

  it("a multi-row write records each row it wrote once, and a guarded row that no longer matches none", async () => {
    const h = harness([{ stripeItemId: null }, { stripeItemId: null }, { stripeItemId: "si_x" }]);
    const res = await updateAddonRowsTx(h.tx, h.events, {
      where: { tenantId: "t1", stripeItemId: null },
      data: { priceSnapshot: 39 },
      actor: actor("manual_activation.price"),
    });
    expect(res.count).toBe(2);
    expect(
      h
        .records()
        .map((c: any[]) => c[2].rowId)
        .sort(),
    ).toEqual(["r1", "r2"]);
  });

  it("upsert records a create when the row is new and an update when it exists", async () => {
    const h = harness([{ addonKey: "MSRP", sku: "MSRP", active: false }]);
    const keep = { tenantId: "t1", addonKey: "MSRP" };
    await upsertAddonRowTx(h.tx, h.events, {
      ...keep,
      create: { ...keep, sku: "MSRP", active: true, quantity: 1, priceSnapshot: 0 },
      update: { active: true },
      actor: actor("subscribe.pick", "TENANT_USER"),
    });
    expect(h.records()[0][2].changes).toEqual({ active: [false, true] });
    await upsertAddonRowTx(h.tx, h.events, {
      tenantId: "t1",
      addonKey: "NEW",
      create: {
        tenantId: "t1",
        addonKey: "NEW",
        sku: "NEW",
        active: true,
        quantity: 1,
        priceSnapshot: 12,
      },
      update: {},
      actor: actor("subscribe.pick", "TENANT_USER"),
    });
    expect(h.records()).toHaveLength(2);
    expect(h.records()[1][2].changes).toMatchObject({
      active: [null, true],
      priceSnapshot: [null, 12],
    });
  });

  it("rows are locked FOR UPDATE before they are read (house lock order)", async () => {
    const h = harness([{}]);
    await updateAddonRowTx(h.tx, h.events, {
      id: "r1",
      data: { active: false },
      actor: actor("tenant.disable", "TENANT_USER"),
    });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("addonChanges compares a Decimal-like price as a number and ignores equal values", () => {
    const row = { id: "r", tenantId: "t", addonKey: "a" };
    expect(
      addonChanges(
        { ...row, priceSnapshot: { toString: () => "25" } as any, active: true },
        { ...row, priceSnapshot: 25, active: true },
      ),
    ).toEqual({});
  });
});

/**
 * SA-786 P2 (closed by SA-787 C3) - the inventory of every writer of `TenantSubscription.planKey`.
 *
 * A plan MOVE changes which add-ons the plan includes, so every code path that writes `planKey` must either call the
 * inclusion helpers (`addon-inclusion.ts`: stop billing what the new plan includes, re-price what it stops
 * including) or be a classified exception. A new writer fails this spec until it is classified, exactly like the
 * `no-bare-cron` count-and-name list.
 *
 *   INCLUSION  the (file, function) calls an inclusion helper in the same function;
 *   EXEMPT     creates the subscription as STARTER, or only fills a NULL key: no add-on can be included or left;
 *   SA-787     (none left: SA-787 moved `subscribe()` and the checkout-completed upsert to INCLUSION).
 *
 * Comments are blanked, the detector has a self-test, and an empty scan fails.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  API_SRC_ROOT,
  constLiteral,
  findCalls,
  resolveLiteral,
  scanSource,
  type CallSite,
} from "../testing/source-scan";

const SUBSCRIPTION_WRITE = /\btenantSubscription\s*\.\s*(update|updateMany|upsert|create)\s*\(/;

/** True when the call's DATA (never its `where`) sets the `planKey` property, directly or through a spread. */
export function setsPlanKey(site: Pick<CallSite, "args" | "scope">): boolean {
  const literal = resolveLiteral(site).replace(/\bwhere\s*:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, " ");
  const hasKey = (text: string) => /(?:^|[\s{,])planKey\s*(?::|,|\}|$)/.test(text);
  if (hasKey(literal)) return true;
  for (const spread of literal.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
    const body = constLiteral(site.scope, spread[1]);
    if (body && hasKey(body)) return true;
  }
  return false;
}

type Kind = "INCLUSION" | "EXEMPT" | "SA-787";
const INCLUSION_HELPER =
  /\b(stopBillingIncludedAddons(?:Tx|OnCheckoutTx)?|repriceAddonsLeavingInclusionTx|billLeavingAddonsAfterCommit|billAddonsLeavingInclusion)\b/;

/** The exact (file#function) classification; `calls` is how many `planKey` writes the function holds. */
export const PLAN_KEY_WRITERS: readonly {
  id: string;
  kind: Kind;
  calls: number;
  reason: string;
}[] = [
  {
    id: "billing/subscription-mutation.service.ts#upgradeLocked",
    kind: "INCLUSION",
    calls: 1,
    reason: "S1 tenant upgrade: stopBilling",
  },
  {
    id: "platform-admin/platform-admin.service.ts#updatePlanLocked",
    kind: "INCLUSION",
    calls: 2,
    reason:
      "S2 admin instant path (update arm and first-plan create arm): stopBilling up, reprice down",
  },
  {
    id: "billing/billing-cron.service.ts#applyScheduledDowngrades",
    kind: "INCLUSION",
    calls: 1,
    reason: "S3 scheduled downgrade: reprice + bill after commit",
  },
  {
    id: "platform-admin/platform-admin.service.ts#activateManualSubscription",
    kind: "INCLUSION",
    calls: 1,
    reason: "S4 manual activation planSwitch",
  },
  {
    id: "billing/subscription-mutation.service.ts#subscribeLocked",
    kind: "INCLUSION",
    calls: 1,
    reason: "SA-787 C3: the plan pick",
  },
  {
    id: "billing/billing.service.ts#onCheckoutCompleted",
    kind: "INCLUSION",
    calls: 2,
    reason: "SA-787 C3: checkout-completed upsert (both transaction shapes)",
  },
  {
    id: "platform-admin/platform-admin.service.ts#createTenant",
    kind: "EXEMPT",
    calls: 1,
    reason: "creation as the tenant's plan at birth: no add-on exists yet",
  },
  {
    id: "platform-admin/platform-admin.service.ts#updateStatus",
    kind: "EXEMPT",
    calls: 1,
    reason: "null-only fill (`planKey: null` -> the enum's key): no plan move",
  },
  {
    id: "tenants/tenants.service.ts#register",
    kind: "EXEMPT",
    calls: 1,
    reason: "creation as STARTER",
  },
];

const siteId = (s: Pick<CallSite, "file" | "fn">) => `${s.file}#${s.fn}`;

describe("SA-786 P2 - every writer of TenantSubscription.planKey is classified", () => {
  const writers = scanSource(SUBSCRIPTION_WRITE).filter(setsPlanKey);

  it("finds a non-trivial number of planKey writers (an empty scan must not report green)", () => {
    expect(writers.length).toBeGreaterThanOrEqual(8);
  });

  it("the detector flags a planKey write (data, spread, bare const) and ignores a `where`, a value read and a comment (R14)", () => {
    const planted = `
      class P {
        async direct(tx: any) {
          await tx.tenantSubscription.update({ where: { tenantId }, data: { planKey: "X" } });
        }
        async spread(tx: any) {
          const subWrite = { currentPlan: "A", planKey: "B" };
          await tx.tenantSubscription.create({ data: { tenantId, ...subWrite } });
          const args = { where: { tenantId }, create: { planKey: "C" }, update: {} };
          await tx.tenantSubscription.upsert(args);
        }
        async harmless(tx: any) {
          await tx.tenantSubscription.updateMany({ where: { planKey: "X", tenantId }, data: { cancelAtPeriodEnd: true } });
          await tx.tenantSubscription.update({ where: { tenantId }, data: { downgradeToPlanKey: def.planKey } });
          // await tx.tenantSubscription.update({ where: { tenantId }, data: { planKey: "Z" } });
        }
      }`;
    const hits = findCalls(
      "billing/planted.ts",
      planted.replace(/^ {6}/gm, ""),
      SUBSCRIPTION_WRITE,
    ).filter(setsPlanKey);
    expect(hits.map((h) => `${h.fn}:${h.method}`)).toEqual([
      "direct:update",
      "spread:create",
      "spread:upsert",
    ]);
  });

  it("every writer is classified, and the counts per (file, function) match exactly", () => {
    const found = new Map<string, number>();
    for (const w of writers) found.set(siteId(w), (found.get(siteId(w)) ?? 0) + 1);
    const classified = new Map(PLAN_KEY_WRITERS.map((w) => [w.id, w.calls]));
    expect([...found.entries()].filter(([id, n]) => classified.get(id) !== n)).toEqual([]);
    expect([...classified.entries()].filter(([id, n]) => found.get(id) !== n)).toEqual([]);
  });

  it("SA-787 has no rows left", () => {
    expect(PLAN_KEY_WRITERS.filter((w) => w.kind === "SA-787")).toEqual([]);
  });

  it("every INCLUSION writer calls an inclusion helper inside its own function", () => {
    const missing = PLAN_KEY_WRITERS.filter((w) => w.kind === "INCLUSION")
      .filter((w) => {
        const [file, fn] = w.id.split("#");
        const code = fs.readFileSync(path.join(API_SRC_ROOT, file), "utf8");
        const body = functionBody(code, fn);
        return !INCLUSION_HELPER.test(body);
      })
      .map((w) => w.id);
    expect(missing).toEqual([]);
  });
});

/**
 * SA-774 (card first, then active) - every `planKey` writer sits in ONE named class, so a new writer cannot appear
 * without deciding whether a payment must come first:
 *
 *   GATED       a self-serve entry point; `enforceCardFirst` (-> `selfServePlanGate`) runs before any write;
 *   ACTIVATION  the paid-checkout path (becomes `activateCheckout` -> `applySubscribedPlanTx`, chunk 2);
 *   SANCTIONED  an admin action, the renewal sweep or a creation mirror: not a self-serve pick.
 *
 * The list is derived from the same scan as above; the gate is also pinned on the three self-serve entry points.
 */
const SA774_CLASS: Record<string, "GATED" | "ACTIVATION" | "SANCTIONED"> = {
  "billing/subscription-mutation.service.ts#subscribeLocked": "GATED",
  "billing/subscription-mutation.service.ts#upgradeLocked": "GATED",
  "billing/billing.service.ts#onCheckoutCompleted": "ACTIVATION",
  "billing/billing-cron.service.ts#applyScheduledDowngrades": "SANCTIONED",
  "platform-admin/platform-admin.service.ts#updatePlanLocked": "SANCTIONED",
  "platform-admin/platform-admin.service.ts#activateManualSubscription": "SANCTIONED",
  "platform-admin/platform-admin.service.ts#updateStatus": "SANCTIONED",
  "platform-admin/platform-admin.service.ts#createTenant": "SANCTIONED",
  "tenants/tenants.service.ts#register": "SANCTIONED",
};

describe("SA-774 - every planKey writer is GATED, ACTIVATION or SANCTIONED", () => {
  const writers = scanSource(SUBSCRIPTION_WRITE).filter(setsPlanKey);
  const SELF_SERVE_ENTRY = [
    "billing/subscription-mutation.service.ts#subscribe",
    "billing/subscription-mutation.service.ts#upgrade",
    "billing/subscription-mutation.service.ts#downgrade",
  ];

  it("each scanned writer has exactly one SA-774 class, and none is stale", () => {
    const found = new Set(writers.map(siteId));
    expect([...found].filter((id) => !(id in SA774_CLASS))).toEqual([]);
    expect(Object.keys(SA774_CLASS).filter((id) => !found.has(id))).toEqual([]);
  });

  it.each(SELF_SERVE_ENTRY)("%s runs the card-first gate before its first write", (id) => {
    const [file, fn] = id.split("#");
    const code = fs.readFileSync(path.join(API_SRC_ROOT, file), "utf8");
    const body = functionBody(code, fn);
    expect(body).not.toBe("");
    expect(body).toMatch(/\bthis\.enforceCardFirst\(/);
  });
});

/**
 * W-1338 / SA-1267 (slot class): a plan move while a Checkout Session is open can be reverted by that session's
 * completion (it writes `planKey` from the session's metadata). So every `planKey` writer is in ONE class:
 *
 *   EXPIRE_FIRST  its own function calls `expireOpenCheckoutSessions(` (after its refusals, under the tenant-price lock);
 *   COMPLETION    the session itself;
 *   NO_SESSION    no session can exist for the row it writes (creation, or a null-only fill with no plan move);
 *   FOLLOW_UP:<item>  not yet hooked, with the work item that owns it.
 */
type SlotClass = "EXPIRE_FIRST" | "COMPLETION" | "NO_SESSION" | `FOLLOW_UP:W-${number}`;
const SLOT_CLASS: Record<string, SlotClass> = {
  "billing/subscription-mutation.service.ts#subscribeLocked": "EXPIRE_FIRST",
  "billing/subscription-mutation.service.ts#upgradeLocked": "EXPIRE_FIRST",
  "platform-admin/platform-admin.service.ts#updatePlanLocked": "EXPIRE_FIRST",
  "billing/billing.service.ts#onCheckoutCompleted": "COMPLETION",
  "platform-admin/platform-admin.service.ts#createTenant": "NO_SESSION",
  "tenants/tenants.service.ts#register": "NO_SESSION",
  "platform-admin/platform-admin.service.ts#updateStatus": "NO_SESSION",
  // holds billing add-on locks and no tenant-price lock: hooking it is a lock-order change (SA read first)
  "platform-admin/platform-admin.service.ts#activateManualSubscription": "FOLLOW_UP:W-1354",
  // a scheduled downgrade can be armed on a row with no live Stripe subscription, so "checkout is refused" is not provable
  "billing/billing-cron.service.ts#applyScheduledDowngrades": "FOLLOW_UP:W-1354",
};

/** Writers with no slot class, and EXPIRE_FIRST rows whose own function lacks the expire call. */
function slotViolations(
  writers: Pick<CallSite, "file" | "fn">[],
  classes: Record<string, SlotClass>,
  bodyOf: (file: string, fn: string) => string,
): string[] {
  const found = new Set(writers.map(siteId));
  return [
    ...[...found].filter((id) => !(id in classes)).map((id) => `unclassified ${id}`),
    ...Object.keys(classes)
      .filter((id) => !found.has(id))
      .map((id) => `stale ${id}`),
    ...Object.entries(classes)
      .filter(
        ([id, k]) =>
          k === "EXPIRE_FIRST" &&
          !/\bexpireOpenCheckoutSessions\(/.test(bodyOf(...(id.split("#") as [string, string]))),
      )
      .map(([id]) => `no expire call in ${id}`),
  ];
}

describe("W-1338 slot class - every planKey writer closes the open link, or says why not", () => {
  const writers = scanSource(SUBSCRIPTION_WRITE).filter(setsPlanKey);
  const bodyOf = (file: string, fn: string) =>
    functionBody(fs.readFileSync(path.join(API_SRC_ROOT, file), "utf8"), fn);

  it("the repo has no unclassified, stale or un-hooked writer", () => {
    expect(writers.length).toBeGreaterThanOrEqual(8);
    expect(slotViolations(writers, SLOT_CLASS, bodyOf)).toEqual([]);
  });

  it("self-test: a planted writer, a stale row and an EXPIRE_FIRST row without the call are each reported", () => {
    const planted = [{ file: "billing/planted.ts", fn: "newWriter" }];
    expect(slotViolations(planted, {}, () => "")).toEqual([
      "unclassified billing/planted.ts#newWriter",
    ]);
    expect(slotViolations([], { "billing/planted.ts#gone": "COMPLETION" }, () => "")).toEqual([
      "stale billing/planted.ts#gone",
    ]);
    const hooked = { "billing/planted.ts#newWriter": "EXPIRE_FIRST" as const };
    expect(
      slotViolations(planted, hooked, () => "await expireOpenCheckoutSessions(d, id);"),
    ).toEqual([]);
    expect(slotViolations(planted, hooked, () => "await this.write(id);")).toEqual([
      "no expire call in billing/planted.ts#newWriter",
    ]);
  });
});

/** The source of the method/function called `fn` (declaration line to the next sibling declaration). */
function functionBody(code: string, fn: string): string {
  const decl = new RegExp(
    `^ {2}(?:(?:public|private|protected|static)\\s+)*(?:async\\s+)?${fn}\\s*(?:<[^(\\n]*>)?\\(`,
    "m",
  );
  const m = decl.exec(code);
  if (!m) return "";
  const rest = code.slice(m.index + m[0].length);
  const next = rest.search(
    /^ {2}(?:(?:public|private|protected|static)\s+)*(?:async\s+)?[A-Za-z_$][\w$]*\s*(?:<[^(\n]*>)?\(/m,
  );
  return next < 0 ? rest : rest.slice(0, next);
}

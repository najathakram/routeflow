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
    id: "billing/subscription-mutation.service.ts#subscribe",
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

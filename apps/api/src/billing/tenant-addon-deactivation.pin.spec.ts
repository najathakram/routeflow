/**
 * SA-786 P1 (tightened by SA-787 C2) - the structural pin behind lesson "stopping the billing of an entitlement row
 * must not deactivate it": a `TenantAddon` row IS the tenant's entitlement (`AddonGuard` reads nothing else), so
 * NO AUTOMATIC PATH (cron, webhook, plan change, lock) may change an add-on's entitlement. The only code that may
 * write `active: false` on `tenantAddon` is a path where a person chose it:
 *   - `addon.service.ts#disableAddon`                      (the platform admin switched it off)
 *   - `subscription-mutation.service.ts#disableAddonLocked` (the tenant switched it off)
 *   - `subscription-mutation.service.ts#subscribe`          (the tenant's own pick dropped it: `toDisable`)
 * `addon-inclusion.ts` (an included add-on stops BILLING, never stops being ON) must never appear here.
 *
 * Billing state (`priceSnapshot`, `stripeItemId`) and access state (`active`) are separate fields.
 *
 * Shaped like `addon-lockheld-single-caller.sa769.spec.ts`: comments are blanked, the detector has a self-test, and
 * an empty scan fails, so a broken regex can never report green.
 */
import { scanSource, findCalls, type CallSite } from "../testing/source-scan";

const TENANT_ADDON_WRITE = /\btenantAddon\s*\.\s*(update|updateMany|upsert|create|createMany)\s*\(/;
/** SA-788: since the writer module exists, a row is switched off through one of ITS functions. */
const WRITER_CALL = /\b(updateAddonRowTx|updateAddonRowsTx|upsertAddonRowTx|createAddonRowTx)\s*\(/;
/** Every call that can write a TenantAddon row: a direct delegate write or a writer-module call. */
const addonWrites = (file: string, text: string): CallSite[] => [
  ...findCalls(file, text, TENANT_ADDON_WRITE),
  ...findCalls(file, text, WRITER_CALL),
];

/** The (file, function) pairs allowed to switch a row off: explicit human intent only. */
export const DEACTIVATION_ALLOWLIST: readonly { file: string; fn: string; reason: string }[] = [
  {
    file: "billing/addon.service.ts",
    fn: "disableAddon",
    reason: "platform admin switched it off",
  },
  {
    file: "billing/subscription-mutation.service.ts",
    fn: "disableAddonLocked",
    reason: "the tenant switched it off",
  },
  {
    file: "billing/subscription-mutation.service.ts",
    fn: "subscribe",
    reason: "the tenant's own plan pick dropped it (toDisable)",
  },
];

/** True when the call's argument text sets `active: false`. */
export function writesInactive(site: Pick<CallSite, "args">): boolean {
  return /\bactive\s*:\s*false\b/.test(site.args);
}

const key = (s: Pick<CallSite, "file" | "fn">) => `${s.file}#${s.fn}`;

describe("SA-786 P1 - no code outside the allowlist writes `active: false` on tenantAddon", () => {
  const sites = [...scanSource(TENANT_ADDON_WRITE), ...scanSource(WRITER_CALL)];
  const deactivating = sites.filter(writesInactive);

  it("walks a non-trivial number of tenantAddon writes (an empty scan must not report green)", () => {
    expect(sites.length).toBeGreaterThan(5);
    expect(deactivating.length).toBeGreaterThan(0);
  });

  it("the detector flags a planted bypass and ignores `active: true`, a comment and a read (R14)", () => {
    const planted = `
      class Bad {
        async sneaky(tx: any) {
          await tx.tenantAddon.updateMany({ where: { tenantId }, data: { active: false } });
          await updateAddonRowsTx(tx, events, { where: {}, data: { active: false }, actor });
        }
        async fine(tx: any) {
          // await tx.tenantAddon.update({ where: { id }, data: { active: false } });
          await tx.tenantAddon.update({ where: { id }, data: { active: true } });
          await updateAddonRowTx(tx, events, { id, data: { active: true }, actor });
          await tx.tenantAddon.findMany({ where: { active: false } });
        }
      }`;
    const hits = addonWrites("billing/planted.ts", planted.replace(/^ {6}/gm, ""));
    expect(hits.map((h) => `${h.fn}:${h.method}:${writesInactive(h)}`)).toEqual([
      "sneaky:updateMany:true",
      "fine:update:false",
      "sneaky:updateAddonRowsTx:true",
      "fine:updateAddonRowTx:false",
    ]);
    expect(
      hits
        .filter(writesInactive)
        .filter((h) => !DEACTIVATION_ALLOWLIST.some((a) => key(a) === key(h))),
    ).toHaveLength(2);
  });

  it("every deactivating write sits inside an allowlisted (file, function)", () => {
    const allowed = new Set(DEACTIVATION_ALLOWLIST.map(key));
    expect(
      deactivating.filter((s) => !allowed.has(key(s))).map((s) => `${key(s)}:${s.line}`),
    ).toEqual([]);
  });

  it("no allowlist entry is stale (each still matches a real write)", () => {
    const seen = new Set(deactivating.map(key));
    expect(DEACTIVATION_ALLOWLIST.filter((a) => !seen.has(key(a))).map(key)).toEqual([]);
  });

  it("addon-inclusion.ts never writes active: false (stopping billing is not switching off)", () => {
    expect(deactivating.filter((s) => s.file === "billing/addon-inclusion.ts")).toEqual([]);
  });
});

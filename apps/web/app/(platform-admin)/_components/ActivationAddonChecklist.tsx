import * as React from "react";
import type { ActivationAddonState, ManualActivationAddons } from "@routeflow/types";

const money = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

/** What an add-on row costs, in the words the admin invoices by: Off, Comp, Included (on at $0) or a monthly price. */
function stateLabel(a: ActivationAddonState): string {
  if (!a.active) return "Off";
  if (a.isComp) return "Comp";
  const price = a.priceSnapshot ?? 0;
  return price > 0 ? `On, ${money(price)} a month` : "On, Included";
}

/** Add-ons that were on before the activation and are off after it. */
export function addonsTurnedOff(addons: ManualActivationAddons): string[] {
  return addons.before
    .filter((b) => b.active)
    .filter((b) => addons.after.some((a) => a.addonKey === b.addonKey && !a.active))
    .map((b) => b.name);
}

/**
 * SA-788 (c): under the success line of a manual activation (the tenant page and the new-tenant wizard), the tenant's
 * add-ons as the activation left them, so the admin can see at the moment of the action that none was switched off.
 * The amber line shows ONLY when something that was on is now off: it is the tripwire for a regression of SA-787
 * (an activation never turns an add-on off). Renders nothing for a result without add-ons.
 */
export function ActivationAddonChecklist({
  addons,
}: {
  addons: ManualActivationAddons | null | undefined;
}) {
  if (!addons || addons.after.length === 0) return null;
  const off = addonsTurnedOff(addons);
  return (
    <div data-testid="activation-addons" className="mt-3">
      {off.length > 0 && (
        <p
          role="alert"
          data-testid="activation-addons-warning"
          className="mb-2 rounded-lg bg-amber-900/30 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-700/50"
        >
          {off.join(", ")} turned off during activation. Check before you leave this page.
        </p>
      )}
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
        Add-ons after activation
      </h4>
      <ul className="space-y-0.5 text-sm text-slate-200">
        {addons.after.map((a) => (
          <li key={a.addonKey} className="flex justify-between gap-4">
            <span>{a.name}</span>
            <span className={a.active ? "text-slate-300" : "text-slate-400"}>{stateLabel(a)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

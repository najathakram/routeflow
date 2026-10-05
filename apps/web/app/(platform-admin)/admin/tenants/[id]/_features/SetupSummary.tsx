"use client";

import * as React from "react";
import { fetchTenantFeaturesEffective } from "@/lib/platform-admin/features";
import { fetchTenantConfigValue } from "@/lib/platform-admin/business-profiles";
import { AdminCard } from "../../../../_components/AdminCard";
import { FLEET_ENABLERS, FLEET_MODULES, fulfilmentModeLabel, keyLabel } from "./setup-copy";

interface Setup {
  fulfilmentValue: string;
  counterValue: string;
  /** Serving state per fleet module; `null` when the API reported none of them. */
  fleet: Record<string, boolean> | null;
}

function counterSalesText(setup: Setup): string {
  if (setup.fulfilmentValue === "pickup" || setup.fulfilmentValue === "pickup_ship") {
    return "Always on: in-store setups have the counter";
  }
  return setup.counterValue === "on" ? "On: this business can also sell over the counter" : "Off";
}

/** Delivery set in the fulfilment model but no fleet feature on: clients fall back to today's choices. */
function fleetWarning(setup: Setup): string | null {
  const wantsDelivery = setup.fulfilmentValue === "delivery" || setup.fulfilmentValue === "both";
  if (!wantsDelivery || !setup.fleet) return null;
  if (FLEET_ENABLERS.some((k) => setup.fleet?.[k])) return null;
  const names = FLEET_ENABLERS.map(keyLabel).join(" or ");
  return `Orders are set to use delivery, but no fleet feature is on. Turn on ${names}, or change the fulfilment model.`;
}

/**
 * The Setup tab's "Current setup" card: how this tenant's orders reach customers, whether counter sales are on, and
 * which fleet modules are on, in plain English. Read-only; every value comes through the platform-admin API and
 * unknown values are described, never printed raw.
 */
export function SetupSummary({ tenantId }: { tenantId: string }) {
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(() => {
    setFailed(false);
    setSetup(null);
    Promise.all([
      fetchTenantConfigValue(tenantId, "fulfilment_model"),
      fetchTenantConfigValue(tenantId, "counter_sales"),
      fetchTenantFeaturesEffective(tenantId),
    ])
      .then(([fulfilmentValue, counterValue, effective]) => {
        const byKey = new Map((Array.isArray(effective) ? effective : []).map((f) => [f.key, f]));
        const seen = FLEET_MODULES.filter((m) => byKey.has(m.key));
        setSetup({
          fulfilmentValue,
          counterValue,
          fleet:
            seen.length === 0
              ? null
              : Object.fromEntries(FLEET_MODULES.map((m) => [m.key, !!byKey.get(m.key)?.serving])),
        });
      })
      .catch(() => setFailed(true));
  }, [tenantId]);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <AdminCard title="Current setup" className="mb-4">
      {failed ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-amber-400">
          Could not load this tenant&apos;s setup. Try again.
          <button
            type="button"
            onClick={load}
            className="rounded px-2 py-1 text-slate-300 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      ) : !setup ? (
        <p className="text-sm text-slate-400">Loading this tenant&apos;s setup...</p>
      ) : (
        <SetupBody setup={setup} />
      )}
    </AdminCard>
  );
}

function SetupBody({ setup }: { setup: Setup }) {
  const warning = fleetWarning(setup);
  const fleetOn = setup.fleet ? FLEET_ENABLERS.some((k) => setup.fleet?.[k]) : null;
  return (
    <>
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Fulfilment model
          </dt>
          <dd className="text-slate-200">{fulfilmentModeLabel(setup.fulfilmentValue)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Counter sales
          </dt>
          <dd className="text-slate-200">{counterSalesText(setup)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Fleet modules
          </dt>
          <dd className="text-slate-200">
            <p>
              Delivery fleet:{" "}
              {fleetOn === null ? "not available right now" : fleetOn ? "on" : "off"}
            </p>
            {setup.fleet && (
              <ul data-testid="setup-fleet" className="mt-1 flex flex-col gap-1">
                {FLEET_MODULES.map((m) => (
                  <li key={m.key} className="flex items-center gap-2 text-xs">
                    <span>{m.label}</span>
                    <span className={setup.fleet?.[m.key] ? "text-emerald-400" : "text-slate-400"}>
                      {setup.fleet?.[m.key] ? "On" : "Off"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      {warning && (
        <p
          role="status"
          data-testid="capability-warning"
          className="mt-3 rounded-lg bg-amber-900/30 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-600/30"
        >
          {warning}
        </p>
      )}
    </>
  );
}

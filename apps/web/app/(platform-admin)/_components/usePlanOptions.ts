"use client";

import * as React from "react";
import { PLAN_KEYS } from "@routeflow/types";
import { fetchPlanCatalog, type PlanCatalogEntry } from "@/lib/api/platform-pricing";

/**
 * B857: the ONE plan list every platform-admin plan control offers (L-167) — Create Tenant, the
 * tenant page's Change Plan and Manual Activation, and the tenants list's bulk Change Plan. A
 * hand-typed copy on the tenant page (STARTER/PROFESSIONAL/ENTERPRISE) left GROWTH unselectable
 * long after the create form went catalog-driven.
 *
 * The published catalog's rows whose planKey is a PLAN_KEYS member (the only values every admin
 * plan DTO accepts), by sortOrder. The public catalog omits invite-only plans (LITE), so they are
 * never offered here — see `withCurrentPlan` for a tenant already on one.
 */
export function selectablePlanKeys(
  plans: readonly PlanCatalogEntry[] | null | undefined,
): string[] {
  const planKeys: readonly string[] = PLAN_KEYS;
  return [...(plans ?? [])]
    .filter((p) => planKeys.includes(p.planKey))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((p) => p.planKey);
}

/**
 * Appends the tenant's own plan when the list doesn't offer it, so a select always shows — and
 * submits — the plan the tenant is really on instead of silently displaying another option.
 */
export function withCurrentPlan(
  planKeys: readonly string[],
  current: string | null | undefined,
): string[] {
  return current && !planKeys.includes(current) ? [...planKeys, current] : [...planKeys];
}

export interface PlanOptions {
  /** Plan keys to offer, in catalog order; empty while loading; PLAN_KEYS when unavailable. */
  planKeys: readonly string[];
  loading: boolean;
  /** The catalog could not be read (or had no eligible row), so planKeys fell back to PLAN_KEYS. */
  unavailable: boolean;
}

export function usePlanOptions(): PlanOptions {
  const [state, setState] = React.useState<PlanOptions>({
    planKeys: [],
    loading: true,
    unavailable: false,
  });

  React.useEffect(() => {
    let cancelled = false;
    // LITE is frozen (invite only): even the fallback never offers it.
    const fallback = {
      planKeys: PLAN_KEYS.filter((k) => k !== "LITE"),
      loading: false,
      unavailable: true,
    };
    fetchPlanCatalog()
      .then((catalog) => {
        if (cancelled) return;
        const planKeys = selectablePlanKeys(catalog?.plans);
        setState(planKeys.length ? { planKeys, loading: false, unavailable: false } : fallback);
      })
      .catch(() => {
        if (!cancelled) setState(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

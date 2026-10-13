import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { useFleetAccess } from "@/lib/api/addons";
import { useCounterSaleGate } from "@/lib/api/counter-sale";
import { useAuth } from "@/lib/auth-context";
import { useFulfilmentSettings } from "@/lib/api/fulfilment-settings";
import { useInventorySettings } from "@/lib/api/inventory-settings";
import { useInvoiceSettings } from "@/lib/api/invoices";
import { useNumberingSettings } from "@/lib/api/numbering";
import { useRouteSettings } from "@/lib/api/routes";
import { useStripeConnectStatus } from "@/lib/api/stripe-connect";
import { useUsers } from "@/lib/api/users";
import { useUnitsSettingsEnabled } from "@/lib/api/product-units";
import { buildIndex } from "./settings-index";
import {
  counterValue,
  invoicingValue,
  oversellValue,
  peopleValue,
  routeValue,
  stripeValue,
  timeZoneValue,
} from "./settings-values";

/**
 * What the hub list and the rail need: the rows this viewer can see (the same gates the pages apply today) and
 * each row's current value. Every read is an endpoint the settings screens already call (shared query keys, so
 * one GET each); a read that is loading or failed leaves its row without a value.
 */
export function useSettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const { fleet } = useFleetAccess();
  const gate = useCounterSaleGate();
  // Fulfillment is dark behind the API's FULFILMENT_SELF_SERVE: only a confirmed `selfServe: true` lists it.
  // Only the admin rail / hub asks (they are the only places a Fulfillment or Counter sales row can show).
  const selfServe = useFulfilmentSettings({ enabled: isAdmin }).data?.selfServe === true;
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
  });
  const invoice = useInvoiceSettings();
  // GET /import/numbering is admin-only (Perms PR1); an operator never asks (SA #3412 M-INT1).
  const numbering = useNumberingSettings({ enabled: isAdmin });
  const inventory = useInventorySettings();
  const route = useRouteSettings({ enabled: fleet });
  const stripe = useStripeConnectStatus();
  // "N people" = active users (a deactivated person is not on the team).
  const users = useUsers({ status: "ACTIVE" });

  const counter = gate.showButton;
  const unitsSettings = useUnitsSettingsEnabled();
  const canActAsDriver = !!(useAuth().user as { canActAsDriver?: boolean } | null)?.canActAsDriver;
  const entries = React.useMemo(
    () => buildIndex({ isAdmin, fleet, selfServe, counter, unitsSettings, canActAsDriver }),
    [isAdmin, fleet, selfServe, counter, unitsSettings, canActAsDriver],
  );
  const trailing: Record<string, string | undefined> = {
    "business-profile": timeZoneValue(settings.data),
    "user-management": peopleValue(users.data?.meta?.total),
    invoicing: invoicingValue(invoice.data, numbering.data),
    "out-of-stock-ordering": oversellValue(inventory.data),
    "route-defaults": fleet ? routeValue(route.data) : undefined,
    "card-payments": stripeValue(stripe.data),
    "counter-sales": gate.capability ? counterValue(counter) : undefined,
  };
  return { entries, trailing, fleet, counter };
}

export type SettingsNav = ReturnType<typeof useSettingsNav>;

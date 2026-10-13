"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import {
  claimCounterLanding,
  isCounterPrefAvailable,
  readOpenCounterPref,
  shouldOpenCounter,
  writeOpenCounterPref,
} from "./counter-device-pref";
import { getImpersonation } from "./impersonation";
import { COUNTER_PATH } from "./register-mode";

/** The avatar-menu checkbox state. `available` is false until storage is proven usable (and stays false when blocked). */
export function useOpenCounterPref() {
  const [available, setAvailable] = React.useState(false);
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    setAvailable(isCounterPrefAvailable());
    setOn(readOpenCounterPref());
  }, []);
  const set = React.useCallback((next: boolean) => {
    if (writeOpenCounterPref(next)) setOn(next);
  }, []);
  return { available, on, set };
}

/** Landing at exactly /dashboard with the preference on opens the counter (once per session) with a "Counter opened" toast. */
export function useCounterLanding(i: {
  pathname: string | null;
  isStaff: boolean;
  counterEnabled: boolean;
  replace: (href: string) => void;
}) {
  const { toast } = useToast();
  const { pathname, isStaff, counterEnabled, replace } = i;
  React.useEffect(() => {
    const open = shouldOpenCounter({
      pathname,
      isStaff,
      impersonating: getImpersonation() !== null,
      counterEnabled,
      pref: readOpenCounterPref(),
    });
    if (!open || !claimCounterLanding()) return;
    replace(COUNTER_PATH);
    toast({ title: "Counter opened", variant: "info" });
  }, [pathname, isStaff, counterEnabled, replace, toast]);
}

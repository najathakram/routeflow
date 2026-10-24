import { roundMoney } from "@routeflow/pricing";
import type { CounterSaleHandBack } from "@routeflow/types";

/** The counter method a stored tender method reads back as (CREDIT_CARD is CARD); anything else has no hand-back. */
const HAND_BACK_KEY: Readonly<Record<string, keyof CounterSaleHandBack>> = {
  CASH: "CASH",
  CREDIT_CARD: "CARD",
  CHECK: "CHECK",
};

/**
 * What the clerk gives back (or voids on the terminal): the PAID counter tender rows summed PER METHOD, in cents via
 * roundMoney. A PENDING row (a check not yet taken) is voided too but took no money, so it hands nothing back.
 * A method with nothing to hand back is absent, so the keys are exactly the methods the clerk acts on.
 */
export function handBackOf(
  rows: ReadonlyArray<{ method: string; status: string; amount: unknown }>,
): CounterSaleHandBack {
  const out: CounterSaleHandBack = {};
  for (const r of rows) {
    const key = HAND_BACK_KEY[r.method];
    if (!key || r.status !== "PAID") continue;
    out[key] = roundMoney((out[key] ?? 0) + Number(r.amount));
  }
  for (const key of Object.keys(out) as Array<keyof CounterSaleHandBack>) {
    if (!(out[key]! > 0)) delete out[key];
  }
  return out;
}

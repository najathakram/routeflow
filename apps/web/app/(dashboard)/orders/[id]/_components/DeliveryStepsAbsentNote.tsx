import * as React from "react";
import { DELIVERY_STEPS_ABSENT_COPY, type DeliveryStepsAbsentReason } from "@routeflow/types";

/** W-1306: why this order has no "Out for delivery" step, from the one helper `deliveryStepsAbsentReason`. */
export function DeliveryStepsAbsentNote({ reason }: { reason: DeliveryStepsAbsentReason | null }) {
  if (!reason) return null;
  return <p className="text-sm text-navy/70">{DELIVERY_STEPS_ABSENT_COPY[reason]}</p>;
}

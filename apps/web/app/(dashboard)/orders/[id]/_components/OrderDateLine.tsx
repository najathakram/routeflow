"use client";

// W-1188: what an order shows about its date. With a chosen day that differs from the day it was entered (the tenant's
// calendar, `orderDateDrift`), the header says it ONCE: "Dated Fri, Nov 6 · entered Mon, Nov 9, 4:12 PM". Otherwise the page
// keeps its plain "Created …" line and "Order date" pill. Own file: the order page is at its size ceiling.
import { Calendar } from "lucide-react";
import { orderDateDrift } from "@routeflow/pricing";
import { formatSaleDayTime } from "@/lib/counter-receipt";
import { dayLabel } from "@/lib/natural-date";
import { useTenantTimeZone } from "@/lib/tenant-timezone";
import { formatDateOnly } from "../order-detail-helpers";

interface Props {
  createdAt: string;
  orderDate?: string | null;
}

function useDatedPair({ createdAt, orderDate }: Props) {
  const zone = useTenantTimeZone();
  // The zone decides which day an instant is on: until it is known the plain lines show, never a guess in UTC.
  const drift = zone ? orderDateDrift(orderDate, createdAt, zone) : null;
  if (!drift || !zone) return null;
  const chosen = `${dayLabel(drift.day, drift.enteredDay)}${drift.direction === "FORWARD" ? " (future)" : ""}`;
  return { chosen, entered: formatSaleDayTime(createdAt, zone) };
}

export function OrderDateHeader(props: Props) {
  const pair = useDatedPair(props);
  if (pair) {
    return (
      <span
        data-testid="order-dated-line"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-navy"
      >
        <Calendar className="h-3.5 w-3.5 text-navy/40" aria-hidden />
        Dated {pair.chosen} · entered {pair.entered}
      </span>
    );
  }
  return (
    <>
      <span>
        Created{" "}
        {new Date(props.createdAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </span>
      {props.orderDate && (
        <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-surface-border bg-white px-2.5 text-xs font-medium text-navy">
          <Calendar className="h-3.5 w-3.5 text-navy/40" />
          Order date: {formatDateOnly(props.orderDate)}
        </span>
      )}
    </>
  );
}

export function OrderDateRow(props: Props) {
  const pair = useDatedPair(props);
  if (!props.orderDate) return null;
  return (
    <div
      className="flex items-center justify-between gap-3"
      data-testid={pair ? "order-dated-row" : undefined}
    >
      <dt className="text-navy/70">Order date</dt>
      <dd className="font-medium text-navy">
        {pair ? `${pair.chosen} · entered ${pair.entered}` : formatDateOnly(props.orderDate)}
      </dd>
    </div>
  );
}

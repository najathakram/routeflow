"use client";

// SA-748: the "Parked sales" list (same Modal pattern as Today's sales) and the "Park the current sale?" prompt that
// comes BEFORE a resume when the current cart still has lines. Fixed copy only: the server's message is never shown.
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Modal } from "@routeflow/ui/web";
import type { ParkedCartListItem } from "@routeflow/pricing";
import { apiClient } from "@/lib/api-client";
import { cartTotals } from "@/lib/counter-sale";
import { formatMoney } from "@/lib/format";
import {
  PARKED_EMPTY_COPY,
  PARKED_LIST_FAILED_COPY,
  PARKED_STALE_COPY,
  formatParkedTime,
  isStaleParked,
  lineCountLabel,
  parkedRowTitle,
} from "@/lib/counter-park";
import type { useParkedSales } from "./useParkedSales";

type Parked = ReturnType<typeof useParkedSales>;

function ParkedRow({
  row,
  timezone,
  taxRate,
  parked,
}: {
  row: ParkedCartListItem;
  timezone: string | null;
  /** The tenant's configured rate as a fraction (settings.taxRate / 100): the same rate the live cart totals at. */
  taxRate: number;
  parked: Parked;
}) {
  const stale = isStaleParked(row.createdAt);
  const head = parkedRowTitle(row.label, row.createdAt, timezone);
  // Row 330e: the live cart's own totals function over the stored lines' pricing inputs, never qty x price per line.
  // No price lines (an older server, or none priceable) = no total, never a $0.00.
  const total =
    row.priceLines && row.priceLines.length > 0 ? cartTotals(row.priceLines, taxRate).total : null;
  const busyHere = parked.work?.id === row.id;
  return (
    <li className="space-y-2 py-3" data-testid={`parked-row-${row.id}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 break-words font-medium">{head.title}</span>
        {head.timeShown ? null : (
          <span className="tabular-nums text-xs text-navy/70">
            {formatParkedTime(row.createdAt, timezone)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-navy/70">
          {lineCountLabel(row.lineCount)}
          {row.customerName ? ` · ${row.customerName}` : ""}
        </p>
        {total !== null ? (
          <span
            data-testid="parked-row-total"
            className="text-sm font-semibold tabular-nums text-navy"
          >
            {formatMoney(total)}
          </span>
        ) : null}
      </div>
      {stale ? <p className="text-xs text-amber-800">{PARKED_STALE_COPY}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-[44px]"
          aria-label={`Resume ${row.label}`}
          loading={busyHere && parked.work?.kind === "resume"}
          disabled={!parked.canResume}
          onClick={() => parked.startResume(row.id)}
        >
          Resume
        </Button>
        <Button
          className="min-h-[44px]"
          variant="secondary"
          aria-label={`Discard ${row.label}`}
          loading={busyHere && parked.work?.kind === "discard"}
          disabled={!parked.canResume}
          onClick={() => parked.discard(row.id)}
        >
          Discard
        </Button>
      </div>
    </li>
  );
}

export function ParkedSalesDialog({
  parked,
  openerRef,
}: {
  parked: Parked;
  openerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { data: settings } = useQuery<{ timezone?: string | null; taxRate?: number | null }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
  });
  const timezone = typeof settings?.timezone === "string" ? settings.timezone : null;
  const taxRate = (settings?.taxRate ?? 0) / 100; // percent on the wire, as the live cart reads it
  const dialogMessage = parked.message?.scope === "dialog" ? parked.message.text : null;
  const choice = "min-h-[44px]";
  return (
    <>
      <Modal
        open={parked.open}
        onClose={() => parked.setOpen(false)}
        onCloseAutoFocus={(e) => {
          if (!openerRef.current) return;
          e.preventDefault();
          openerRef.current.focus();
        }}
        closeClassName="min-h-11 min-w-11 flex items-center justify-center"
        title="Parked sales"
        scroll
        className="max-w-2xl"
      >
        <div className="space-y-3">
          {dialogMessage ? (
            <p role="alert" className="text-sm text-red-700" data-testid="parked-dialog-error">
              {dialogMessage}
            </p>
          ) : null}
          {parked.listFailed && parked.rows.length === 0 ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{PARKED_LIST_FAILED_COPY}</p>
              <Button className="min-h-11" variant="secondary" onClick={parked.retryList}>
                Retry
              </Button>
            </div>
          ) : parked.listLoading ? (
            <p role="status" className="text-sm text-navy/70">
              Loading parked sales
            </p>
          ) : parked.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-navy/70">{PARKED_EMPTY_COPY}</p>
          ) : (
            <ul className="divide-y" aria-label="Parked sales">
              {parked.rows.map((r) => (
                <ParkedRow
                  key={r.id}
                  row={r}
                  timezone={timezone}
                  taxRate={taxRate}
                  parked={parked}
                />
              ))}
            </ul>
          )}
        </div>
      </Modal>
      <Modal
        open={parked.prompt !== null}
        onClose={() => parked.choose("cancel")}
        title="Park the current sale?"
        description="The sale on the screen has items. Park it to come back to it, or discard it."
        className="max-w-[calc(100vw-2rem)] sm:max-w-md"
      >
        <div className="flex flex-wrap gap-2">
          <Button className={choice} onClick={() => parked.choose("park")}>
            Park it
          </Button>
          <Button className={choice} variant="secondary" onClick={() => parked.choose("discard")}>
            Discard it
          </Button>
          <Button className={choice} variant="secondary" onClick={() => parked.choose("cancel")}>
            Cancel
          </Button>
        </div>
      </Modal>
    </>
  );
}

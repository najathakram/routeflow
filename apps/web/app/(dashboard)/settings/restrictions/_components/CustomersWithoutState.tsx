"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { US_STATES } from "@routeflow/types";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { ReadOnlyHint, useReadOnlyGate } from "@/lib/read-only-gate";
import {
  fetchBucketPage,
  undoBulkStateRequest,
  useBulkSetState,
  useCreateMinimalAddress,
  useRefreshUnknownState,
  useSetAddressState,
  useUnknownStateBuckets,
} from "@/lib/api/unknown-state";
import { stateLabel } from "@/lib/portal-limits";
import {
  BULK_MAX,
  BULK_UNDO_MS,
  BUCKET_KEYS,
  SAVED_MS,
  SAVE_FAILED,
  bucketAction,
  bucketLine,
  bulkConfirmLine,
  bulkDoneTitle,
  headerLine,
  remaining,
  visibleRows,
  weReadLine,
  type BucketKey,
  type UnknownStateRow,
} from "@/lib/unknown-state";
import { AddFullAddressSheet } from "./AddFullAddressSheet";

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The 51 states as "TX — Texas" options (a native select: typing "tex" jumps to Texas). */
function StateSelect({
  value,
  onChange,
  label,
  fieldRef,
  onEnter,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  fieldRef?: React.Ref<HTMLSelectElement>;
  onEnter?: () => void;
  error?: boolean;
}) {
  return (
    <select
      ref={fieldRef}
      data-row-field
      aria-label={label}
      aria-invalid={error || undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
      }}
      className="h-9 min-w-[10rem] rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
    >
      <option value="">State…</option>
      {US_STATES.map((s) => (
        <option key={s.code} value={s.code}>
          {s.code} — {s.name}
        </option>
      ))}
    </select>
  );
}

type RowStatus = "idle" | "saving" | "saved" | "leaving";

/**
 * One customer to fix. The row confirms inline (`Saved`, 1.2 s), then collapses over 200 ms (not at all under
 * reduced motion) and asks the list to drop it; an error keeps the row and the input with the message under the field.
 */
function StateRow({
  bucket,
  row,
  canFix,
  onAdvance,
  onBusy,
  onSaved,
  onAddFull,
}: {
  bucket: BucketKey;
  row: UnknownStateRow;
  canFix: boolean;
  /** The save landed: move focus to the next row now, before this one finishes leaving. */
  onAdvance: (row: UnknownStateRow) => void;
  /** Whether this row has a save in flight or confirmed (a bulk set must not touch it). */
  onBusy: (id: string, busy: boolean) => void;
  onSaved: (row: UnknownStateRow) => void;
  onAddFull: (row: UnknownStateRow) => void;
}) {
  const setState = useSetAddressState();
  const minimal = useCreateMinimalAddress();
  const [value, setValue] = React.useState(row.suggestedState ?? "");
  const [zip, setZip] = React.useState("");
  const [status, setStatus] = React.useState<RowStatus>("idle");
  const [error, setError] = React.useState(false);
  const [changing, setChanging] = React.useState(false);
  const field = React.useRef<HTMLSelectElement>(null);

  React.useEffect(() => {
    onBusy(row.customerId, status !== "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report status changes only
  }, [status]);

  const done = () => {
    setStatus("saved");
    onAdvance(row);
    window.setTimeout(() => {
      if (reducedMotion()) return onSaved(row);
      setStatus("leaving");
      window.setTimeout(() => onSaved(row), 200);
    }, SAVED_MS);
  };
  const fail = () => {
    setStatus("idle");
    setError(true);
  };
  const save = (confirm = false, state = value) => {
    if (!state || status !== "idle") return;
    setError(false);
    setStatus("saving");
    if (bucket === "noAddress") {
      minimal.mutate(
        { customerId: row.customerId, state, ...(zip.trim() ? { zip: zip.trim() } : {}) },
        { onSuccess: done, onError: fail },
      );
    } else if (row.addressId) {
      setState.mutate(
        {
          customerId: row.customerId,
          addressId: row.addressId,
          state,
          ...(bucket === "needsReview" || confirm ? { confirmReview: true } : {}),
        },
        { onSuccess: done, onError: fail },
      );
    }
  };

  const busy = status !== "idle";
  const label = `State for ${row.name}`;
  return (
    <li
      data-testid={`state-row-${row.customerId}`}
      data-state-row
      className={`flex max-h-40 flex-wrap items-start gap-x-3 gap-y-2 overflow-hidden px-3 py-2.5 transition-all duration-200 motion-reduce:transition-none ${
        status === "leaving" ? "max-h-0 py-0 opacity-0" : ""
      }`}
    >
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-sm font-medium text-navy">{row.name}</p>
        {bucket === "unusableState" && row.addressText && (
          <p className="truncate text-xs text-navy/60">{row.addressText}</p>
        )}
        {bucket === "needsReview" && row.suggestedState && (
          <p className="text-xs text-navy/70">{weReadLine(row.suggestedState, row.addressText)}</p>
        )}
      </div>

      {status === "saved" || status === "leaving" ? (
        <span role="status" className="inline-flex items-center gap-1 text-sm text-success">
          <Check className="h-4 w-4" aria-hidden /> Saved
        </span>
      ) : !canFix ? null : bucket === "needsReview" && !changing ? (
        <span className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            data-row-field
            loading={status === "saving"}
            disabled={busy || !row.suggestedState}
            onClick={() => save(true, row.suggestedState ?? "")}
          >
            Looks right
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setChanging(true)}>
            Change
          </Button>
          {error && (
            <p role="alert" className="w-full text-xs text-navy">
              {SAVE_FAILED}
            </p>
          )}
        </span>
      ) : (
        <div className="flex flex-wrap items-start gap-2">
          <div>
            <StateSelect
              value={value}
              onChange={setValue}
              label={label}
              fieldRef={field}
              onEnter={() => save()}
              error={error}
            />
            {error && (
              <p role="alert" className="mt-1 text-xs text-navy">
                {SAVE_FAILED}
              </p>
            )}
          </div>
          {bucket === "noAddress" && (
            <input
              aria-label={`ZIP for ${row.name}`}
              placeholder="ZIP"
              inputMode="numeric"
              maxLength={10}
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
              }}
              className="h-9 w-24 rounded border border-surface-border px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          )}
          <Button
            size="sm"
            loading={status === "saving"}
            disabled={!value || busy}
            onClick={() => save()}
          >
            Save
          </Button>
          {bucket === "noAddress" && (
            <button
              type="button"
              className="h-9 text-xs font-medium text-brand-600 hover:underline"
              onClick={() => onAddFull(row)}
            >
              Add full address
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** One bucket's inline list: 20 per page with Show more, and one state for every row shown. */
function BucketList({
  bucket,
  canFix,
  first,
  removed,
  onRemoved,
  onUndone,
  onAddFull,
}: {
  bucket: BucketKey;
  canFix: boolean;
  first: { rows: UnknownStateRow[]; nextCursor: string | null };
  removed: ReadonlySet<string>;
  onRemoved: (ids: string[]) => void;
  /** After a bulk Undo: the card (which outlives this list) re-reads the server. */
  onUndone: () => void;
  onAddFull: (row: UnknownStateRow) => void;
}) {
  const { toast } = useToast();
  const bulk = useBulkSetState();
  const busyIds = React.useRef(new Set<string>());
  const setBusy = React.useCallback((id: string, busy: boolean) => {
    if (busy) busyIds.current.add(id);
    else busyIds.current.delete(id);
  }, []);
  const [extra, setExtra] = React.useState<UnknownStateRow[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(first.nextCursor);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkState, setBulkState] = React.useState("");
  const [bulkError, setBulkError] = React.useState(false);
  const listRef = React.useRef<HTMLUListElement>(null);

  const rows = visibleRows([...first.rows, ...extra], removed);

  const showMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await fetchBucketPage(bucket, cursor);
      setExtra((e) => [...e, ...next.rows]);
      setCursor(next.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  // Enter saves and focus jumps to the next row's field at once (the saved row keeps showing "Saved" for a moment).
  const advance = (row: UnknownStateRow) => {
    const idx = rows.findIndex((r) => r.customerId === row.customerId);
    const next = rows[idx + 1] ?? rows[idx - 1];
    if (!next) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-testid="state-row-${next.customerId}"] [data-row-field]`)
      ?.focus();
  };
  const saved = (row: UnknownStateRow) => onRemoved([row.customerId]);

  const runBulk = () => {
    if (!bulkState) return;
    setBulkError(false);
    const ids = rows
      .filter((r) => !busyIds.current.has(r.customerId))
      .slice(0, BULK_MAX)
      .map((r) => r.customerId);
    bulk.mutate(
      { bucket, customerIds: ids, state: bulkState },
      {
        onSuccess: (res) => {
          setBulkOpen(false);
          onRemoved(ids);
          toast({
            title: bulkDoneTitle(res.changed, stateLabel(bulkState)),
            variant: "success",
            duration: BULK_UNDO_MS,
            action: {
              label: "Undo",
              // a plain call: this list is gone once its bucket empties, the card is not
              onClick: () => {
                undoBulkStateRequest({ changedAddressIds: res.changedAddressIds })
                  .then(onUndone)
                  .catch(() =>
                    toast({ title: "Couldn't undo. Nothing was changed.", variant: "error" }),
                  );
              },
            },
          });
        },
        onError: () => setBulkError(true),
      },
    );
  };

  return (
    <div className="border-t border-warning/30">
      {canFix && rows.length > 0 && (
        <div className="flex justify-end px-3 pt-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setBulkState("");
              setBulkError(false);
              setBulkOpen(true);
            }}
          >
            Set state for all shown…
          </Button>
        </div>
      )}
      <ul ref={listRef} className="divide-y divide-warning/20" aria-label="Customers to fix">
        {rows.map((r) => (
          <StateRow
            key={r.customerId}
            bucket={bucket}
            row={r}
            canFix={canFix}
            onAdvance={advance}
            onBusy={setBusy}
            onSaved={saved}
            onAddFull={onAddFull}
          />
        ))}
      </ul>
      {cursor && (
        <div className="px-3 pb-3">
          <Button size="sm" variant="secondary" loading={loadingMore} onClick={showMore}>
            Show more
          </Button>
        </div>
      )}
      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title="Set state for all shown">
        <div className="space-y-4">
          <label className="block text-sm font-medium text-navy">
            State
            <div className="mt-1">
              <StateSelect value={bulkState} onChange={setBulkState} label="State" />
            </div>
          </label>
          {bulkState && (
            <p className="text-sm text-navy">
              {bulkConfirmLine(
                Math.min(rows.filter((r) => !busyIds.current.has(r.customerId)).length, BULK_MAX),
                stateLabel(bulkState),
              )}
            </p>
          )}
          {bulkError && (
            <p role="alert" className="text-sm text-navy">
              {SAVE_FAILED}
            </p>
          )}
          <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
            <Button variant="secondary" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!bulkState} loading={bulk.isPending} onClick={runBulk}>
              Set state
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * "Customers without a state on file" (Addendum D): readiness as advice, fixed in place. Amber, never red; the card
 * loads its own data (no Check readiness gate) and rows leave the list as they are saved.
 */
export function CustomersWithoutState({ canFix }: { canFix: boolean }) {
  const buckets = useUnknownStateBuckets();
  const refresh = useRefreshUnknownState();
  const gate = useReadOnlyGate();
  const fixable = canFix && !gate.readOnly;
  const [open, setOpen] = React.useState<BucketKey | null>(null);
  const [removed, setRemoved] = React.useState<Record<BucketKey, Set<string>>>({
    noAddress: new Set(),
    unusableState: new Set(),
    needsReview: new Set(),
  });
  const [sheetRow, setSheetRow] = React.useState<{
    bucket: BucketKey;
    row: UnknownStateRow;
  } | null>(null);

  const markRemoved = (bucket: BucketKey) => (ids: string[]) =>
    setRemoved((prev) => ({ ...prev, [bucket]: new Set([...prev[bucket], ...ids]) }));

  // The server read is the truth: whenever fresh data lands (Refresh, an Undo, another save elsewhere) the rows
  // saved here are already in it, so forget them rather than subtract them twice.
  React.useEffect(() => {
    setRemoved({ noAddress: new Set(), unusableState: new Set(), needsReview: new Set() });
  }, [buckets.dataUpdatedAt]);

  // a body that is not the three buckets (an old API) is treated as an unreadable list, never a crash
  const data = buckets.data?.noAddress ? buckets.data : undefined;
  const counts = data
    ? (Object.fromEntries(
        BUCKET_KEYS.map((k) => [k, remaining(data[k].total, removed[k].size)]),
      ) as Record<BucketKey, number>)
    : null;
  const total = counts ? counts.noAddress + counts.unusableState + counts.needsReview : 0;

  return (
    <section
      id="customers-without-state"
      data-testid="customers-without-state"
      className="rounded-xl border border-warning/40 bg-warning/10 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-navy">Customers without a state on file</h3>
          {buckets.isLoading && <p className="mt-1 text-sm text-navy/70">Loading…</p>}
          {(buckets.isError || (buckets.data && !data)) && (
            <p role="alert" className="mt-1 text-sm text-navy">
              Couldn&apos;t load this list. Refresh to try again.
            </p>
          )}
          {counts && (
            <p className="mt-1 text-sm text-navy" aria-live="polite">
              {total === 0 && <Check className="mr-1 inline h-4 w-4 text-success" aria-hidden />}
              {headerLine(total)}
            </p>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 text-xs font-medium text-brand-600 hover:underline"
          onClick={() => refresh()}
        >
          Refresh
        </button>
      </div>

      {gate.readOnly && <ReadOnlyHint className="mt-3" />}

      {data && counts && (
        <ul className="mt-3 space-y-2">
          {BUCKET_KEYS.filter((k) => counts[k] > 0).map((k) => (
            <li key={k} className="rounded-lg border border-warning/30 bg-white">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 text-left text-sm text-navy"
                  aria-expanded={open === k}
                  onClick={() => setOpen(open === k ? null : k)}
                >
                  {open === k ? (
                    <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                  )}
                  <span>{bucketLine(k, counts[k])}</span>
                </button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setOpen(open === k ? null : k)}
                >
                  {bucketAction(k)}
                </Button>
              </div>
              {open === k && (
                <BucketList
                  key={`${k}-${buckets.dataUpdatedAt}`}
                  bucket={k}
                  canFix={fixable}
                  first={data[k]}
                  removed={removed[k]}
                  onRemoved={markRemoved(k)}
                  onUndone={refresh}
                  onAddFull={(row) => setSheetRow({ bucket: k, row })}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <AddFullAddressSheet
        customer={sheetRow ? { id: sheetRow.row.customerId, name: sheetRow.row.name } : null}
        onClose={() => setSheetRow(null)}
        onSaved={() => {
          if (sheetRow) markRemoved(sheetRow.bucket)([sheetRow.row.customerId]);
          setSheetRow(null);
        }}
      />
    </section>
  );
}

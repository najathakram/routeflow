"use client";

import * as React from "react";
import NextLink from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Button, Modal, Skeleton, useToast } from "@routeflow/ui/web";
import { unitNameKey } from "@routeflow/types";
import { usePageTitle } from "@/lib/page-title-context";
import { MORE_UNIT_CHIPS, UNIT_CHIPS } from "@/lib/common-units";
import { useUnitsFlag } from "@/lib/api/product-units";
import {
  checkUnitName,
  normalizeUnitName,
  unitErrorMessage,
  useCreateTenantUnit,
  useTenantUnits,
  useUpdateTenantUnit,
  type TenantUnitDto,
} from "@/lib/api/tenant-units";

// Errors are shown inline under the field. The mutations opt out of the global error toast
// (meta.localErrorToast), so nothing here toasts a failure (B594).
const ok = (title: string, extra: { description?: string; duration?: number } = {}) => ({
  title,
  variant: "success" as const,
  ...extra,
});

const OFFLINE = "You're offline. Reconnect to change units.";
const CHIPS_COLLAPSE_AT = 8;
const SEARCH_ABOVE = 8;

const textBtn =
  "inline-flex min-h-[32px] items-center rounded-md px-2 text-sm font-medium text-navy/70 transition-colors duration-200 hover:bg-surface-raised hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 motion-reduce:transition-none";
const fieldCls =
  "h-11 w-full rounded border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 sm:h-10";

const key = unitNameKey;
const usedBy = (n: number) =>
  n === 0 ? "Not used yet" : `Used by ${n} ${n === 1 ? "product" : "products"}`;

function useOnline(): boolean {
  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

/**
 * Ships DARK behind `flag.units_v1` (granted per tenant once its unit backfill ran): without the flag
 * the API refuses every call, so the screen is never mounted and the units query is never sent.
 */
export default function UnitsPage() {
  const { enabled, isLoading } = useUnitsFlag();
  if (isLoading) return null;
  if (!enabled) {
    return <p className="text-sm text-navy/70">Units are not available on your account yet.</p>;
  }
  return <UnitsScreen />;
}

function UnitsScreen() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Units");
  }, [setTitle]);
  const { toast } = useToast();
  const online = useOnline();
  const { data, isLoading, isError, refetch } = useTenantUnits();
  const create = useCreateTenantUnit();
  const update = useUpdateTenantUnit();

  const units = React.useMemo(() => data ?? [], [data]);
  const active = units.filter((u) => !u.archivedAt);
  const archived = units.filter((u) => u.archivedAt);

  const addRef = React.useRef<HTMLInputElement>(null);
  const [name, setName] = React.useState("");
  const [addError, setAddError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [showChips, setShowChips] = React.useState(false);
  const [showMore, setShowMore] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameError, setRenameError] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<{ id: string; message: string } | null>(null);
  const [confirming, setConfirming] = React.useState<TenantUnitDto | null>(null);
  const [sheet, setSheet] = React.useState<TenantUnitDto | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const focusAfter = React.useRef<string | null>(null);
  const lastEdit = React.useRef<string | null>(null);

  const isEmpty = !isLoading && !isError && units.length === 0;
  React.useEffect(() => {
    if (isEmpty) addRef.current?.focus();
  }, [isEmpty]);

  // After an archive, focus moves to the next row (or the add field when it was the last one).
  React.useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    const el =
      id === "add"
        ? addRef.current
        : document.querySelector<HTMLElement>(`[data-unit-id="${id}"] button`);
    el?.focus();
  }, [units]);

  const q = key(query);
  const shownActive = q ? active.filter((u) => key(u.name).includes(q)) : active;
  const shownArchived = q ? archived.filter((u) => key(u.name).includes(q)) : archived;

  const addUnit = (raw: string, exact = false) => {
    if (!online) return;
    const clean = exact ? raw.trim() : normalizeUnitName(raw);
    const problem = checkUnitName(clean, units);
    if (problem) {
      setAddError(problem);
      return;
    }
    const restored = archived.find((u) => key(u.name) === key(clean));
    create.mutate(
      { name: clean },
      {
        onSuccess: () => {
          setName("");
          setQuery("");
          setAddError(null);
          toast(ok(restored ? `Restored ${restored.name}.` : `Added ${clean}`));
          addRef.current?.focus();
        },
        onError: (e) => setAddError(unitErrorMessage(e, clean)),
      },
    );
  };

  const startRename = (u: TenantUnitDto) => {
    setRenamingId(u.id);
    setRenameValue(u.name);
    setRenameError(null);
  };
  const stopRename = () => {
    setRenamingId(null);
    setRenameError(null);
  };

  const saveRename = (u: TenantUnitDto, raw: string, done: () => void) => {
    if (!online) return;
    const clean = normalizeUnitName(raw);
    if (clean === u.name) {
      done();
      return;
    }
    const problem = checkUnitName(
      clean,
      units.filter((x) => x.id !== u.id),
    );
    if (problem) {
      setRenameError(problem);
      return;
    }
    update.mutate(
      { id: u.id, name: clean },
      {
        onSuccess: (res) => {
          done();
          const n = res.productsUpdated;
          toast(
            ok(`Renamed to ${clean}.`, {
              ...(n > 0
                ? { description: `Updated ${n} ${n === 1 ? "product" : "products"}.` }
                : {}),
            }),
          );
        },
        onError: (e) => setRenameError(unitErrorMessage(e, clean)),
      },
    );
  };

  const restore = (u: TenantUnitDto) => {
    if (!online) return;
    setRowError(null);
    update.mutate(
      { id: u.id, archived: false },
      {
        onSuccess: () => toast(ok(`Restored ${u.name}.`)),
        onError: (e) => setRowError({ id: u.id, message: unitErrorMessage(e, u.name) }),
      },
    );
  };

  const doArchive = (u: TenantUnitDto) => {
    if (!online) return;
    setRowError(null);
    const idx = shownActive.findIndex((x) => x.id === u.id);
    const next = shownActive[idx + 1] ?? shownActive[idx - 1];
    update.mutate(
      { id: u.id, archived: true },
      {
        onSuccess: () => {
          focusAfter.current = next?.id ?? "add";
          toast({
            ...ok(`Archived ${u.name}.`, { duration: 6000 }),
            action: { label: "Undo", onClick: () => restore(u) },
          });
        },
        onError: (e) => setRowError({ id: u.id, message: unitErrorMessage(e, u.name) }),
      },
    );
  };

  const archive = (u: TenantUnitDto) => {
    if (u.productCount > 0) setConfirming(u);
    else doArchive(u);
  };

  // Chips: the first-run subset minus names already in the list (archived ones included).
  const listed = new Set(units.map((u) => key(u.name)));
  const chips = UNIT_CHIPS.filter((c) => !listed.has(key(c)));
  const moreChips = MORE_UNIT_CHIPS.filter((c) => !listed.has(key(c)));
  const collapsed = active.length >= CHIPS_COLLAPSE_AT;
  const chipsOpen = !collapsed || showChips;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 lg:mx-0">
      <NextLink
        href="/settings"
        className="mb-4 inline-flex min-h-[32px] items-center gap-1.5 text-sm font-medium text-navy/60 transition-colors hover:text-brand-600"
      >
        <ArrowLeft className="h-4 w-4" /> All settings
      </NextLink>
      <h2 className="text-2xl font-bold text-navy">Units</h2>
      <p className="mb-5 mt-1 text-sm text-navy/70">
        The names you sell and stock by, like Case, Box or Bottle. Products pick from this list.
      </p>

      {!online && (
        <p role="status" className="mb-3 rounded-md bg-warning-bg px-3 py-2 text-sm text-navy">
          {OFFLINE}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          addUnit(name);
        }}
        className="mb-2"
        noValidate
      >
        <div className="flex items-start gap-2">
          <input
            ref={addRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setAddError(null);
            }}
            aria-label="Unit name"
            placeholder="e.g. Case"
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? "unit-add-error" : undefined}
            autoComplete="off"
            className={`${fieldCls} ${addError ? "border-danger" : "border-surface-border"}`}
          />
          <Button
            type="submit"
            leftIcon={<Plus className="h-4 w-4" />}
            loading={create.isPending}
            disabled={!online}
            className="h-11 shrink-0 sm:h-10"
          >
            Add
          </Button>
        </div>
        {addError && (
          <p id="unit-add-error" role="alert" className="mt-1.5 text-sm text-danger">
            {addError}
          </p>
        )}
      </form>

      {(chips.length > 0 || moreChips.length > 0) && (
        <div className="mb-5">
          {collapsed ? (
            <button
              type="button"
              aria-expanded={showChips}
              aria-controls="unit-chips"
              onClick={() => setShowChips((v) => !v)}
              className={`${textBtn} -ml-2`}
            >
              {showChips ? (
                <ChevronDown className="mr-1 h-4 w-4" />
              ) : (
                <ChevronRight className="mr-1 h-4 w-4" />
              )}
              Common units
            </button>
          ) : (
            <span className="text-xs text-navy/60">Common units:</span>
          )}
          {chipsOpen && (
            <div
              id="unit-chips"
              className="mt-1.5 flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible"
            >
              {[...chips, ...(showMore ? moreChips : [])].map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Add ${c}`}
                  disabled={!online}
                  onClick={() => addUnit(c, true)}
                  className="inline-flex h-11 shrink-0 items-center gap-1 rounded-full border border-surface-border bg-white px-3 text-sm font-medium text-brand-600 transition-colors duration-200 hover:border-brand-400 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 motion-reduce:transition-none sm:h-8"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {c}
                </button>
              ))}
              {!showMore && moreChips.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowMore(true)}
                  className="inline-flex h-11 shrink-0 items-center rounded-full px-3 text-sm font-medium text-navy/70 hover:bg-surface-raised sm:h-8"
                >
                  More
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {active.length > SEARCH_ABOVE && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search units"
          aria-label="Search units"
          className={`${fieldCls} mb-3 border-surface-border`}
        />
      )}

      {isLoading ? (
        <ul
          aria-label="Loading units"
          className="divide-y divide-surface-border rounded-xl border border-surface-border bg-white"
        >
          {Array.from({ length: 5 }, (_, i) => (
            <li
              key={i}
              data-testid="units-skeleton-row"
              className="flex items-center gap-3 px-4 py-4"
            >
              <Skeleton width={120} height={14} />
              <Skeleton width={90} height={12} />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-6 text-center text-sm text-danger">
          <p>Couldn&apos;t load your units. Try again</p>
          <Button variant="secondary" className="mt-3" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : isEmpty ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 px-4 py-8 text-center">
          <h3 className="text-base font-semibold text-navy">No units yet</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-navy/70">
            Add the words you sell and stock by, like Case, Box or Bottle. Products without units
            keep selling by the piece.
          </p>
        </div>
      ) : (
        <>
          {shownActive.length > 0 && (
            <ul
              aria-label="Your units"
              className="divide-y divide-surface-border rounded-xl border border-surface-border bg-white"
            >
              {shownActive.map((u) => (
                <UnitRow
                  key={u.id}
                  unit={u}
                  online={online}
                  renaming={renamingId === u.id}
                  renameValue={renameValue}
                  renameError={renamingId === u.id ? renameError : null}
                  rowError={rowError?.id === u.id ? rowError.message : null}
                  saving={update.isPending}
                  onRenameValue={(v) => {
                    setRenameValue(v);
                    setRenameError(null);
                  }}
                  onStartRename={() => startRename(u)}
                  onCancelRename={stopRename}
                  onSaveRename={() => saveRename(u, renameValue, stopRename)}
                  onArchive={() => archive(u)}
                  onEdit={() => {
                    setRenameValue(u.name);
                    setRenameError(null);
                    lastEdit.current = u.id;
                    setSheet(u);
                  }}
                />
              ))}
            </ul>
          )}
          {q && shownActive.length === 0 && shownArchived.length === 0 && (
            <div className="rounded-xl border border-dashed border-surface-border px-4 py-6 text-center text-sm text-navy/70">
              <p>No unit named &quot;{query.trim()}&quot;. Add it?</p>
              <Button
                variant="secondary"
                className="mt-3"
                disabled={!online}
                onClick={() => addUnit(query)}
              >
                Add &quot;{query.trim()}&quot;
              </Button>
            </div>
          )}
          <p className="mt-3 text-sm text-navy/70">Piece is always there as the smallest unit.</p>

          {archived.length > 0 && (
            <div className="mt-5">
              <button
                type="button"
                aria-expanded={showArchived}
                aria-controls="archived-units"
                onClick={() => setShowArchived((v) => !v)}
                className={`${textBtn} -ml-2 min-h-[44px] sm:min-h-[32px]`}
              >
                {showArchived ? (
                  <ChevronDown className="mr-1 h-4 w-4" />
                ) : (
                  <ChevronRight className="mr-1 h-4 w-4" />
                )}
                Archived ({archived.length})
              </button>
              {showArchived && (
                <ul
                  id="archived-units"
                  className="mt-1 divide-y divide-surface-border rounded-xl border border-surface-border bg-white"
                >
                  {shownArchived.map((u) => (
                    <li
                      key={u.id}
                      data-unit-id={u.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-navy/70">
                        {u.name}
                      </span>
                      <span className="text-xs text-navy/70">{usedBy(u.productCount)}</span>
                      <button
                        type="button"
                        className={`${textBtn} min-h-[44px] sm:min-h-[32px]`}
                        disabled={!online}
                        onClick={() => restore(u)}
                      >
                        Restore
                      </button>
                      {rowError?.id === u.id && (
                        <p role="alert" className="basis-full text-sm text-danger">
                          {rowError.message}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="mt-5 text-xs text-navy/60">
            Units are archived, never deleted, so old orders and invoices keep their words.
          </p>
        </>
      )}

      {/* Archiving a unit that products use asks first. Cancel has focus; the confirm is not red. */}
      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? `Archive ${confirming.name}?` : undefined}
        description={confirming ? archiveBody(confirming.productCount) : undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        footer={
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const u = confirming;
                setConfirming(null);
                if (u) doArchive(u);
              }}
            >
              Archive
            </Button>
          </>
        }
      >
        {null}
      </Modal>

      {/* Small screens: one Edit button per row opens this bottom sheet (rename / archive). */}
      <Dialog.Root open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              const id = lastEdit.current;
              if (id)
                document.querySelector<HTMLElement>(`[data-unit-id="${id}"] [data-edit]`)?.focus();
            }}
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-xl bg-white p-5 pb-8 shadow-modal transition-transform duration-200 motion-reduce:transition-none"
          >
            {sheet && (
              <SheetBody
                unit={sheet}
                online={online}
                value={renameValue}
                error={renameError}
                saving={update.isPending}
                onValue={(v) => {
                  setRenameValue(v);
                  setRenameError(null);
                }}
                onSave={() => saveRename(sheet, renameValue, () => setSheet(null))}
                onArchive={() => {
                  const u = sheet;
                  setSheet(null);
                  archive(u);
                }}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function archiveBody(n: number): string {
  const lead =
    n === 1
      ? "1 product uses it. It keeps it and it still shows on its orders."
      : `${n} products use it. They keep it and it still shows on their orders.`;
  return `${lead} You won't see it when you pick a unit for a new product. You can restore it any time.`;
}

function renameNote(n: number): string {
  if (n === 0) return "Not used by any product yet.";
  return `Updates ${n} ${n === 1 ? "product" : "products"}. Orders and invoices already created keep the old name.`;
}

function UnitRow(props: {
  unit: TenantUnitDto;
  online: boolean;
  renaming: boolean;
  renameValue: string;
  renameError: string | null;
  rowError: string | null;
  saving: boolean;
  onRenameValue: (v: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSaveRename: () => void;
  onArchive: () => void;
  onEdit: () => void;
}) {
  const { unit: u, online } = props;
  const renameRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (props.renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [props.renaming]);
  const errId = `rename-error-${u.id}`;
  const noteId = `rename-note-${u.id}`;
  return (
    <li data-unit-id={u.id} className="px-4 py-3">
      {props.renaming ? (
        <div>
          <div className="flex items-center gap-2">
            <input
              ref={renameRef}
              value={props.renameValue}
              aria-label={`Rename ${u.name}`}
              aria-invalid={props.renameError ? true : undefined}
              aria-describedby={props.renameError ? `${errId} ${noteId}` : noteId}
              onChange={(e) => props.onRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") props.onSaveRename();
                if (e.key === "Escape") props.onCancelRename();
              }}
              className={`${fieldCls} ${props.renameError ? "border-danger" : "border-surface-border"}`}
            />
            <button
              type="button"
              className={textBtn}
              disabled={props.saving || !online}
              onClick={props.onSaveRename}
            >
              Save
            </button>
            <button type="button" className={textBtn} onClick={props.onCancelRename}>
              Cancel
            </button>
          </div>
          <p id={noteId} className="mt-1.5 text-xs text-navy/70">
            {renameNote(u.productCount)}
          </p>
          {props.renameError && (
            <p id={errId} role="alert" className="mt-1 text-sm text-danger">
              {props.renameError}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1 truncate font-medium text-navy">{u.name}</span>
          <span className="text-xs text-navy/70">{usedBy(u.productCount)}</span>
          <span className="hidden items-center gap-1 sm:flex">
            <button
              type="button"
              className={textBtn}
              disabled={!online}
              onClick={props.onStartRename}
            >
              Rename
            </button>
            <button type="button" className={textBtn} disabled={!online} onClick={props.onArchive}>
              Archive
            </button>
          </span>
          <button
            type="button"
            aria-label={`Edit ${u.name}`}
            data-edit
            disabled={!online}
            onClick={props.onEdit}
            className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 sm:hidden"
          >
            Edit
          </button>
        </div>
      )}
      {props.rowError && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {props.rowError}
        </p>
      )}
    </li>
  );
}

function SheetBody(props: {
  unit: TenantUnitDto;
  online: boolean;
  value: string;
  error: string | null;
  saving: boolean;
  onValue: (v: string) => void;
  onSave: () => void;
  onArchive: () => void;
}) {
  const { unit: u } = props;
  return (
    <>
      <Dialog.Title className="text-lg font-semibold text-navy">Edit {u.name}</Dialog.Title>
      <Dialog.Description className="mt-1 text-sm text-navy/70">
        {usedBy(u.productCount)}
      </Dialog.Description>
      <div className="mt-4 flex items-start gap-2">
        <input
          value={props.value}
          aria-label={`Rename ${u.name}`}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error ? "sheet-rename-error" : "sheet-rename-note"}
          onChange={(e) => props.onValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onSave()}
          className={`${fieldCls} ${props.error ? "border-danger" : "border-surface-border"}`}
        />
        <Button
          className="h-11 shrink-0"
          loading={props.saving}
          disabled={!props.online}
          onClick={props.onSave}
        >
          Save
        </Button>
      </div>
      <p id="sheet-rename-note" className="mt-1.5 text-xs text-navy/70">
        {renameNote(u.productCount)}
      </p>
      {props.error && (
        <p id="sheet-rename-error" role="alert" className="mt-1 text-sm text-danger">
          {props.error}
        </p>
      )}
      <Button
        variant="secondary"
        className="mt-5 h-11 w-full"
        disabled={!props.online}
        onClick={props.onArchive}
      >
        Archive
      </Button>
    </>
  );
}

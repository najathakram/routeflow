"use client";

import * as React from "react";
import { useQueries } from "@tanstack/react-query";
import { Button, Modal } from "@routeflow/ui/web";
import {
  QUICK_KEYS_MAX_CAP,
  QUICK_KEYS_MAX_HIDDEN,
  type QuickKey,
  type QuickKeysSettings,
} from "@routeflow/types";
import { apiClient } from "@/lib/api-client";
import { displayProductName } from "@/lib/product-display";
import { quickKeyLabel } from "@/lib/counter-quick-key-label";
import { useProducts } from "@/lib/api/products";
import {
  buildQuickKeysPatch,
  useQuickKeysSettings,
  useSaveQuickKeys,
} from "@/lib/api/counter-quick-keys";

/** Fixed copy: a failed save never shows the server's own text. */
export const QUICK_KEYS_SAVE_FAILED_COPY = "Couldn't save your quick keys. Try again.";
export const QUICK_KEYS_LOAD_FAILED_COPY =
  "Couldn't load your quick keys. Close this and try again.";
const UNKNOWN_NAME = "Unavailable product";
const SEARCH_STEP = 8;
const SEARCH_MAX = 40;

const BTN = "min-h-[44px] min-w-[44px] rounded border px-3 text-sm disabled:opacity-40";

interface Props {
  /** The grid as the screen shows it now (names for the pinned and ranked products). */
  keys: QuickKey[];
  /** The cap in force (from the grid answer). */
  cap: number;
  onClose: () => void;
}

/**
 * SA-747: "Edit keys". Works on a DRAFT of the saved pins and hides: pin / unpin through the paged product search,
 * move a pin up or down, hide / unhide a ranked product. Save sends the whole `quickKeys` setting through
 * PATCH /settings; Cancel (or close) discards the draft and sends nothing. No prices anywhere. The component is mounted
 * only while the editor is open, so every open starts from the saved lists.
 */
export function QuickKeysEditModal({ keys, cap, onClose }: Props) {
  const { data: saved, isError } = useQuickKeysSettings();
  // Never edit from defaults: until the saved settings are known, a Save would reset the tenant's cap and window and
  // wipe the hidden list. Loading and a failed read show a fixed line and offer no Save.
  if (!saved) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Edit quick keys"
        closeClassName="min-h-[44px] min-w-[44px]"
        footer={
          <Button variant="secondary" className="min-h-[44px]" onClick={onClose}>
            Cancel
          </Button>
        }
      >
        <p className="text-sm text-navy/70" data-testid="quick-keys-loading">
          {isError ? QUICK_KEYS_LOAD_FAILED_COPY : "Loading your quick keys…"}
        </p>
      </Modal>
    );
  }
  return <QuickKeysEditor keys={keys} cap={cap} onClose={onClose} saved={saved} />;
}

function QuickKeysEditor({ keys, cap, onClose, saved }: Props & { saved: QuickKeysSettings }) {
  const save = useSaveQuickKeys();
  const [pinned, setPinned] = React.useState<string[]>(
    () => saved.counter?.default?.pinned ?? keys.filter((k) => k.pinned).map((k) => k.productId),
  );
  const [hidden, setHidden] = React.useState<string[]>(() => saved.counter?.default?.hidden ?? []);
  const [names, setNames] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(keys.map((k) => [k.productId, quickKeyLabel(k)])),
  );
  const [failed, setFailed] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [limit, setLimit] = React.useState(SEARCH_STEP);
  const [showHidden, setShowHidden] = React.useState(false);

  // Seed the lists from the saved settings if they arrive after the editor opened and nothing was touched yet.
  const touchedRef = React.useRef(false);
  React.useEffect(() => {
    if (touchedRef.current || !saved?.counter?.default) return;
    setPinned(saved.counter.default.pinned);
    setHidden(saved.counter.default.hidden);
  }, [saved]);

  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setLimit(SEARCH_STEP);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const results = useProducts(
    { search: debounced || undefined, isActive: true, page: 1, limit },
    { enabled: debounced.length > 0 },
  );
  const rows: any[] = debounced ? (results.data?.data ?? []) : [];

  // A hidden product's name is only needed when the section is open, and only if the grid does not know it.
  const unknownHidden = showHidden ? hidden.filter((id) => !names[id]) : [];
  const fetched = useQueries({
    queries: unknownHidden.map((id) => ({
      queryKey: ["products", id],
      queryFn: () => apiClient.get(`/products/${id}`).then((r) => r.data),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const nameOf = (id: string): string => {
    if (names[id]) return names[id];
    const i = unknownHidden.indexOf(id);
    const p = i >= 0 ? (fetched[i]?.data as { name: string } | undefined) : undefined;
    return p ? displayProductName(p as any) : UNKNOWN_NAME;
  };

  const full = pinned.length >= Math.min(cap, QUICK_KEYS_MAX_CAP);
  const edit = <T,>(set: React.Dispatch<React.SetStateAction<T>>, fn: (prev: T) => T) => {
    touchedRef.current = true;
    setFailed(false);
    set(fn);
  };

  const pin = (id: string, name: string) => {
    if (full || pinned.includes(id)) return;
    setNames((n) => ({ ...n, [id]: name }));
    edit(setPinned, (p) => [...p, id]);
    edit(setHidden, (h) => h.filter((x) => x !== id)); // a pin outranks a hide: never leave both
  };
  const unpin = (id: string) => edit(setPinned, (p) => p.filter((x) => x !== id));
  const move = (id: string, dir: -1 | 1) =>
    edit(setPinned, (p) => {
      const i = p.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.length) return p;
      const next = [...p];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const hide = (id: string) => {
    if (hidden.includes(id) || hidden.length >= QUICK_KEYS_MAX_HIDDEN) return;
    edit(setHidden, (h) => [...h, id]);
  };
  const unhide = (id: string) => edit(setHidden, (h) => h.filter((x) => x !== id));

  const ranked = keys.filter((k) => !pinned.includes(k.productId) && !hidden.includes(k.productId));

  const onSave = () => {
    setFailed(false);
    save.mutate(buildQuickKeysPatch(saved, pinned, hidden), {
      onSuccess: onClose,
      onError: () => setFailed(true),
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit quick keys"
      description="Pin the products you ring up most. Ranked best sellers fill the rest."
      scroll
      closeClassName="min-h-[44px] min-w-[44px]"
      footer={
        <>
          <Button variant="secondary" className="min-h-[44px]" onClick={onClose}>
            Cancel
          </Button>
          <Button className="min-h-[44px]" disabled={save.isPending} onClick={onSave}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5" data-testid="quick-keys-editor">
        <section aria-label="Pinned keys" className="space-y-2">
          <p role="status" className="text-sm font-medium" data-testid="quick-keys-pin-count">
            {pinned.length} of {cap} pinned
          </p>
          {pinned.length === 0 ? (
            <p className="text-sm text-navy/70">Nothing pinned yet.</p>
          ) : (
            <ol className="divide-y rounded border">
              {pinned.map((id, i) => (
                <li key={id} className="flex items-center gap-2 px-2 py-1">
                  <span className="min-w-0 flex-1 break-words">{nameOf(id)}</span>
                  <button
                    type="button"
                    className={BTN}
                    aria-label={`Move ${nameOf(id)} up`}
                    disabled={i === 0}
                    onClick={() => move(id, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    aria-label={`Move ${nameOf(id)} down`}
                    disabled={i === pinned.length - 1}
                    onClick={() => move(id, 1)}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className={BTN}
                    aria-label={`Unpin ${nameOf(id)}`}
                    onClick={() => unpin(id)}
                  >
                    Unpin
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-label="Pin a product" className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="quick-keys-search">
            Find a product to pin
          </label>
          <input
            id="quick-keys-search"
            className="min-h-[44px] w-full rounded border px-3 py-2 text-sm"
            placeholder="Name or SKU"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {full ? <p className="text-sm text-navy/70">All {cap} keys are pinned.</p> : null}
          {rows.length > 0 ? (
            <ul className="divide-y rounded border" aria-label="Search results">
              {rows.map((p) => {
                const name = displayProductName(p);
                const isPinned = pinned.includes(p.id);
                return (
                  <li key={p.id} className="flex items-center gap-2 px-2 py-1">
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">{name}</span>
                      {p.sku ? <span className="block text-xs text-navy/60">{p.sku}</span> : null}
                    </span>
                    <button
                      type="button"
                      className={BTN}
                      aria-label={isPinned ? `${name} is pinned` : `Pin ${name}`}
                      disabled={isPinned || full}
                      onClick={() => pin(p.id, name)}
                    >
                      {isPinned ? "Pinned" : "Pin"}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : debounced && !results.isFetching && !results.isError ? (
            <p className="text-sm text-navy/70">No products found.</p>
          ) : null}
          {rows.length >= limit && limit < SEARCH_MAX ? (
            <button type="button" className={BTN} onClick={() => setLimit((l) => l + SEARCH_STEP)}>
              Show more
            </button>
          ) : null}
        </section>

        {ranked.length > 0 ? (
          <section aria-label="Best sellers" className="space-y-2">
            <h3 className="text-sm font-medium">Best sellers</h3>
            <ul className="divide-y rounded border">
              {ranked.map((k) => (
                <li key={k.productId} className="flex items-center gap-2 px-2 py-1">
                  <span className="min-w-0 flex-1 break-words">{quickKeyLabel(k)}</span>
                  <button
                    type="button"
                    className={BTN}
                    aria-label={`Hide ${quickKeyLabel(k)}`}
                    onClick={() => hide(k.productId)}
                  >
                    Hide
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hidden.length > 0 ? (
          <section aria-label="Hidden products" className="space-y-2">
            <button
              type="button"
              className={BTN}
              aria-expanded={showHidden}
              onClick={() => setShowHidden((s) => !s)}
            >
              Hidden products ({hidden.length})
            </button>
            {showHidden ? (
              <ul className="divide-y rounded border">
                {hidden.map((id) => (
                  <li key={id} className="flex items-center gap-2 px-2 py-1">
                    <span className="min-w-0 flex-1 break-words">{nameOf(id)}</span>
                    <button
                      type="button"
                      className={BTN}
                      aria-label={`Unhide ${nameOf(id)}`}
                      onClick={() => unhide(id)}
                    >
                      Unhide
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {failed ? (
          <p role="alert" className="text-sm text-red-700" data-testid="quick-keys-save-failed">
            {QUICK_KEYS_SAVE_FAILED_COPY}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

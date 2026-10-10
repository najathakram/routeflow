"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import type { QuickKey } from "@routeflow/types";
import { useQuickKeys } from "@/lib/api/counter-quick-keys";
import { quickKeyLabel } from "@/lib/counter-quick-key-label";
import { QuickKeysEditModal } from "./QuickKeysEditModal";

/** The one localStorage key of the section's collapsed state ("1" = collapsed). */
export const QUICK_KEYS_COLLAPSED_STORAGE_KEY = "routeflow.counter.quickKeys.collapsed";
export const QUICK_KEYS_EMPTY_COPY =
  "Your best sellers appear here after a few sales — or pin products now.";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(QUICK_KEYS_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(QUICK_KEYS_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* storage unavailable: the section still works for this visit */
  }
}

interface Props {
  /** A held / in-flight / frozen cart: every key is off and a tap adds nothing. */
  locked: boolean;
  /** The scan add path: the screen adds `key.product` at `key.sellLevel`, once, at the customer's tier. */
  /** The click event is passed through so the screen can apply its keyboard-vs-pointer focus rule. */
  onAdd: (key: QuickKey, e: React.MouseEvent) => void;
}

/**
 * SA-747: the counter sale's QUICK KEYS: a collapsible grid of the best sellers (and the operator's pins). A key
 * shows a name and a picture, never a price (prices vary by customer tier, so the grid neither shows nor decides
 * one). Tapping one is the same add a scan makes. A failed or malformed answer renders nothing, so the till is never
 * blocked by this section.
 */
export function QuickKeysGrid({ locked, onAdd }: Props) {
  const { data, refetch } = useQuickKeys();
  // Client-only (it renders once the data has arrived), so reading storage at init cannot mismatch the server HTML.
  const [collapsed, setCollapsed] = React.useState(readCollapsed);
  const [editing, setEditing] = React.useState(false);

  if (!data || !Array.isArray(data.keys)) return null;
  const keys = data.keys;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };

  return (
    <section aria-label="Quick keys" className="space-y-2" data-testid="quick-keys">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-h-[44px] items-center gap-1 text-sm font-medium"
          aria-expanded={!collapsed}
          aria-controls="quick-keys-body"
          onClick={toggle}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
          Quick keys
        </button>
        <button
          type="button"
          className="min-h-[44px] px-2 text-sm text-brand-700 underline"
          onClick={() => setEditing(true)}
        >
          Edit keys
        </button>
      </div>
      <div id="quick-keys-body" hidden={collapsed}>
        {collapsed ? null : keys.length === 0 ? (
          <p className="text-sm text-navy/70" data-testid="quick-keys-empty">
            {QUICK_KEYS_EMPTY_COPY}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <ul
              className="grid grid-cols-[repeat(4,minmax(5rem,1fr))] gap-2 xl:grid-cols-[repeat(6,minmax(5rem,1fr))]"
              data-testid="quick-keys-grid"
            >
              {keys.map((k) => (
                <li key={k.productId} className="min-w-0">
                  <button
                    type="button"
                    data-testid={`quick-key-${k.productId}`}
                    aria-disabled={locked}
                    disabled={locked}
                    className={cn(
                      "relative flex min-h-[44px] w-full flex-col items-center justify-center gap-1 rounded border bg-white px-1 py-2 text-center text-xs leading-tight",
                      "hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-navy disabled:opacity-40",
                    )}
                    onClick={async (e) => {
                      if (locked) return;
                      // #3356: re-read the answer so the added price is the server's current one, like a scan's
                      // lookup. A failed or empty refresh falls back to the loaded key: the till never blocks.
                      let key = k;
                      try {
                        const fresh = (await refetch()).data?.keys.find(
                          (x) => x.productId === k.productId,
                        );
                        if (fresh) key = fresh;
                      } catch {
                        /* keep the loaded key */
                      }
                      onAdd(key, e);
                    }}
                  >
                    {k.pinned ? (
                      <Pin
                        className="absolute right-1 top-1 h-3 w-3 text-navy/50"
                        aria-hidden="true"
                        data-testid="quick-key-pin"
                      />
                    ) : null}
                    {k.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a signed URL; the till needs no optimiser
                      <img
                        src={k.imageUrl}
                        alt=""
                        loading="lazy"
                        className="h-8 w-8 rounded object-cover"
                      />
                    ) : null}
                    <span className="line-clamp-2 w-full break-words">{quickKeyLabel(k)}</span>
                    {k.pinned ? <span className="sr-only">Pinned</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {editing ? (
        <QuickKeysEditModal keys={keys} cap={data.cap} onClose={() => setEditing(false)} />
      ) : null}
    </section>
  );
}

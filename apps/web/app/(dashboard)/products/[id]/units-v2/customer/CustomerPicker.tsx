"use client";

import * as React from "react";
import { useCustomers } from "@/lib/api/customers";
import { CUSTOMER_VIEW_TESTIDS as T } from "./customer-testids";

interface CustomerHit {
  id: string;
  businessName?: string;
  contactName?: string;
}

/** Rows whose business or contact name contains the text (case-insensitive); all rows for empty text. */
function localMatches(rows: CustomerHit[], text: string): CustomerHit[] {
  const needle = text.toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (r) =>
      (r.businessName ?? "").toLowerCase().includes(needle) ||
      (r.contactName ?? "").toLowerCase().includes(needle),
  );
}

const LISTBOX_ID = "units-v2-cust-listbox";
const optionId = (id: string) => `units-v2-cust-opt-${id}`;

/**
 * Customer search as a WAI-ARIA combobox with a listbox popup (F26). DOM focus stays in the input;
 * the highlighted option is named by aria-activedescendant. ArrowDown/ArrowUp move it, Home/End jump,
 * Enter picks it (or the only match), Escape closes the list (and stops there) and keeps focus in the input, blur closes it too (K11-04: the list
 * starts shut), focus and typing reopen it. A mouse click on an option still picks.
 */
export function CustomerPicker({ onPick }: { onPick: (c: { id: string; name: string }) => void }) {
  const [text, setText] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [open, setOpen] = React.useState(false); // K11-04: shut until the owner asks (focus or typing)
  const [active, setActive] = React.useState(-1);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const list = useCustomers({ search: debounced || undefined, limit: 8 });
  // K11-05: the 250 ms debounce gates the API call only. Until the response for the current text lands,
  // the rows already loaded are filtered by the text on every keystroke, so the list follows the keys at
  // once; the server result replaces it when it arrives (it may match on more than the name).
  const loaded = (list.data as { data?: CustomerHit[] } | undefined)?.data;
  const lastLoaded = React.useRef<CustomerHit[]>([]);
  if (loaded) lastLoaded.current = loaded;
  const trimmed = text.trim();
  const fresh = loaded !== undefined && trimmed === debounced;
  const hits = (fresh ? loaded : localMatches(lastLoaded.current, trimmed)).slice(0, 8);
  const expanded = open && hits.length > 0;
  const activeHit = expanded && active >= 0 && active < hits.length ? hits[active] : null;

  const pick = (c: CustomerHit) =>
    onPick({ id: c.id, name: c.businessName ?? c.contactName ?? "Customer" });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (hits.length === 0) return;
      e.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(e.key === "ArrowDown" ? 0 : hits.length - 1);
        return;
      }
      setActive((i) =>
        e.key === "ArrowDown" ? Math.min(i + 1, hits.length - 1) : Math.max(i - 1, 0),
      );
    } else if (e.key === "Home" || e.key === "End") {
      if (!expanded || active < 0) return; // leave the caret keys alone until an option is in play
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : hits.length - 1);
    } else if (e.key === "Enter") {
      if (!expanded) return;
      const target = activeHit ?? (hits.length === 1 ? hits[0] : null);
      if (!target) return;
      e.preventDefault();
      pick(target);
    } else if (e.key === "Escape") {
      if (!expanded) return; // nothing of ours to close: let the page's own Escape handling run
      e.preventDefault(); // type=search would clear the text
      e.stopPropagation(); // this Escape closes the list only, never also a surrounding dialog or panel
      setOpen(false);
      setActive(-1); // focus never left the input (the key event came from it); refocusing would reopen
    }
  };

  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <label htmlFor="units-v2-cust-search" className="text-sm font-medium text-navy">
        Customer
      </label>
      <input
        id="units-v2-cust-search"
        data-testid={T.search}
        type="search"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={activeHit ? optionId(activeHit.id) : undefined}
        autoComplete="off"
        value={text}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        placeholder="Find a customer by name"
        className="h-11 rounded-md border border-surface-border bg-white px-3 text-sm text-navy"
      />
      {expanded ? (
        <ul
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Customers"
          data-testid={T.listbox}
          className="max-h-56 overflow-auto rounded-md border border-surface-border"
        >
          {hits.map((c, i) => (
            <li
              key={c.id}
              id={optionId(c.id)}
              role="option"
              aria-selected={i === active}
              data-testid={T.result(c.id)}
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              // K11-04: the highlight is a brand tint plus a left bar (not the hover grey), and hover moves
              // the same highlight (onMouseEnter sets active), so mouse and keyboard look alike.
              className={`flex min-h-11 cursor-pointer items-center border-l-[3px] px-3 py-2 text-left text-sm text-navy ${
                i === active
                  ? "border-l-brand-600 bg-brand-500/10 font-medium"
                  : "border-l-transparent"
              }`}
            >
              {c.businessName ?? c.contactName}
            </li>
          ))}
        </ul>
      ) : fresh && debounced && hits.length === 0 ? (
        <p className="text-xs text-navy/60">No customer matches that name.</p>
      ) : null}
    </div>
  );
}

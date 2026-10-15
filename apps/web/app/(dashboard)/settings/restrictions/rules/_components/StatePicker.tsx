"use client";

import * as React from "react";
import { Input, cn } from "@routeflow/ui/web";
import { US_STATES } from "@routeflow/types";
import { stateName } from "@/lib/restriction-rules";

/**
 * Multi-select of the shared US state list: a search box, a scrollable checkbox list, and the
 * chosen states as removable chips. Values are the 2-letter USPS codes the API stores.
 */
export function StatePicker({
  value,
  onChange,
  error,
}: {
  value: string[];
  onChange: (codes: string[]) => void;
  error?: string;
}) {
  const [q, setQ] = React.useState("");
  const shown = US_STATES.filter(
    (s) =>
      !q.trim() ||
      s.name.toLowerCase().includes(q.trim().toLowerCase()) ||
      s.code.toLowerCase() === q.trim().toLowerCase(),
  );
  // The API returns `states` verbatim, so a rule saved as "tx" must still tick Texas. Both sides of
  // every comparison are upper-cased: a checkbox passes a US_STATES code, but a chip passes the
  // STORED value (possibly "tx"). Never hand the parent a duplicate ("tx" + "TX").
  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  const has = (code: string) => value.some((c) => same(c, code));
  const toggle = (code: string) =>
    onChange(has(code) ? value.filter((c) => !same(c, code)) : [...value, code]);

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected states">
          {value.map((code) => (
            <li key={code}>
              <button
                type="button"
                onClick={() => toggle(code)}
                aria-label={`Remove ${stateName(code.toUpperCase())}`}
                className="rounded-full bg-danger-bg px-2 py-0.5 text-xs font-semibold text-danger"
              >
                {stateName(code.toUpperCase())} ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        aria-label="Search states"
        placeholder="Search states"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div
        role="group"
        aria-label="States"
        className={cn(
          "max-h-40 overflow-y-auto rounded border border-surface-border p-1",
          error && "border-danger",
        )}
      >
        {shown.length === 0 && <p className="p-2 text-sm text-navy/60">No matching states</p>}
        {shown.map((s) => (
          <label
            key={s.code}
            className="flex min-h-[36px] cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-surface-raised"
          >
            <input type="checkbox" checked={has(s.code)} onChange={() => toggle(s.code)} />
            <span>{s.name}</span>
            <span className="ml-auto text-xs text-navy/60">{s.code}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

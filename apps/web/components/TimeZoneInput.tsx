"use client";

import * as React from "react";
import { listTimeZones } from "@/lib/timezones";

/** The searchable IANA zone list (native datalist); point an input's `list` at `id`. */
export function TimeZoneDatalist({ id }: { id: string }) {
  const zones = React.useMemo(() => listTimeZones(), []);
  return (
    <datalist id={id}>
      {zones.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}

/** A plain text input wired to the zone list. Validation lives with the caller. */
export const TimeZoneInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "list">
>(function TimeZoneInput({ id, ...rest }, ref) {
  const reactId = React.useId();
  const listId = `${id ?? reactId}-zones`;
  return (
    <>
      <input
        ref={ref}
        id={id}
        list={listId}
        autoComplete="off"
        spellCheck={false}
        placeholder="Start typing, e.g. America/Chicago"
        {...rest}
      />
      <TimeZoneDatalist id={listId} />
    </>
  );
});

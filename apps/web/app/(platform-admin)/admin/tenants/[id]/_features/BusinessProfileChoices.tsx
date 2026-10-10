"use client";

import * as React from "react";
import type { BusinessProfileKey, BusinessProfileSummary } from "@routeflow/types";
import { IN_STORE_UNAVAILABLE_NOTE } from "./setup-copy";

/**
 * The four business profiles as one radio group, each with its plain-English description. A profile the API reports
 * unavailable (`available: false` — today the two in-store ones) is shown disabled with a fixed note and can never be
 * chosen, so it is never sent. Shared by the tenant Setup tab and the create-tenant form.
 */
export function BusinessProfileChoices({
  profiles,
  value,
  onChange,
  name,
  legend,
  disabled,
  noneOption,
}: {
  profiles: BusinessProfileSummary[];
  value: BusinessProfileKey | "";
  onChange: (key: BusinessProfileKey | "") => void;
  /** The radio group's `name` (and the id prefix), unique per screen. */
  name: string;
  legend: string;
  disabled?: boolean;
  /** An extra first choice meaning "no profile" (value `""`), for forms where a profile is optional. */
  noneOption?: { label: string; description: string };
}) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium text-slate-300">{legend}</legend>
      {noneOption && (
        <ChoiceRow
          id={`${name}-none`}
          name={name}
          value=""
          checked={value === ""}
          onSelect={() => onChange("")}
          label={noneOption.label}
          description={noneOption.description}
        />
      )}
      {profiles.map((p) => (
        <ChoiceRow
          key={p.key}
          id={`${name}-${p.key}`}
          name={name}
          value={p.key}
          checked={value === p.key}
          unavailable={!p.available}
          onSelect={() => p.available && onChange(p.key)}
          label={p.label}
          description={p.description}
        />
      ))}
    </fieldset>
  );
}

function ChoiceRow({
  id,
  name,
  value,
  checked,
  unavailable,
  onSelect,
  label,
  description,
}: {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  unavailable?: boolean;
  onSelect: () => void;
  label: string;
  description: string;
}) {
  const noteId = `${id}-note`;
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-3 rounded-lg p-3 ring-1 ${
        checked ? "bg-indigo-900/30 ring-indigo-500/60" : "bg-slate-900/40 ring-white/10"
      } ${unavailable ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:ring-slate-500"}`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={unavailable}
        aria-describedby={unavailable ? noteId : undefined}
        onChange={onSelect}
        className="mt-1"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-white">{label}</span>
        <span className="text-xs text-slate-400">{description}</span>
        {unavailable && (
          <span id={noteId} className="text-xs font-medium text-amber-300">
            {IN_STORE_UNAVAILABLE_NOTE}
          </span>
        )}
      </span>
    </label>
  );
}

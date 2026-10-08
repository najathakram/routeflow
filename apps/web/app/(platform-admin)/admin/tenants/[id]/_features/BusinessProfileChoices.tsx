"use client";

import * as React from "react";
import type { BusinessProfileKey, BusinessProfileSummary } from "@routeflow/types";
import { profilePlainCopy } from "./profile-plain-copy";

/**
 * The four business profiles as one radio group, each with a plain name and one line (profile-plain-copy.ts; the
 * server's label stays as a muted secondary line). A profile the API reports unavailable (`available: false`) is shown
 * disabled and can never be chosen, so it is never sent. `currentKey` marks the profile the tenant already has with a
 * "Current" badge (it stays selectable). Shared by the tenant Setup tab and the create-tenant form.
 */
export function BusinessProfileChoices({
  profiles,
  value,
  onChange,
  name,
  legend,
  disabled,
  noneOption,
  currentKey,
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
  /** The tenant's applied profile, when it could be determined; no marker otherwise. */
  currentKey?: BusinessProfileKey | null;
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
      {profiles.map((p) => {
        const copy = profilePlainCopy(p.key, p.label, p.description);
        return (
          <ChoiceRow
            key={p.key}
            id={`${name}-${p.key}`}
            name={name}
            value={p.key}
            checked={value === p.key}
            unavailable={!p.available}
            current={currentKey === p.key}
            onSelect={() => p.available && onChange(p.key)}
            label={copy.name}
            description={copy.line}
            secondary={copy.secondary}
          />
        );
      })}
    </fieldset>
  );
}

function ChoiceRow({
  id,
  name,
  value,
  checked,
  unavailable,
  current,
  onSelect,
  label,
  description,
  secondary,
}: {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  unavailable?: boolean;
  current?: boolean;
  onSelect: () => void;
  label: string;
  description: string;
  secondary?: string | null;
}) {
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
        onChange={onSelect}
        className="mt-1"
      />
      <span className="flex flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
          {label}
          {current && (
            <span
              data-testid="profile-current"
              className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-300"
            >
              Current
            </span>
          )}
        </span>
        <span className="text-xs text-slate-400">{description}</span>
        {secondary && <span className="text-[11px] text-slate-400">{secondary}</span>}
      </span>
    </label>
  );
}

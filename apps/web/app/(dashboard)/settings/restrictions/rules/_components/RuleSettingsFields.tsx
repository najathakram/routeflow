"use client";

import * as React from "react";
import { Input, Select, Textarea } from "@routeflow/ui/web";
import { REASON_MAX, type RuleFormValues } from "@/lib/restriction-rule-form";
import { surfaceText } from "@/lib/restriction-rules";
import { StatePicker } from "./StatePicker";

export type RuleFormErrors = Partial<Record<keyof RuleFormValues, string>>;

const Legend = ({ children }: { children: React.ReactNode }) => (
  <legend className="mb-1 text-sm font-medium text-navy">{children}</legend>
);

/**
 * The settings half of a rule (where, states, sold through, dates, reason), shared by the New rule
 * dialog and the Edit settings dialog so the two cannot drift. `federalNote` disables the "everywhere"
 * choice and says why (an operator may not make a rule apply everywhere, owner L5).
 */
export function RuleSettingsFields({
  v,
  set,
  errors,
  federalNote,
}: {
  v: RuleFormValues;
  set: <K extends keyof RuleFormValues>(k: K, val: RuleFormValues[K]) => void;
  errors: RuleFormErrors;
  federalNote?: string;
}) {
  return (
    <>
      <fieldset>
        <Legend>Where</Legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {(["STATE", "FEDERAL"] as const).map((j) => (
            <label key={j} className="flex min-h-[44px] items-center gap-2 sm:min-h-0">
              <input
                type="radio"
                name="jurisdiction"
                checked={v.jurisdiction === j}
                disabled={j === "FEDERAL" && !!federalNote && v.jurisdiction !== "FEDERAL"}
                onChange={() => set("jurisdiction", j)}
              />
              {j === "STATE" ? "Specific states" : "Everywhere (federal)"}
            </label>
          ))}
        </div>
        {federalNote && <p className="mt-1 text-xs text-navy/70">{federalNote}</p>}
      </fieldset>
      {v.jurisdiction === "STATE" && (
        <StatePicker value={v.states} onChange={(s) => set("states", s)} error={errors.states} />
      )}

      <Select
        label="Sold through"
        value={v.surface}
        onChange={(e) => set("surface", e.target.value as RuleFormValues["surface"])}
        options={[
          { value: "ALL", label: surfaceText("ALL") },
          { value: "BUYER_PORTAL", label: surfaceText("BUYER_PORTAL") },
        ]}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Starts on (blank = now)"
          type="date"
          value={v.startsOn}
          onChange={(e) => set("startsOn", e.target.value)}
        />
        <Input
          label="Ends on (blank = no end)"
          type="date"
          value={v.endsOn}
          onChange={(e) => set("endsOn", e.target.value)}
          error={errors.endsOn}
        />
      </div>

      <Textarea
        label="Reason"
        rows={3}
        maxLength={REASON_MAX + 50}
        value={v.reason}
        onChange={(e) => set("reason", e.target.value)}
        error={errors.reason}
      />
    </>
  );
}

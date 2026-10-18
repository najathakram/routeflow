"use client";

import * as React from "react";
import { Check, X } from "lucide-react";
import { cn } from "@routeflow/ui/web";
import { missingMessage, missingRules, PASSWORD_RULES } from "@/lib/password-policy";

/** How long typing must pause before the screen-reader summary is announced. */
export const CHECKLIST_ANNOUNCE_DELAY_MS = 700;

/**
 * The password policy as a live checklist under a New password field. Each rule shows met or
 * missing as you type; the screen-reader summary ("Still needed: a lowercase letter.") is announced
 * politely once typing pauses, never on every keystroke. Point the field's `aria-describedby` at `id`.
 */
export function PasswordChecklist({ value, id }: { value: string; id: string }) {
  const missing = missingRules(value);
  const summary =
    value === ""
      ? ""
      : missing.length === 0
        ? "Password meets every requirement."
        : `Still needed: ${missingMessage(missing)!.replace(/^Add /, "").replace(/^Use /, "")}`;
  const [announced, setAnnounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setAnnounced(summary), CHECKLIST_ANNOUNCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [summary]);

  return (
    <div className="-mt-2">
      <ul id={id} className="flex flex-col gap-0.5 text-xs" aria-label="Password requirements">
        {PASSWORD_RULES.map((rule) => {
          const met = rule.test(value);
          return (
            <li
              key={rule.id}
              data-rule={rule.id}
              data-met={met}
              className={cn("flex items-center gap-1.5", met ? "text-success" : "text-navy/70")}
            >
              {met ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {rule.label}
              <span className="sr-only">{met ? ": met" : ": missing"}</span>
            </li>
          );
        })}
      </ul>
      <p className="sr-only" aria-live="polite" role="status">
        {announced}
      </p>
    </div>
  );
}

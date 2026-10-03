"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./utils";
import { useReducedMotion } from "./motion";

export interface FoldProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Always-visible trigger content. */
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/** A disclosure: a button summary that opens a region. Closed content is `inert` (out of the tab order). */
export function Fold({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  summary,
  children,
  className,
}: FoldProps) {
  const reduced = useReducedMotion();
  const [inner, setInner] = React.useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : inner;
  const regionId = React.useId();
  const toggle = () => {
    if (!controlled) setInner(!open);
    onOpenChange?.(!open);
  };
  // `inert` is set on the DOM node itself: React 18 and 19 disagree on how to pass it as a prop.
  const regionRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = regionRef.current;
    if (!el) return;
    if (open) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [open]);
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span className="min-w-0 flex-1">{summary}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-navy/50",
            open && "rotate-180",
            !reduced && "transition-transform",
          )}
        />
      </button>
      <div
        id={regionId}
        ref={regionRef}
        data-state={open ? "open" : "closed"}
        className={cn(
          "grid",
          // Motion allowed: animate the track 0fr↔1fr. Reduced: switch instantly with `hidden`.
          reduced
            ? open
              ? "grid-rows-[1fr]"
              : "hidden"
            : cn("transition-[grid-template-rows]", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"),
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

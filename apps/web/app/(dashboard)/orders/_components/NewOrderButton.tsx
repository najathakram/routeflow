"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { Button, type ButtonProps } from "@routeflow/ui/web";
import { COUNTER_COPY, type FulfilmentCapability } from "@routeflow/types";
import { regularOrderSubtitle, type NewOrderEntry } from "@/lib/counter-sale";
import { useReadOnlyGate, WriteButton } from "@/lib/read-only-gate";

const ITEM =
  "flex min-h-11 cursor-pointer flex-col justify-center rounded-md px-3 py-2 outline-none data-[highlighted]:bg-surface-raised";

/**
 * W-854 (SA-940, A-1.4): the ONE New order, on the Orders header and both dashboard branches. It draws the four answers of
 * `newOrderEntry`. In the menu the first item takes focus on every open, mouse and URL included, so Enter takes the
 * business's default. The open state can be held by the page, because `?action=new` opens it.
 */
export function NewOrderButton({
  entry,
  capability,
  onCounterSale,
  onRegularOrder,
  builderHref,
  open,
  onOpenChange,
  size,
  leftIcon,
}: {
  entry: NewOrderEntry;
  capability?: FulfilmentCapability | null;
  onCounterSale: () => void;
  onRegularOrder: () => void;
  /** Draws the `builder` answer as a link, where the builder is on another page. */
  builderHref?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: ButtonProps["size"];
  leftIcon?: React.ReactNode;
}) {
  const gate = useReadOnlyGate();
  const [ownOpen, setOwnOpen] = React.useState(false);
  const menuOpen = (open ?? ownOpen) && !gate.readOnly;
  const setMenuOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const firstItem = React.useRef<HTMLDivElement>(null);
  // Radix focuses the first item on a keyboard open only.
  React.useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(() => firstItem.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);
  // A pick leaves this control behind, so focus doesn't go back to it.
  const picked = React.useRef(false);
  const pick = (go: () => void) => () => {
    picked.current = true;
    go();
  };

  const className = "max-sm:h-11";
  switch (entry.kind) {
    case "none":
      return null;
    case "wait":
      return (
        <Button type="button" size={size} leftIcon={leftIcon} className={className} disabled>
          New order
        </Button>
      );
    case "builder":
      return (
        <WriteButton
          size={size}
          leftIcon={leftIcon}
          className={className}
          {...(builderHref ? { href: builderHref } : { onClick: onRegularOrder })}
        >
          New order
        </WriteButton>
      );
    case "menu": {
      const items = [
        {
          title: COUNTER_COPY.counterSale,
          subtitle: "Take payment now",
          onSelect: onCounterSale,
        },
        {
          title: COUNTER_COPY.regularOrder,
          subtitle: regularOrderSubtitle(capability),
          onSelect: onRegularOrder,
        },
      ];
      if (entry.first === "order") items.reverse();
      return (
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <Button
              type="button"
              size={size}
              leftIcon={leftIcon}
              rightIcon={<ChevronDown className="h-4 w-4" aria-hidden />}
              disabled={gate.readOnly}
              aria-describedby={gate.readOnly ? gate.hintId : undefined}
              title={gate.readOnly ? (gate.line ?? undefined) : undefined}
              data-testid="new-order-open"
              className={className}
            >
              New order
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              onCloseAutoFocus={(event) => {
                if (picked.current) event.preventDefault();
                picked.current = false;
              }}
              className="z-50 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-surface-border bg-white p-1 shadow-dropdown"
            >
              {items.map((item, index) => (
                <DropdownMenu.Item
                  key={item.title}
                  ref={index === 0 ? firstItem : undefined}
                  className={ITEM}
                  onSelect={pick(item.onSelect)}
                >
                  <span className="text-sm font-medium text-navy">{item.title}</span>
                  <span className="text-xs text-navy/70">{item.subtitle}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      );
    }
  }
}

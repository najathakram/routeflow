"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@routeflow/ui/web";

export interface OrdersMoreMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * The "⋯ More" menu of the Orders header below `sm` (UX G7, store-only tenants): Export and Select step out of the
 * header row so Counter sale and Invoice a customer share one line. Every target is 44 px tall.
 */
export function OrdersMoreMenu({
  items,
  className,
}: {
  items: OrdersMoreMenuItem[];
  className?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More actions"
          className={cn(
            "inline-flex h-11 w-11 items-center justify-center rounded-ctl border border-line-strong bg-paper text-navy shadow-card transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2",
            className,
          )}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[10rem] rounded-lg border border-surface-border bg-white p-1 shadow-dropdown"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm text-navy outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised"
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

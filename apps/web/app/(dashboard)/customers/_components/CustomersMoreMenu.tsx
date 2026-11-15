"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";

/**
 * The phone "More" menu of the header (the same look as the Invoices and Orders lists'): below md
 * the secondary header actions live here, every target 44 px tall; from md up the page shows its
 * plain buttons and this trigger is hidden.
 */
export function CustomersMoreMenu({
  items,
}: {
  items: { label: string; onSelect: () => void; disabled?: boolean }[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More actions"
          className="inline-flex h-11 w-11 items-center justify-center rounded-ctl border border-line-strong bg-paper text-navy shadow-card transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2 md:hidden"
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

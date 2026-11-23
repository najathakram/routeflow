"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@routeflow/ui/web";

/**
 * The phone header actions of the Stock tab (below md): the primary Quick restock beside a "More"
 * menu holding the other toolbar actions (same look as the Invoices and Orders menus; every target
 * is 44 px tall). From md up the toolbar keeps its plain buttons and this is not shown.
 */
export function InventoryPhoneActions({
  onRestock,
  items,
}: {
  onRestock: () => void;
  items: { label: string; onSelect: () => void }[];
}) {
  return (
    <div className="flex items-center gap-2 md:hidden">
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
                onSelect={item.onSelect}
                className="flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm text-navy outline-none data-[highlighted]:bg-surface-raised"
              >
                {item.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Button
        size="sm"
        className="min-h-[44px]"
        leftIcon={<Plus className="h-4 w-4" />}
        onClick={onRestock}
      >
        Quick restock
      </Button>
    </div>
  );
}

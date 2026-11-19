"use client";

import * as React from "react";
import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";

export interface InventoryCardMenuItem {
  label: string;
  /** A handler (a button item) or a link (an anchor item); one of the two. */
  onSelect?: () => void;
  href?: string;
}

const ITEM =
  "flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm text-navy outline-none data-[highlighted]:bg-surface-raised";

/**
 * The one "More actions for <product>" button of a phone stock card (same Radix dropdown as the
 * page's phone More menu). It sits above the card's stretched link (`relative z-10`) and is a
 * 44x44 target, so a card never shows more than two text actions plus this button.
 */
export function InventoryCardMenu({
  name,
  items,
}: {
  name: string;
  items: InventoryCardMenuItem[];
}) {
  return (
    <div className="relative z-10">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`More actions for ${name}`}
            className="grid min-h-[44px] min-w-[44px] place-items-center rounded text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[10rem] rounded-lg border border-surface-border bg-white p-1 shadow-dropdown"
          >
            {items.map((item) =>
              item.href ? (
                <DropdownMenu.Item key={item.label} asChild>
                  <Link href={item.href} className={ITEM}>
                    {item.label}
                  </Link>
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item key={item.label} onSelect={item.onSelect} className={ITEM}>
                  {item.label}
                </DropdownMenu.Item>
              ),
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

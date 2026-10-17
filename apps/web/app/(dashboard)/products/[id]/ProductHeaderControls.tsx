"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { Button, cn, TAP_TARGET } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { isStaffRole } from "@/lib/default-unit-line";

/**
 * The product Details card's view-mode actions: Make variant of…, Deactivate / Reactivate, the tobacco
 * toggle, and Delete (staff only; it opens the page's DeleteProductConfirm). The pencil (Edit) stays in the page.
 *
 * K11-22: from `sm` up these are the buttons they always were. Below `sm` they fold into one "More actions"
 * menu (Delete last, in red) so the header is one row. The switch is CSS (`max-sm:hidden` / `sm:hidden`), never a
 * JS width hook, so there is no flash and no layout shift. A menu of one item is not worth a tap: that lone
 * action stays a button at every width.
 */

type Action = {
  key: string;
  label: string;
  title?: string;
  run: () => void;
  pending: boolean;
};

const ITEM =
  "flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-sm text-navy outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised";

export function ProductHeaderControls({
  product,
  reactivateFlow,
  hasTobaccoAddon,
  isTobacco,
  tobaccoLoading,
  onToggleTobacco,
  onMakeVariant,
  onRequestDelete,
}: {
  product: {
    id: string;
    name: string;
    isActive: boolean;
    parentProductId?: string | null;
    kind?: string | null;
  };
  reactivateFlow: {
    start: (id: string, kind?: "product" | "variant", name?: string) => void;
    askDeactivate: (id: string, name: string) => void;
    isPending: boolean;
  };
  hasTobaccoAddon: boolean;
  isTobacco: boolean;
  tobaccoLoading: boolean;
  onToggleTobacco: () => void;
  onMakeVariant: () => void;
  /** Opens the page's "Delete product?" confirm (DeleteProductConfirm). */
  onRequestDelete: () => void;
}) {
  const { user } = useAuth();
  // Owner ruling 2026-10-14: staff (an operator or an account admin) get every product control.
  const isStaff = isStaffRole(user?.role);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  // A menu pick runs once the menu has closed and focus is parked on the trigger, so a dialog it opens
  // restores focus to the three dots on Cancel (and Radix's own focus return never fights the dialog).
  const afterClose = React.useRef<(() => void) | null>(null);

  const actions: Action[] = [
    ...(isStaff && !product.parentProductId && product.kind !== "FAMILY"
      ? [
          {
            key: "make-variant",
            label: "Make variant of…",
            title: "Link this product as a variant of another product",
            run: onMakeVariant,
            pending: false,
          },
        ]
      : []),
    {
      key: "active",
      label: product.isActive ? "Deactivate" : "Reactivate",
      run: () =>
        product.isActive
          ? reactivateFlow.askDeactivate(product.id, product.name)
          : reactivateFlow.start(product.id, "product", product.name),
      pending: reactivateFlow.isPending,
    },
    ...(hasTobaccoAddon
      ? [
          {
            key: "tobacco",
            label: isTobacco ? "Unmark tobacco" : "Mark as tobacco",
            title: "Tobacco products are tracked separately for monthly tax reports",
            run: onToggleTobacco,
            pending: tobaccoLoading,
          },
        ]
      : []),
  ];
  const useMenu = actions.length + (isStaff ? 1 : 0) > 1;
  const busy = actions.some((a) => a.pending);
  const hideBelowSm = useMenu ? "max-sm:hidden" : undefined;

  return (
    <>
      {actions.map((a) => (
        <Button
          key={a.key}
          size="sm"
          variant="ghost"
          className={hideBelowSm}
          onClick={a.run}
          loading={a.pending}
          title={a.title}
        >
          {a.label}
        </Button>
      ))}
      {isStaff && (
        <div
          className={cn(
            "flex items-center sm:ml-2 sm:border-l sm:border-surface-border sm:pl-3",
            hideBelowSm,
          )}
        >
          <Button
            size="sm"
            variant="danger-outline"
            leftIcon={<Trash2 className="h-4 w-4" />}
            onClick={onRequestDelete}
          >
            Delete
          </Button>
        </div>
      )}
      {useMenu && (
        <div className="sm:hidden">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                ref={triggerRef}
                type="button"
                aria-label="More actions"
                aria-busy={busy || undefined}
                className={cn(
                  TAP_TARGET,
                  "rounded px-2.5 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                )}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                )}
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                onCloseAutoFocus={(e) => {
                  const run = afterClose.current;
                  afterClose.current = null;
                  if (!run) return;
                  e.preventDefault();
                  triggerRef.current?.focus();
                  run();
                }}
                className="z-50 min-w-[12rem] origin-[var(--radix-dropdown-menu-content-transform-origin)] rounded-lg border border-surface-border bg-white p-1 shadow-dropdown duration-150 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97] motion-reduce:zoom-in-100 motion-reduce:zoom-out-100"
              >
                {actions.map((a) => (
                  <DropdownMenu.Item
                    key={a.key}
                    disabled={a.pending}
                    onSelect={() => {
                      afterClose.current = a.run;
                    }}
                    className={ITEM}
                  >
                    {a.label}
                  </DropdownMenu.Item>
                ))}
                {isStaff && (
                  <>
                    <DropdownMenu.Separator className="my-1 h-px bg-surface-border" />
                    <DropdownMenu.Item
                      onSelect={() => {
                        afterClose.current = onRequestDelete;
                      }}
                      className={cn(ITEM, "text-danger data-[highlighted]:bg-danger/10")}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      Delete
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </>
  );
}

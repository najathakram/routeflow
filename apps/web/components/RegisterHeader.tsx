"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Menu } from "lucide-react";
import { Button, Modal, TAP_TARGET, cn } from "@routeflow/ui/web";
import { useTenant } from "@/components/tenant-provider";
import {
  COUNTER_LEAVE_BLOCKED_COPY,
  getCounterCartBusy,
  getCounterCartHasLines,
  getCounterLeaveNotice,
  cancelCounterLeave,
  confirmCounterLeave,
  getCounterLeaveRequest,
  guardCounterLeave,
  subscribeCounterCart,
} from "@/lib/counter-cart-signal";
import { useCounterBackGuard } from "@/lib/counter-back-guard";
import { readExitTarget } from "@/lib/register-mode";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "./dialog-mobile-fit";

/**
 * POS-7: the slim header the shell shows in register mode (on the counter screen only). Exit counter is the FIRST
 * focusable control; the clerk and the store name follow. When the cart has lines, Exit asks "Discard this sale?" first
 * (Keep selling is the default, Escape keeps the cart). Every other way out (rail links, palette, user menu, g shortcuts, browser Back) goes through the same guard and
 * opens the same dialog.
 */
export function RegisterHeader({
  onOpenMobileNav,
  drivePill,
  tools,
}: {
  onOpenMobileNav: () => void;
  /** The shell's drive-mode exit pill (same component the full header renders). */
  drivePill?: React.ReactNode;
  /** The shell's bell, palette trigger and avatar/user menu (same component the full header renders). */
  tools?: React.ReactNode;
}) {
  const { branding } = useTenant();
  const router = useRouter();
  const hasLines = React.useSyncExternalStore(
    subscribeCounterCart,
    getCounterCartHasLines,
    () => false,
  );
  const busy = React.useSyncExternalStore(subscribeCounterCart, getCounterCartBusy, () => false);
  // The dialog is driven by the shared guard, so any way out (not just Exit) parks its leave behind it.
  const asking = React.useSyncExternalStore(
    subscribeCounterCart,
    getCounterLeaveRequest,
    () => false,
  );
  useCounterBackGuard(hasLines);
  const exitRef = React.useRef<HTMLButtonElement>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  // The notice is raised by the shared guard, so it also shows when a rail link, a g shortcut, the palette or the user menu was refused.
  const blocked = React.useSyncExternalStore(
    subscribeCounterCart,
    getCounterLeaveNotice,
    () => false,
  );
  const keepRef = React.useRef<HTMLButtonElement>(null);
  const storeName = branding?.businessName ?? "RouteFlow";

  return (
    <header
      data-testid="register-header"
      className="relative flex h-16 shrink-0 items-center gap-3 border-b border-surface-border bg-white px-4"
    >
      <button
        type="button"
        ref={exitRef}
        aria-disabled={busy || undefined}
        onClick={() => {
          const exit = () => router.push(readExitTarget());
          if (guardCounterLeave(exit)) return;
          exit();
        }}
        className={cn(
          TAP_TARGET,
          "gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-semibold text-navy transition-colors hover:bg-surface-raised",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
        )}
      >
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        Exit counter
      </button>
      <button
        type="button"
        onClick={onOpenMobileNav}
        className={cn(
          TAP_TARGET,
          "rounded-lg text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy lg:hidden",
        )}
        aria-label="Open navigation menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <p
        data-testid="register-store"
        title={storeName}
        className="min-w-[4rem] flex-1 truncate text-base font-semibold text-navy"
      >
        {storeName}
      </p>
      {drivePill}
      {tools}
      {blocked && (
        <p
          role="status"
          className="absolute inset-x-0 top-full z-10 border-b border-danger/30 bg-danger-bg px-4 py-2 text-xs font-medium text-danger"
        >
          {COUNTER_LEAVE_BLOCKED_COPY}
        </p>
      )}

      <Modal
        open={asking}
        onClose={cancelCounterLeave}
        title="Discard this sale?"
        className={DIALOG_FIT}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const was = document.activeElement;
          openerRef.current = was instanceof HTMLElement && was !== document.body ? was : null;
          keepRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          // Focus goes back to where the leave was asked from (Exit by default; a link or menu item that has since gone falls back to Exit).
          e.preventDefault();
          const back = openerRef.current?.isConnected ? openerRef.current : exitRef.current;
          back?.focus();
        }}
        footer={
          <>
            <Button
              ref={keepRef}
              variant="secondary"
              className={DIALOG_FOOTER_BUTTON}
              onClick={cancelCounterLeave}
            >
              Keep selling
            </Button>
            <Button variant="danger" className={DIALOG_FOOTER_BUTTON} onClick={confirmCounterLeave}>
              Discard
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          The items in this sale have not been completed. Leaving now clears the cart.
        </p>
      </Modal>
    </header>
  );
}

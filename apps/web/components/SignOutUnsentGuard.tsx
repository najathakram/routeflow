"use client";

import * as React from "react";
import { Button, Modal } from "@routeflow/ui/web";
import { getDraftMirrorStorage } from "@/lib/order-draft/storage";
import { countUnsentOrders, signOutDecision, unsentOrderCopy } from "@/lib/order-draft/sign-out";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "./dialog-mobile-fit";

/**
 * SA-817 (A) 6 / A8: wraps the user menu's "Sign out". With unsent orders on this device it asks first; otherwise it signs out
 * at once. "Sign out anyway" keeps the local copies (they come back at this user's next sign-in); a session expiry never goes
 * through here, so it never asks and never touches them.
 */
export function useGuardedSignOut(
  signOut: () => void,
  user: { id?: string; tenantId?: string | null } | null | undefined,
): {
  requestSignOut: () => void;
  dialog: React.ReactNode;
} {
  const [unsent, setUnsent] = React.useState<number | null>(null);

  const requestSignOut = React.useCallback(() => {
    void countUnsentOrders(getDraftMirrorStorage(), user?.tenantId, user?.id).then((n) => {
      if (signOutDecision("explicit", n).ask) setUnsent(n);
      else signOut();
    });
  }, [signOut, user?.tenantId, user?.id]);

  const dialog = (
    <Modal
      open={unsent !== null}
      onClose={() => setUnsent(null)}
      title="Sign out?"
      className={DIALOG_FIT}
      footer={
        <>
          <Button
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            onClick={() => setUnsent(null)}
          >
            Stay signed in
          </Button>
          <Button
            variant="danger"
            className={DIALOG_FOOTER_BUTTON}
            onClick={() => {
              setUnsent(null);
              signOut();
            }}
          >
            Sign out anyway
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        {unsent !== null ? `${unsentOrderCopy(unsent)}.` : ""} Signing out keeps your unsent work on
        this device for your next sign-in.
      </p>
    </Modal>
  );

  return { requestSignOut, dialog };
}

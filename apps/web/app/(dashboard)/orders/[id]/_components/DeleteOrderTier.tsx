"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@routeflow/ui/web";
import { Trash2 } from "lucide-react";
import { ActionTier } from "./ActionTier";

/** The inline "Delete order?" confirm in the danger tier (DRAFT and CANCELLED action rows; moved out of page.tsx). */
export function DeleteOrderTier({
  orderId,
  deleteOrder,
  open,
  setOpen,
  idleLabel,
  successTitle,
  errorText,
}: {
  orderId: string;
  deleteOrder: {
    isPending: boolean;
    mutate: (id: string, o: { onSuccess: () => void; onError: (e: unknown) => void }) => void;
  };
  open: boolean;
  setOpen: (next: boolean) => void;
  idleLabel: string;
  successTitle: string;
  errorText: (e: unknown) => string;
}) {
  const { toast } = useToast();
  const router = useRouter();
  return (
    <ActionTier tier="danger">
      {open ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-danger font-medium">Delete order?</span>
          <Button
            size="sm"
            variant="danger"
            loading={deleteOrder.isPending}
            onClick={() => {
              deleteOrder.mutate(orderId, {
                onSuccess: () => {
                  toast({ title: successTitle, variant: "success" });
                  router.push("/orders");
                },
                onError: (e) => {
                  toast({ title: errorText(e), variant: "error" });
                  setOpen(false);
                },
              });
            }}
          >
            Confirm Delete
          </Button>
          <button
            onClick={() => setOpen(false)}
            className="text-sm text-navy/70 hover:text-navy transition-colors"
          >
            No
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<Trash2 className="h-4 w-4" />}
          onClick={() => setOpen(true)}
        >
          {idleLabel}
        </Button>
      )}
    </ActionTier>
  );
}

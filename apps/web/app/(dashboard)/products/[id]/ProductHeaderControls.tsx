"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/lib/auth-context";

/**
 * The product Details card's view-mode actions: Make variant of…, Deactivate / Reactivate, the tobacco
 * toggle, and Delete (OPERATOR only, behind its own confirm). The pencil (Edit) stays in the page.
 */
export function ProductHeaderControls({
  product,
  reactivateFlow,
  hasTobaccoAddon,
  isTobacco,
  tobaccoLoading,
  onToggleTobacco,
  onMakeVariant,
  onDelete,
  deleting,
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
  /** Resolves when the delete finished (the confirm closes either way). */
  onDelete: () => Promise<void> | void;
  deleting: boolean;
}) {
  const { user } = useAuth();
  const isOperator = user?.role === "OPERATOR";
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <>
      {isOperator && !product.parentProductId && product.kind !== "FAMILY" && (
        <Button
          size="sm"
          variant="secondary"
          onClick={onMakeVariant}
          title="Link this product as a variant of another product"
        >
          Make variant of…
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          product.isActive
            ? reactivateFlow.askDeactivate(product.id, product.name)
            : reactivateFlow.start(product.id, "product", product.name)
        }
        loading={reactivateFlow.isPending}
      >
        {product.isActive ? "Deactivate" : "Reactivate"}
      </Button>
      {hasTobaccoAddon && (
        <Button
          size="sm"
          variant="secondary"
          onClick={onToggleTobacco}
          loading={tobaccoLoading}
          title="Tobacco products are tracked separately for monthly tax reports"
        >
          {isTobacco ? "Unmark tobacco" : "Mark as tobacco"}
        </Button>
      )}
      {isOperator && (
        <Button
          size="sm"
          variant="danger-outline"
          leftIcon={<Trash2 className="h-4 w-4" />}
          onClick={() => setConfirmOpen(true)}
        >
          Delete
        </Button>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          try {
            await onDelete();
          } finally {
            setConfirmOpen(false);
          }
        }}
        title="Delete product?"
        description={`${product.name} will be deactivated and hidden from the catalog. Its SKU and barcode are freed, so another product can use them. Order and invoice history is kept. A product on an undelivered order can't be deleted.`}
        confirmLabel="Yes, delete"
        variant="danger"
        loading={deleting}
      />
    </>
  );
}

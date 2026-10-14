"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";

/**
 * The product Details card's view-mode actions: Make variant of…, Deactivate / Reactivate, the tobacco
 * toggle, and Delete (OPERATOR only; it opens the page's DeleteProductConfirm). The pencil (Edit) stays in the page.
 */
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
  const isOperator = user?.role === "OPERATOR";

  return (
    <>
      {isOperator && !product.parentProductId && product.kind !== "FAMILY" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onMakeVariant}
          title="Link this product as a variant of another product"
        >
          Make variant of…
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
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
          variant="ghost"
          onClick={onToggleTobacco}
          loading={tobaccoLoading}
          title="Tobacco products are tracked separately for monthly tax reports"
        >
          {isTobacco ? "Unmark tobacco" : "Mark as tobacco"}
        </Button>
      )}
      {isOperator && (
        <div className="flex items-center max-sm:basis-full max-sm:justify-end sm:ml-2 sm:border-l sm:border-surface-border sm:pl-3">
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
    </>
  );
}

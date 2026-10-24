"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Layers } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { CreateFamilyModal } from "./CreateFamilyModal";

/**
 * "New family" for the products list header: OPERATOR / TENANT_ADMIN only (the endpoint's own gate).
 * `/products?newFamily=1` (the product page's "Create a family" link) opens the dialog once and the
 * param is consumed, so closing the dialog and typing in search never re-opens it.
 */
export function NewFamilyButton() {
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = React.useState(false);
  const allowed = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const wantsOpen = searchParams?.get("newFamily") === "1";

  React.useEffect(() => {
    if (!allowed || !wantsOpen) return;
    setOpen(true);
    const params = new URLSearchParams(window.location.search);
    params.delete("newFamily");
    const qs = params.toString();
    router.replace(qs ? `/products?${qs}` : "/products", { scroll: false });
  }, [allowed, wantsOpen, router]);

  if (!allowed) return null;
  return (
    <>
      <Button
        variant="secondary"
        leftIcon={<Layers className="h-4 w-4" />}
        onClick={() => setOpen(true)}
      >
        New family
      </Button>
      {open && <CreateFamilyModal open onClose={() => setOpen(false)} />}
    </>
  );
}

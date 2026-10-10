"use client";

import * as React from "react";
import { Layers } from "lucide-react";
import { Button } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { CreateFamilyModal } from "./CreateFamilyModal";

/** "New family" for the products list header: OPERATOR / TENANT_ADMIN only (the endpoint's own gate). */
export function NewFamilyButton() {
  const { user } = useAuth();
  const [open, setOpen] = React.useState(false);
  if (user?.role !== "OPERATOR" && user?.role !== "TENANT_ADMIN") return null;
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

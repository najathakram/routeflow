"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { PurchaseOrderDetail } from "./PurchaseOrderDetail";

/** Thin route for one purchase order. */
export default function PurchaseOrderPage() {
  const params = useParams<{ id: string }>();
  return <PurchaseOrderDetail id={params.id} />;
}

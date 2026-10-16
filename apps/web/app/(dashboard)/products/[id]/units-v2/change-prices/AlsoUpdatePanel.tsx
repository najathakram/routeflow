"use client";

import * as React from "react";
import type { CustomerChange, FollowerRow, PricePlan, PriceTier } from "@routeflow/pricing";
import type { AlsoUpdateSelection } from "./selection";

export interface AlsoUpdatePanelProps {
  plan: PricePlan;
  selection: AlsoUpdateSelection;
  onToggleOffer: (key: string, on: boolean) => void;
  onToggleKeep: (follower: FollowerRow, on: boolean) => void;
  onToggleCustomerKeep?: (change: CustomerChange, on: boolean) => void;
  heading?: string;
  tierName?: (tier: PriceTier) => string;
  customerName?: (customerId: string) => string;
  /** Change prices lists every moved price in its own preview, so it hides the follower rows here. */
  hideFollowers?: boolean;
  /** More opt-ins for the "Also update:" list (Change prices' "also move the prices you set"). */
  extraOffers?: React.ReactNode;
  /** Shows the footer "Undo this change" button. */
  onUndo?: () => void;
}

// STUB (red commit): renders nothing yet.
export function AlsoUpdatePanel(props: AlsoUpdatePanelProps) {
  void props;
  return <div data-testid="also-update-panel" />;
}

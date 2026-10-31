"use client";

import { registerDraftDockSlot } from "@/lib/draft-dock-slot";

/**
 * SA-1066 A-3: the till header's place for the draft dock's "Drafts (n)" button, after <ParkedSales>. It renders empty and
 * `empty:hidden` takes it out of the row's layout, so with no drafts parked there is no button and no gap; the dock
 * portals the button in only while a draft exists.
 */
export function DraftDockSlot() {
  return <div ref={registerDraftDockSlot} className="empty:hidden" data-testid="draft-dock-slot" />;
}

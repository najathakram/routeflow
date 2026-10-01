"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectSocket, disconnectSocket } from "../socket";
import {
  buyerNotificationsKey,
  buyerRefreshTokens,
  getBuyerAccessToken,
  getStoredActiveSeller,
  getStoredBuyerId,
} from "../buyer-auth";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BuyerNotificationType = "order" | "invoice" | "delivery";

export interface BuyerNotification {
  id: string;
  type: BuyerNotificationType;
  title: string;
  description: string;
  timestamp: number;
  read: boolean;
}

// ─── LocalStorage persistence ─────────────────────────────────────────────────

// #2142 N2/W2: one slot per buyer account and seller (`buyerNotificationsKey`), so the next
// buyer on this browser never inherits the last one's notices, and seller A's notices never show
// in seller B's portal; buyerLogout clears them all. With no identifiable buyer or no active
// seller nothing is read or written (the old unkeyed slots are never read: they may be anyone's).
const MAX_NOTIFICATIONS = 50;

function loadFromStorage(key: string | null): BuyerNotification[] {
  if (typeof window === "undefined" || !key) return [];
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as BuyerNotification[]) : [];
  } catch {
    return [];
  }
}

function saveToStorage(key: string | null, notifications: BuyerNotification[]) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(notifications));
  } catch {
    // ignore
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @param sellerTenantId the active seller's `tenant.id` (the portal layout passes its
 *   `activeSeller`); omitted, the stored active seller is read. Switching seller reloads that
 *   seller's own list.
 */
export function useBuyerNotifications(sellerTenantId?: string | null) {
  // #2167: the socket's token expired and could not be refreshed, so live updates have stopped.
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const qc = useQueryClient();
  const tenantId =
    sellerTenantId === undefined ? (getStoredActiveSeller()?.tenant?.id ?? null) : sellerTenantId;
  // This buyer's slot at this seller (null: persist nothing).
  const buyerId = getStoredBuyerId();
  const storageKey = buyerId && tenantId ? buyerNotificationsKey(buyerId, tenantId) : null;

  // #2173: the list and the slot it belongs to live in ONE state, so they can never disagree.
  // The first client render matches the server's empty list (no hydration mismatch); from then on
  // a key change reloads DURING render, so no frame ever paints the previous seller's notices (N1).
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);
  const [bell, setBell] = React.useState<{
    key: string | null | undefined;
    list: BuyerNotification[];
  }>(
    { key: undefined, list: [] }, // undefined: nothing loaded yet
  );
  let current = bell;
  if (hydrated && bell.key !== storageKey) {
    current = { key: storageKey, list: loadFromStorage(storageKey) };
    setBell(current);
  }
  const notifications = current.list;

  const push = React.useCallback((n: Omit<BuyerNotification, "id" | "timestamp" | "read">) => {
    const entry: BuyerNotification = {
      ...n,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      read: false,
    };
    // #2173 N2: the socket filter reads the STORED active seller, which can change a moment before
    // this bell re-renders with the new seller. Persist the event under that same seller's slot;
    // it joins the list on screen only when that list IS that slot.
    const eventBuyer = getStoredBuyerId();
    const eventTenant = getStoredActiveSeller()?.tenant?.id ?? null;
    const eventKey =
      eventBuyer && eventTenant ? buyerNotificationsKey(eventBuyer, eventTenant) : undefined;
    setBell((prev) => {
      if (eventKey !== undefined && eventKey !== prev.key) {
        saveToStorage(eventKey, [entry, ...loadFromStorage(eventKey)].slice(0, MAX_NOTIFICATIONS));
        return prev;
      }
      const list = [entry, ...prev.list].slice(0, MAX_NOTIFICATIONS);
      saveToStorage(prev.key ?? null, list);
      return { key: prev.key, list };
    });
  }, []);

  // Connect to WebSocket using the buyer's access token (A5: canonical
  // accessor — the legacy literal is unset for password logins).
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!getBuyerAccessToken()) return;

    // The getter, not the token: every reconnect presents the CURRENT buyer token (the buyer
    // client refreshes it on a 401), so a dropped socket does not come back on an expired one.
    // #2167: the server disconnects a socket whose token expired, and socket.io does not retry
    // after that. `recovery` refreshes through the buyer refresh flow and reconnects; when the
    // refresh fails the portal shows the expired state instead of failing silently.
    setSessionExpired(false);
    const socket = connectSocket(getBuyerAccessToken, {
      refresh: async () => (await buyerRefreshTokens()) !== null,
      onSessionExpired: () => setSessionExpired(true),
    });

    // B104: the server joins a buyer's socket to the rooms of EVERY seller it is linked to, so an
    // event may belong to another seller than the portal on screen. Caches are keyed by ids and
    // always refresh; the notification list is this portal's, so it only takes this seller's.
    const forActiveSeller = (customerId?: string) => {
      const seller = getStoredActiveSeller();
      return !customerId || !seller?.customer?.id || seller.customer.id === customerId;
    };

    const onOrderStatusChanged = (data: {
      orderId?: string;
      customerId?: string;
      orderNumber?: string;
      status?: string;
      previousStatus?: string;
    }) => {
      // #2095: the order detail and its "Track your delivery" card (keyed under the order),
      // the order list, the dashboard and the active draft all show this status.
      if (data.orderId) qc.invalidateQueries({ queryKey: ["buyer", "order", data.orderId] });
      qc.invalidateQueries({ queryKey: ["buyer", "orders"] });
      qc.invalidateQueries({ queryKey: ["buyer", "dashboard"] });
      qc.invalidateQueries({ queryKey: ["buyer", "activeOrder"] });
      if (!forActiveSeller(data.customerId)) return;
      const statusLabel = (data.status ?? "")
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
      push({
        type: "order",
        title: `Order ${statusLabel}`,
        description: `Order #${data.orderNumber ?? ""} status changed to ${statusLabel}`,
      });
    };

    const onInvoiceUpdated = (data: { invoiceNumber?: string; customerId?: string }) => {
      if (forActiveSeller(data.customerId)) {
        push({
          type: "invoice",
          title: "Invoice updated",
          description: `Invoice ${data.invoiceNumber ?? ""} has been updated`,
        });
      }
      // P5-12: keep the invoice-detail badge/balance live (e.g. a check
      // lifecycle change) instead of only surfacing a notification toast.
      qc.invalidateQueries({ queryKey: ["buyer", "invoice"] });
      // P5-14: a check lifecycle change (e.g. BOUNCED) also affects the
      // payments table and the statement/wallet balance — keep both live.
      qc.invalidateQueries({ queryKey: ["buyer", "payments"] });
      qc.invalidateQueries({ queryKey: ["buyer", "statement"] });
    };

    const onCreditNoteCreated = (data: { creditNoteNumber?: string; customerId?: string }) => {
      if (!forActiveSeller(data.customerId)) return;
      push({
        type: "invoice",
        title: "Credit note issued",
        description: `Credit note ${data.creditNoteNumber ?? ""} has been created`,
      });
    };

    // #2095: the run carrying a delivery moved (the payload is `{ runId }` only). Refetch every
    // order detail and its "Track your delivery" card; silent — no bell entry. A buyer's own
    // delivery arrives as order.statusChanged, so `route.stop.completed` (operators only) is not
    // subscribed here.
    const onRouteProgress = () => qc.invalidateQueries({ queryKey: ["buyer", "order"] });

    socket.on("order.statusChanged", onOrderStatusChanged);
    socket.on("invoice.updated", onInvoiceUpdated);
    socket.on("creditNote.created", onCreditNoteCreated);
    socket.on("route.progress", onRouteProgress);

    return () => {
      socket.off("order.statusChanged", onOrderStatusChanged);
      socket.off("invoice.updated", onInvoiceUpdated);
      socket.off("creditNote.created", onCreditNoteCreated);
      socket.off("route.progress", onRouteProgress);
      // The socket is this portal's: leaving it (or logging out) closes it, so a later staff
      // session in the same tab never inherits a buyer-authenticated connection (the shared
      // connectSocket returns any live socket as-is). Mirrors useRealtimeUpdates' cleanup.
      disconnectSocket();
    };
  }, [push, qc]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // Both act on the list on screen, so both write to that list's own slot.
  const markAllRead = React.useCallback(() => {
    setBell((prev) => {
      const list = prev.list.map((n) => ({ ...n, read: true }));
      saveToStorage(prev.key ?? null, list);
      return { key: prev.key, list };
    });
  }, []);

  const clearAll = React.useCallback(() => {
    setBell((prev) => {
      saveToStorage(prev.key ?? null, []);
      return { key: prev.key, list: [] };
    });
  }, []);

  return { notifications, unreadCount, markAllRead, clearAll, push, sessionExpired };
}

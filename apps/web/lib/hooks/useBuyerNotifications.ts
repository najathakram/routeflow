"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectSocket, disconnectSocket } from "../socket";
import { getBuyerAccessToken, getStoredActiveSeller } from "../buyer-auth";

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

const STORAGE_KEY = "rf_buyer_notifications";
const MAX_NOTIFICATIONS = 50;

function loadFromStorage(): BuyerNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BuyerNotification[]) : [];
  } catch {
    return [];
  }
}

function saveToStorage(notifications: BuyerNotification[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // ignore
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useBuyerNotifications() {
  const [notifications, setNotifications] = React.useState<BuyerNotification[]>([]);
  const qc = useQueryClient();

  React.useEffect(() => {
    setNotifications(loadFromStorage());
  }, []);

  const push = React.useCallback((n: Omit<BuyerNotification, "id" | "timestamp" | "read">) => {
    setNotifications((prev) => {
      const next = [
        {
          ...n,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          read: false,
        },
        ...prev,
      ].slice(0, MAX_NOTIFICATIONS);
      saveToStorage(next);
      return next;
    });
  }, []);

  // Connect to WebSocket using the buyer's access token (A5: canonical
  // accessor — the legacy literal is unset for password logins).
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!getBuyerAccessToken()) return;

    // The getter, not the token: every reconnect presents the CURRENT buyer token (the buyer
    // client refreshes it on a 401), so a dropped socket does not come back on an expired one.
    const socket = connectSocket(getBuyerAccessToken);

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

    const onStopCompleted = (data: { orderId?: string }) =>
      push({
        type: "delivery",
        title: "Delivery update",
        description: "Items from your order have been delivered",
      });

    socket.on("order.statusChanged", onOrderStatusChanged);
    socket.on("invoice.updated", onInvoiceUpdated);
    socket.on("creditNote.created", onCreditNoteCreated);
    socket.on("route.stop.completed", onStopCompleted);

    return () => {
      socket.off("order.statusChanged", onOrderStatusChanged);
      socket.off("invoice.updated", onInvoiceUpdated);
      socket.off("creditNote.created", onCreditNoteCreated);
      socket.off("route.stop.completed", onStopCompleted);
      // The socket is this portal's: leaving it (or logging out) closes it, so a later staff
      // session in the same tab never inherits a buyer-authenticated connection (the shared
      // connectSocket returns any live socket as-is). Mirrors useRealtimeUpdates' cleanup.
      disconnectSocket();
    };
  }, [push, qc]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = React.useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      saveToStorage(next);
      return next;
    });
  }, []);

  const clearAll = React.useCallback(() => {
    setNotifications([]);
    saveToStorage([]);
  }, []);

  return { notifications, unreadCount, markAllRead, clearAll, push };
}

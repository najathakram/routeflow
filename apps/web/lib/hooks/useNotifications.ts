"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectSocket } from "../socket";
import { OP_KEYS } from "../auth-keys";
import { pendingApprovalsKey } from "../api/portal-approvals";
import { useTenant } from "@/components/tenant-provider";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationType = "urgent" | "route" | "driver" | "stock" | "buyer" | "crm";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  timestamp: number;
  read: boolean;
  /** Optional deep link — when set, the bell renders the item as a link (e.g. crm.lead.handoff). */
  href?: string;
}

// ─── LocalStorage persistence ─────────────────────────────────────────────────

// Pre-tenant-scoping key: its data can't be attributed to a tenant, so it is
// deleted on load rather than migrated (migrating IS the cross-tenant leak).
const LEGACY_STORAGE_KEY = "rf_notifications";
const MAX_NOTIFICATIONS = 50;

function storageKey(slug: string): string {
  return `rf_notifications:${slug}`;
}

function loadFromStorage(slug: string | null): AppNotification[] {
  if (typeof window === "undefined" || !slug) return [];
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = localStorage.getItem(storageKey(slug));
    return raw ? (JSON.parse(raw) as AppNotification[]) : [];
  } catch {
    return [];
  }
}

function saveToStorage(slug: string | null, notifications: AppNotification[]) {
  if (!slug) return;
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(notifications));
  } catch {
    // ignore quota / security errors
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useNotifications() {
  const [notifications, setNotifications] = React.useState<AppNotification[]>([]);
  const queryClient = useQueryClient();
  // TenantProvider owns slug resolution (JWT wins over cookie, self-heals, and
  // re-resolves on tab focus after a multi-tab impersonation switch).
  const { slug } = useTenant();
  // Mirrors `slug` so push/markAllRead/clear keep stable identities (the socket
  // effect depends on `push`) while still writing to the current tenant's key.
  const slugRef = React.useRef<string | null>(null);

  // (Re)hydrate whenever the tenant resolves or switches — per-tenant keys mean
  // a switch must drop the previous tenant's history, not carry it over.
  React.useEffect(() => {
    slugRef.current = slug;
    setNotifications(loadFromStorage(slug));
  }, [slug]);

  const push = React.useCallback((n: Omit<AppNotification, "id" | "timestamp" | "read">) => {
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
      saveToStorage(slugRef.current, next);
      return next;
    });
  }, []);

  // Attach WebSocket event listeners
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem(OP_KEYS.accessToken);
    if (!token) return;

    const socket = connectSocket(token);

    // Named handlers so we can remove exactly these (not all listeners for the event)
    const onUrgentOrder = (data: { orderNumber: string; customerName: string }) =>
      push({
        type: "urgent",
        title: "Urgent order placed",
        description: `${data.customerName} — order #${data.orderNumber}`,
      });

    const onStopCompleted = (data?: { stopNumber?: number; customerName?: string }) =>
      push({
        type: "route",
        title: "Stop completed",
        description: data?.customerName
          ? `Stop #${data.stopNumber ?? ""} delivered to ${data.customerName}`
          : "A delivery stop has been marked complete",
      });

    const onDriverStatus = (data: { driverName: string; status: string }) =>
      push({
        type: "driver",
        title: "Driver status changed",
        description: `${data.driverName} is now ${data.status.toLowerCase()}`,
      });

    const onLowStock = (data: { productName: string; stockLevel: number }) =>
      push({
        type: "stock",
        title: "Low stock alert",
        description: `${data.productName} — ${data.stockLevel} unit${data.stockLevel === 1 ? "" : "s"} remaining`,
      });

    // Buyer-connect: sign-in email didn't match the customer record, so the
    // request needs seller review — actionable, and it also drives the
    // pending-approvals query so the bell's pinned section picks it up
    // immediately instead of waiting for its 60s poll.
    const onBuyerConnectRequested = (data: {
      customerId: string;
      customerName: string;
      buyerName: string;
      buyerEmail: string;
      requestedAt?: string;
    }) => {
      push({
        type: "buyer",
        title: "New buyer request",
        description: `${data.buyerName} wants to connect to ${data.customerName}`,
      });
      void queryClient.invalidateQueries({ queryKey: pendingApprovalsKey });
    };

    // Buyer-connect: sign-in email matched, so it connected straight to
    // ACTIVE — informational only, no pending-approvals row to invalidate.
    const onBuyerAutoLinked = (data: {
      customerId: string;
      customerName: string;
      buyerName: string;
      buyerEmail: string;
    }) =>
      push({
        type: "buyer",
        title: "Buyer connected",
        description: `${data.buyerName} connected to ${data.customerName}`,
      });

    // GoHighLevel lead handoff (spec R30) — a customer was just created/linked from a
    // GoHighLevel lead; the bell entry links straight to the new customer record.
    const onCrmHandoff = (data: { customerId: string; customerName: string }) =>
      push({
        type: "crm",
        title: "New customer from GoHighLevel",
        description: `${data.customerName} — finish onboarding`,
        href: `/customers/${data.customerId}`,
      });

    socket.on("order.urgent.placed", onUrgentOrder);
    socket.on("route.stop.completed", onStopCompleted);
    socket.on("driver.status.updated", onDriverStatus);
    socket.on("inventory.low.stock", onLowStock);
    socket.on("buyer.connect.requested", onBuyerConnectRequested);
    socket.on("buyer.connect.autolinked", onBuyerAutoLinked);
    socket.on("crm.lead.handoff", onCrmHandoff);

    return () => {
      socket.off("order.urgent.placed", onUrgentOrder);
      socket.off("route.stop.completed", onStopCompleted);
      socket.off("driver.status.updated", onDriverStatus);
      socket.off("inventory.low.stock", onLowStock);
      socket.off("buyer.connect.requested", onBuyerConnectRequested);
      socket.off("buyer.connect.autolinked", onBuyerAutoLinked);
      socket.off("crm.lead.handoff", onCrmHandoff);
    };
  }, [push, queryClient]);

  const markAllRead = React.useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      saveToStorage(slugRef.current, next);
      return next;
    });
  }, []);

  const clear = React.useCallback(() => {
    setNotifications([]);
    saveToStorage(slugRef.current, []);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return { notifications, unreadCount, markAllRead, clear };
}

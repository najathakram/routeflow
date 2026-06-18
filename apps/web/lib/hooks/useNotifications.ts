"use client";

import * as React from "react";
import { connectSocket } from "../socket";
import { OP_KEYS } from "../auth-keys";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationType = "urgent" | "route" | "driver" | "stock";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  timestamp: number;
  read: boolean;
}

// ─── LocalStorage persistence ─────────────────────────────────────────────────

const STORAGE_KEY = "rf_notifications";
const MAX_NOTIFICATIONS = 50;

function loadFromStorage(): AppNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AppNotification[]) : [];
  } catch {
    return [];
  }
}

function saveToStorage(notifications: AppNotification[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // ignore quota / security errors
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useNotifications() {
  const [notifications, setNotifications] = React.useState<AppNotification[]>([]);

  // Hydrate from localStorage on mount (client only)
  React.useEffect(() => {
    setNotifications(loadFromStorage());
  }, []);

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
      saveToStorage(next);
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

    socket.on("order.urgent.placed", onUrgentOrder);
    socket.on("route.stop.completed", onStopCompleted);
    socket.on("driver.status.updated", onDriverStatus);
    socket.on("inventory.low.stock", onLowStock);

    return () => {
      socket.off("order.urgent.placed", onUrgentOrder);
      socket.off("route.stop.completed", onStopCompleted);
      socket.off("driver.status.updated", onDriverStatus);
      socket.off("inventory.low.stock", onLowStock);
    };
  }, [push]);

  const markAllRead = React.useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      saveToStorage(next);
      return next;
    });
  }, []);

  const clear = React.useCallback(() => {
    setNotifications([]);
    saveToStorage([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return { notifications, unreadCount, markAllRead, clear };
}

import type { BadgeStatus } from "@routeflow/ui/web";

// ─── KPI ─────────────────────────────────────────────────────────────────────

export const kpi = {
  activeOrders: 24,
  routesToday: 3,
  driversOnRoad: 2,
  lowStockItems: 5,
};

// ─── Urgent orders ────────────────────────────────────────────────────────────

export interface UrgentOrder {
  id: string;
  customer: string;
  itemsCount: number;
  minutesAgo: number;
}

export const urgentOrders: UrgentOrder[] = [
  { id: "ORD-1042", customer: "Big Tex BBQ Supply Co.", itemsCount: 12, minutesAgo: 47 },
  { id: "ORD-1038", customer: "Lone Star Foodservice", itemsCount: 6, minutesAgo: 82 },
  { id: "ORD-1031", customer: "Hill Country Fresh Produce", itemsCount: 22, minutesAgo: 134 },
];

// ─── Active routes ────────────────────────────────────────────────────────────

export type RouteStatus = Extract<BadgeStatus, "IN_PROGRESS" | "COMPLETED" | "SCHEDULED">;

export interface ActiveRoute {
  id: string;
  name: string;
  driver: string;
  status: RouteStatus;
  stopsDone: number;
  stopsTotal: number;
  startTime: string;
}

export const activeRoutes: ActiveRoute[] = [
  {
    id: "RTE-201",
    name: "North Austin Loop",
    driver: "Marcus Webb",
    status: "IN_PROGRESS",
    stopsDone: 4,
    stopsTotal: 8,
    startTime: "6:30 AM",
  },
  {
    id: "RTE-202",
    name: "San Marcos Express",
    driver: "Darlene Trevino",
    status: "IN_PROGRESS",
    stopsDone: 2,
    stopsTotal: 6,
    startTime: "7:15 AM",
  },
  {
    id: "RTE-203",
    name: "Round Rock Commercial",
    driver: "Jesse Gallegos",
    status: "COMPLETED",
    stopsDone: 5,
    stopsTotal: 5,
    startTime: "5:45 AM",
  },
];

// ─── Drivers ──────────────────────────────────────────────────────────────────

export type DriverOnlineStatus = "on_route" | "idle";

export interface Driver {
  id: string;
  name: string;
  onlineStatus: DriverOnlineStatus;
  currentRoute?: string;
  lastPing: string;
}

export const drivers: Driver[] = [
  {
    id: "DRV-01",
    name: "Marcus Webb",
    onlineStatus: "on_route",
    currentRoute: "North Austin Loop",
    lastPing: "2 min ago",
  },
  {
    id: "DRV-02",
    name: "Darlene Trevino",
    onlineStatus: "on_route",
    currentRoute: "San Marcos Express",
    lastPing: "5 min ago",
  },
  {
    id: "DRV-03",
    name: "Jesse Gallegos",
    onlineStatus: "idle",
    lastPing: "1 hr ago",
  },
];

// ─── Recent orders ────────────────────────────────────────────────────────────

export type OrderStatus = Extract<
  BadgeStatus,
  "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "COMPLETED" | "CANCELLED"
>;

export interface RecentOrder {
  id: string;
  orderNumber: string;
  customer: string;
  items: number;
  total: number;
  status: OrderStatus;
  date: string;
}

export const recentOrders: RecentOrder[] = [
  {
    id: "1",
    orderNumber: "ORD-1042",
    customer: "Big Tex BBQ Supply Co.",
    items: 12,
    total: 1284.5,
    status: "PENDING",
    date: "Mar 9, 2026",
  },
  {
    id: "2",
    orderNumber: "ORD-1041",
    customer: "Alamo Restaurant Group",
    items: 8,
    total: 972.0,
    status: "OUT_FOR_DELIVERY",
    date: "Mar 9, 2026",
  },
  {
    id: "3",
    orderNumber: "ORD-1040",
    customer: "Pecos River Distributors",
    items: 31,
    total: 3410.75,
    status: "COMPLETED",
    date: "Mar 8, 2026",
  },
  {
    id: "4",
    orderNumber: "ORD-1039",
    customer: "Bluebonnet Bakery Supply",
    items: 5,
    total: 418.25,
    status: "COMPLETED",
    date: "Mar 8, 2026",
  },
  {
    id: "5",
    orderNumber: "ORD-1038",
    customer: "Lone Star Foodservice",
    items: 6,
    total: 675.0,
    status: "PENDING",
    date: "Mar 7, 2026",
  },
];

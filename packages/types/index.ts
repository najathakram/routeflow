// ─── Enums ────────────────────────────────────────────────────────────────────

export enum UserRole {
  OPERATOR = "OPERATOR",
  CUSTOMER = "CUSTOMER",
  DRIVER = "DRIVER",
}

export enum OrderStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  PICKING_UP = "PICKING_UP",
  IN_TRANSIT = "IN_TRANSIT",
  DELIVERED = "DELIVERED",
  CANCELLED = "CANCELLED",
}

export enum RouteStatus {
  DRAFT = "DRAFT",
  ACTIVE = "ACTIVE",
  COMPLETED = "COMPLETED",
  ARCHIVED = "ARCHIVED",
}

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  createdAt: string;
}

export interface Order {
  id: string;
  status: OrderStatus;
  customerId: string;
  driverId?: string;
  createdAt: string;
}

export interface Route {
  id: string;
  status: RouteStatus;
  driverId: string;
  orderIds: string[];
  createdAt: string;
}

export interface ApiResponse<T> {
  data: T;
  message: string;
  success: boolean;
}

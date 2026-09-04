// ─── Routes / drivers / trips (wave E / imp-10b) ────────────────────────────────

export interface RouteSettings {
  averageSpeedKmh: number;
  serviceTimeMinutes: number;
  defaultStartTime: string;
  depotLat: number | null;
  depotLng: number | null;
  depotAddress: string;
}

export interface StopETA {
  stopId: string;
  stopNumber: number;
  customerName: string;
  arrivalTime: string;
  departureTime: string;
  travelTimeMinutes: number;
  deliveryWindowStart?: string | null;
  deliveryWindowEnd?: string | null;
  withinWindow: boolean | null;
}

export interface RouteAnalysisResult {
  configured: boolean;
  summary?: string;
  stops?: Array<{
    stopNumber: number;
    status: "ok" | "warning" | "critical";
    message: string;
  }>;
  suggestions?: string[];
  etas: StopETA[];
}

export type TripIneligibleReason =
  | "SHIP_FULFILLMENT"
  | "INELIGIBLE_STATUS"
  | "ON_ACTIVE_RUN"
  | "PREVIOUSLY_DISPATCHED"
  | "NO_ADDRESS"
  | "NOT_FOUND";

export interface TripEligibilityRow {
  orderId: string;
  orderNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  eligible: boolean;
  reason?: TripIneligibleReason;
  detail?: string;
}

export type TripOrigin =
  | { type: "TENANT" }
  | { type: "DRIVER"; driverId: string }
  | { type: "ADDRESS"; line1: string; city?: string; state?: string; zip?: string };

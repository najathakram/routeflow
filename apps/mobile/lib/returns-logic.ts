/**
 * Pure returns helpers — status pill + which actions the current status allows.
 * The action flags mirror the server's transition guards exactly so the UI never
 * fires a doomed request (approve/reject only from PENDING; in-transit only from
 * APPROVED; receive only from IN_TRANSIT; refund only from RECEIVED).
 */

export type ReturnPillVariant = "orange" | "brand" | "green" | "gray" | "red";

export function returnPillFor(status: string): { variant: ReturnPillVariant; label: string } {
  switch (status) {
    case "PENDING":
      return { variant: "orange", label: "Pending" };
    case "APPROVED":
      return { variant: "brand", label: "Approved" };
    case "IN_TRANSIT":
      return { variant: "brand", label: "In transit" };
    case "RECEIVED":
      return { variant: "brand", label: "Received" };
    case "REFUNDED":
      return { variant: "green", label: "Refunded" };
    case "PROCESSED":
      return { variant: "green", label: "Processed" };
    case "REJECTED":
      return { variant: "red", label: "Rejected" };
    case "CANCELLED":
      return { variant: "gray", label: "Cancelled" };
    default:
      return { variant: "gray", label: status };
  }
}

export interface ReturnActionFlags {
  canApprove: boolean;
  canReject: boolean;
  canMarkInTransit: boolean;
  canReceive: boolean;
  canRefund: boolean;
  /** No further action — a terminal status. */
  terminal: boolean;
}

export function returnActionFlags(status: string): ReturnActionFlags {
  const canApprove = status === "PENDING";
  const canReject = status === "PENDING";
  const canMarkInTransit = status === "APPROVED";
  const canReceive = status === "IN_TRANSIT";
  const canRefund = status === "RECEIVED";
  const terminal =
    status === "REFUNDED" ||
    status === "PROCESSED" ||
    status === "REJECTED" ||
    status === "CANCELLED";
  return { canApprove, canReject, canMarkInTransit, canReceive, canRefund, terminal };
}

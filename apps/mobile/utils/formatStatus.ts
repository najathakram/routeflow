/** Converts a raw enum string like "OUT_FOR_DELIVERY" to "Out for delivery". */
function humanize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export type PillVariant = "green" | "orange" | "brand" | "gray";

export interface StatusPill {
  label: string;
  variant: PillVariant;
}

export function orderStatusPill(status: string): StatusPill {
  switch (status) {
    case "DRAFT":            return { label: "Draft",           variant: "gray" };
    case "PENDING":          return { label: "Pending",         variant: "orange" };
    case "CONFIRMED":        return { label: "Confirmed",       variant: "brand" };
    case "OUT_FOR_DELIVERY": return { label: "Out for delivery",variant: "brand" };
    case "DELIVERED":        return { label: "Delivered",       variant: "green" };
    case "CANCELLED":        return { label: "Cancelled",       variant: "gray" };
    default:                 return { label: humanize(status),  variant: "gray" };
  }
}

export function invoiceStatusPill(status: string, isOverdue?: boolean): StatusPill {
  if (isOverdue) return { label: "Overdue", variant: "gray" };
  switch (status) {
    case "DRAFT":       return { label: "Draft",   variant: "gray" };
    case "SENT":
    case "VIEWED":      return { label: "Unpaid",  variant: "orange" };
    case "PARTIAL":     return { label: "Partial", variant: "orange" };
    case "PAID":        return { label: "Paid",    variant: "green" };
    case "OVERDUE":     return { label: "Overdue", variant: "gray" };
    case "VOID":        return { label: "Void",    variant: "gray" };
    case "WRITTEN_OFF": return { label: "Written off", variant: "gray" };
    default:            return { label: humanize(status), variant: "gray" };
  }
}

export function expenseStatusPill(status: string): StatusPill {
  switch (status) {
    case "PENDING":  return { label: "Pending",  variant: "orange" };
    case "RECEIVED": return { label: "Received", variant: "orange" };
    case "PAID":     return { label: "Paid",     variant: "green" };
    case "VOID":     return { label: "Void",     variant: "gray" };
    default:         return { label: humanize(status), variant: "gray" };
  }
}

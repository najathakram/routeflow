import type { BadgeStatus } from "@routeflow/ui/web";

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderStatus = Extract<
  BadgeStatus,
  "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "COMPLETED" | "CANCELLED"
>;

export type LineItemStatus = Extract<
  BadgeStatus,
  "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "COMPLETED" | "CANCELLED"
>;

export interface LineItem {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  qty: number;
  unitPrice: number;
  status: LineItemStatus;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  routeId?: string;
  routeName?: string;
  status: OrderStatus;
  isUrgent: boolean;
  createdAt: string;
  notes: string;
  lineItems: LineItem[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function orderTotal(order: Order): number {
  return order.lineItems.reduce((sum, li) => sum + li.qty * li.unitPrice, 0);
}

export function getOrder(id: string): Order | undefined {
  return orders.find((o) => o.id === id);
}

// ─── Mock data ────────────────────────────────────────────────────────────────

export const orders: Order[] = [
  {
    id: "1",
    orderNumber: "ORD-1042",
    customerId: "CUS-001",
    customerName: "Big Tex BBQ Supply Co.",
    routeId: "RTE-201",
    routeName: "North Austin Loop",
    status: "PENDING",
    isUrgent: true,
    createdAt: "Mar 9, 2026 · 6:14 AM",
    notes: "Customer called — needs delivery before 10 AM. Loading dock requires 30-min notice.",
    lineItems: [
      { id: "li1", productId: "PRD-001", productName: "Big Red Soda", sku: "BEV-001", qty: 4, unitPrice: 18.99, status: "PENDING" },
      { id: "li2", productId: "PRD-006", productName: "BBQ Kettle Chips", sku: "SNK-001", qty: 6, unitPrice: 6.49, status: "PENDING" },
      { id: "li3", productId: "PRD-011", productName: "Commercial Degreaser", sku: "CLN-001", qty: 2, unitPrice: 22.99, status: "PENDING" },
    ],
  },
  {
    id: "2",
    orderNumber: "ORD-1041",
    customerId: "CUS-004",
    customerName: "Alamo Restaurant Group",
    routeId: "RTE-202",
    routeName: "San Marcos Express",
    status: "OUT_FOR_DELIVERY",
    isUrgent: false,
    createdAt: "Mar 9, 2026 · 5:00 AM",
    notes: "",
    lineItems: [
      { id: "li4", productId: "PRD-010", productName: "Corn Tortilla Chips", sku: "SNK-005", qty: 5, unitPrice: 11.99, status: "OUT_FOR_DELIVERY" },
      { id: "li5", productId: "PRD-011", productName: "Commercial Degreaser", sku: "CLN-001", qty: 1, unitPrice: 22.99, status: "OUT_FOR_DELIVERY" },
    ],
  },
  {
    id: "3",
    orderNumber: "ORD-1040",
    customerId: "CUS-005",
    customerName: "Pecos River Distributors",
    routeId: "RTE-203",
    routeName: "Round Rock Commercial",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 8, 2026 · 3:45 PM",
    notes: "Pallet jack required.",
    lineItems: [
      { id: "li6", productId: "PRD-014", productName: "Mop Bucket with Wringer", sku: "CLN-004", qty: 2, unitPrice: 54.99, status: "COMPLETED" },
      { id: "li7", productId: "PRD-011", productName: "Commercial Degreaser", sku: "CLN-001", qty: 3, unitPrice: 22.99, status: "COMPLETED" },
      { id: "li8", productId: "PRD-013", productName: "Sanitizer Concentrate", sku: "CLN-003", qty: 2, unitPrice: 31.99, status: "COMPLETED" },
      { id: "li9", productId: "PRD-015", productName: "Microfiber Towel Pack", sku: "CLN-005", qty: 4, unitPrice: 27.99, status: "COMPLETED" },
    ],
  },
  {
    id: "4",
    orderNumber: "ORD-1039",
    customerId: "CUS-006",
    customerName: "Bluebonnet Bakery Supply",
    routeId: "RTE-204",
    routeName: "South Austin Circuit",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 8, 2026 · 11:22 AM",
    notes: "",
    lineItems: [
      { id: "li10", productId: "PRD-005", productName: "Sparkling Water Case", sku: "BEV-005", qty: 3, unitPrice: 21.99, status: "COMPLETED" },
      { id: "li11", productId: "PRD-009", productName: "Pecan Pralines", sku: "SNK-004", qty: 2, unitPrice: 14.99, status: "COMPLETED" },
    ],
  },
  {
    id: "5",
    orderNumber: "ORD-1038",
    customerId: "CUS-002",
    customerName: "Lone Star Foodservice",
    routeId: "RTE-201",
    routeName: "North Austin Loop",
    status: "PENDING",
    isUrgent: true,
    createdAt: "Mar 7, 2026 · 4:52 PM",
    notes: "Time-sensitive — product needed for weekend event. Escalate if not confirmed by EOD.",
    lineItems: [
      { id: "li12", productId: "PRD-012", productName: "Industrial Hand Soap", sku: "CLN-002", qty: 1, unitPrice: 39.99, status: "PENDING" },
      { id: "li13", productId: "PRD-015", productName: "Microfiber Towel Pack", sku: "CLN-005", qty: 2, unitPrice: 27.99, status: "PENDING" },
    ],
  },
  {
    id: "6",
    orderNumber: "ORD-1037",
    customerId: "CUS-007",
    customerName: "Texas Pride Meat Market",
    routeId: "RTE-202",
    routeName: "San Marcos Express",
    status: "CONFIRMED",
    isUrgent: false,
    createdAt: "Mar 7, 2026 · 9:10 AM",
    notes: "Temperature-controlled delivery required.",
    lineItems: [
      { id: "li14", productId: "PRD-008", productName: "Beef Jerky Strips", sku: "SNK-003", qty: 6, unitPrice: 9.99, status: "CONFIRMED" },
      { id: "li15", productId: "PRD-007", productName: "Jalapeño Peanuts", sku: "SNK-002", qty: 4, unitPrice: 5.99, status: "CONFIRMED" },
    ],
  },
  {
    id: "7",
    orderNumber: "ORD-1036",
    customerId: "CUS-009",
    customerName: "Cowboy Kitchen Supplies",
    routeId: "RTE-203",
    routeName: "Round Rock Commercial",
    status: "CONFIRMED",
    isUrgent: false,
    createdAt: "Mar 6, 2026 · 2:30 PM",
    notes: "Afternoon delivery only (after 2 PM).",
    lineItems: [
      { id: "li16", productId: "PRD-014", productName: "Mop Bucket with Wringer", sku: "CLN-004", qty: 1, unitPrice: 54.99, status: "CONFIRMED" },
      { id: "li17", productId: "PRD-015", productName: "Microfiber Towel Pack", sku: "CLN-005", qty: 2, unitPrice: 27.99, status: "CONFIRMED" },
      { id: "li18", productId: "PRD-011", productName: "Commercial Degreaser", sku: "CLN-001", qty: 1, unitPrice: 22.99, status: "CONFIRMED" },
    ],
  },
  {
    id: "8",
    orderNumber: "ORD-1035",
    customerId: "CUS-010",
    customerName: "Rio Grande Provisions",
    routeId: "RTE-205",
    routeName: "Georgetown Corridor",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 6, 2026 · 8:00 AM",
    notes: "",
    lineItems: [
      { id: "li19", productId: "PRD-001", productName: "Big Red Soda", sku: "BEV-001", qty: 6, unitPrice: 18.99, status: "COMPLETED" },
      { id: "li20", productId: "PRD-002", productName: "Lone Star Beer", sku: "BEV-002", qty: 4, unitPrice: 13.49, status: "COMPLETED" },
    ],
  },
  {
    id: "9",
    orderNumber: "ORD-1034",
    customerId: "CUS-003",
    customerName: "Hill Country Fresh Produce",
    routeId: "RTE-201",
    routeName: "North Austin Loop",
    status: "CANCELLED",
    isUrgent: false,
    createdAt: "Mar 5, 2026 · 7:40 AM",
    notes: "Customer cancelled — refrigerated truck unavailable.",
    lineItems: [
      { id: "li21", productId: "PRD-004", productName: "Sweet Tea Gallon Jug", sku: "BEV-004", qty: 8, unitPrice: 4.99, status: "CANCELLED" },
      { id: "li22", productId: "PRD-005", productName: "Sparkling Water Case", sku: "BEV-005", qty: 4, unitPrice: 21.99, status: "CANCELLED" },
    ],
  },
  {
    id: "10",
    orderNumber: "ORD-1033",
    customerId: "CUS-001",
    customerName: "Big Tex BBQ Supply Co.",
    routeId: "RTE-201",
    routeName: "North Austin Loop",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 5, 2026 · 6:00 AM",
    notes: "",
    lineItems: [
      { id: "li23", productId: "PRD-003", productName: "Dr Pepper", sku: "BEV-003", qty: 3, unitPrice: 17.99, status: "COMPLETED" },
      { id: "li24", productId: "PRD-007", productName: "Jalapeño Peanuts", sku: "SNK-002", qty: 5, unitPrice: 5.99, status: "COMPLETED" },
    ],
  },
  {
    id: "11",
    orderNumber: "ORD-1032",
    customerId: "CUS-004",
    customerName: "Alamo Restaurant Group",
    routeId: "RTE-202",
    routeName: "San Marcos Express",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 4, 2026 · 10:15 AM",
    notes: "",
    lineItems: [
      { id: "li25", productId: "PRD-010", productName: "Corn Tortilla Chips", sku: "SNK-005", qty: 8, unitPrice: 11.99, status: "COMPLETED" },
      { id: "li26", productId: "PRD-009", productName: "Pecan Pralines", sku: "SNK-004", qty: 3, unitPrice: 14.99, status: "COMPLETED" },
    ],
  },
  {
    id: "12",
    orderNumber: "ORD-1031",
    customerId: "CUS-003",
    customerName: "Hill Country Fresh Produce",
    routeId: "RTE-201",
    routeName: "North Austin Loop",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 4, 2026 · 7:00 AM",
    notes: "30-min call ahead required.",
    lineItems: [
      { id: "li27", productId: "PRD-003", productName: "Dr Pepper", sku: "BEV-003", qty: 5, unitPrice: 17.99, status: "COMPLETED" },
      { id: "li28", productId: "PRD-005", productName: "Sparkling Water Case", sku: "BEV-005", qty: 6, unitPrice: 21.99, status: "COMPLETED" },
      { id: "li29", productId: "PRD-001", productName: "Big Red Soda", sku: "BEV-001", qty: 3, unitPrice: 18.99, status: "COMPLETED" },
    ],
  },
  {
    id: "13",
    orderNumber: "ORD-1030",
    customerId: "CUS-007",
    customerName: "Texas Pride Meat Market",
    routeId: "RTE-203",
    routeName: "Round Rock Commercial",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 3, 2026 · 9:00 AM",
    notes: "",
    lineItems: [
      { id: "li30", productId: "PRD-008", productName: "Beef Jerky Strips", sku: "SNK-003", qty: 4, unitPrice: 9.99, status: "COMPLETED" },
    ],
  },
  {
    id: "14",
    orderNumber: "ORD-1029",
    customerId: "CUS-004",
    customerName: "Alamo Restaurant Group",
    routeId: "RTE-202",
    routeName: "San Marcos Express",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 3, 2026 · 6:30 AM",
    notes: "",
    lineItems: [
      { id: "li31", productId: "PRD-010", productName: "Corn Tortilla Chips", sku: "SNK-005", qty: 10, unitPrice: 11.99, status: "COMPLETED" },
      { id: "li32", productId: "PRD-012", productName: "Industrial Hand Soap", sku: "CLN-002", qty: 2, unitPrice: 39.99, status: "COMPLETED" },
      { id: "li33", productId: "PRD-013", productName: "Sanitizer Concentrate", sku: "CLN-003", qty: 1, unitPrice: 31.99, status: "COMPLETED" },
    ],
  },
  {
    id: "15",
    orderNumber: "ORD-1028",
    customerId: "CUS-005",
    customerName: "Pecos River Distributors",
    routeId: "RTE-205",
    routeName: "Georgetown Corridor",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 2, 2026 · 4:00 PM",
    notes: "",
    lineItems: [
      { id: "li34", productId: "PRD-014", productName: "Mop Bucket with Wringer", sku: "CLN-004", qty: 3, unitPrice: 54.99, status: "COMPLETED" },
      { id: "li35", productId: "PRD-011", productName: "Commercial Degreaser", sku: "CLN-001", qty: 2, unitPrice: 22.99, status: "COMPLETED" },
    ],
  },
  {
    id: "16",
    orderNumber: "ORD-1027",
    customerId: "CUS-002",
    customerName: "Lone Star Foodservice",
    routeId: "RTE-202",
    routeName: "San Marcos Express",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 2, 2026 · 8:15 AM",
    notes: "",
    lineItems: [
      { id: "li36", productId: "PRD-003", productName: "Dr Pepper", sku: "BEV-003", qty: 4, unitPrice: 17.99, status: "COMPLETED" },
      { id: "li37", productId: "PRD-006", productName: "BBQ Kettle Chips", sku: "SNK-001", qty: 3, unitPrice: 6.49, status: "COMPLETED" },
    ],
  },
  {
    id: "17",
    orderNumber: "ORD-1026",
    customerId: "CUS-009",
    customerName: "Cowboy Kitchen Supplies",
    routeId: "RTE-203",
    routeName: "Round Rock Commercial",
    status: "CANCELLED",
    isUrgent: false,
    createdAt: "Mar 1, 2026 · 3:22 PM",
    notes: "Order placed in error — duplicate of ORD-1025.",
    lineItems: [
      { id: "li38", productId: "PRD-014", productName: "Mop Bucket with Wringer", sku: "CLN-004", qty: 1, unitPrice: 54.99, status: "CANCELLED" },
    ],
  },
  {
    id: "18",
    orderNumber: "ORD-1025",
    customerId: "CUS-009",
    customerName: "Cowboy Kitchen Supplies",
    routeId: "RTE-203",
    routeName: "Round Rock Commercial",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Mar 1, 2026 · 11:00 AM",
    notes: "",
    lineItems: [
      { id: "li39", productId: "PRD-014", productName: "Mop Bucket with Wringer", sku: "CLN-004", qty: 1, unitPrice: 54.99, status: "COMPLETED" },
      { id: "li40", productId: "PRD-015", productName: "Microfiber Towel Pack", sku: "CLN-005", qty: 3, unitPrice: 27.99, status: "COMPLETED" },
    ],
  },
  {
    id: "19",
    orderNumber: "ORD-1024",
    customerId: "CUS-010",
    customerName: "Rio Grande Provisions",
    routeId: "RTE-205",
    routeName: "Georgetown Corridor",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Feb 28, 2026 · 9:00 AM",
    notes: "Bilingual confirmation required.",
    lineItems: [
      { id: "li41", productId: "PRD-001", productName: "Big Red Soda", sku: "BEV-001", qty: 3, unitPrice: 18.99, status: "COMPLETED" },
      { id: "li42", productId: "PRD-002", productName: "Lone Star Beer", sku: "BEV-002", qty: 2, unitPrice: 13.49, status: "COMPLETED" },
    ],
  },
  {
    id: "20",
    orderNumber: "ORD-1023",
    customerId: "CUS-007",
    customerName: "Texas Pride Meat Market",
    routeId: "RTE-202",
    routeName: "San Marcos Express",
    status: "COMPLETED",
    isUrgent: false,
    createdAt: "Feb 28, 2026 · 7:30 AM",
    notes: "",
    lineItems: [
      { id: "li43", productId: "PRD-007", productName: "Jalapeño Peanuts", sku: "SNK-002", qty: 6, unitPrice: 5.99, status: "COMPLETED" },
      { id: "li44", productId: "PRD-008", productName: "Beef Jerky Strips", sku: "SNK-003", qty: 3, unitPrice: 9.99, status: "COMPLETED" },
    ],
  },
];

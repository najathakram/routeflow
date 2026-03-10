// ─── Types ────────────────────────────────────────────────────────────────────

export type PaymentStatus = "PAID" | "PARTIAL" | "UNPAID" | "OVERDUE";
export type PaymentMethod = "Cash" | "Check" | "ACH" | "Other";

export interface Payment {
  id: string;
  date: string;
  method: PaymentMethod;
  amount: number;
  reference?: string;
}

export interface TransactionLineItem {
  description: string;
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface Transaction {
  id: string;
  transactionNumber: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerEmail: string;
  date: string;
  dueDate: string;
  lineItems: TransactionLineItem[];
  taxRate: number; // percent, e.g. 8.25
  payments: Payment[];
  status: PaymentStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function subtotal(t: Transaction): number {
  return t.lineItems.reduce((s, li) => s + li.qty * li.unitPrice, 0);
}

export function taxAmount(t: Transaction): number {
  return subtotal(t) * (t.taxRate / 100);
}

export function grandTotal(t: Transaction): number {
  return subtotal(t) + taxAmount(t);
}

export function amountPaid(t: Transaction): number {
  return t.payments.reduce((s, p) => s + p.amount, 0);
}

export function balance(t: Transaction): number {
  return Math.max(0, grandTotal(t) - amountPaid(t));
}

export function getTransaction(id: string): Transaction | undefined {
  return transactions.find((t) => t.id === id);
}

// ─── Mock transactions ────────────────────────────────────────────────────────

export const transactions: Transaction[] = [
  {
    id: "TXN-001",
    transactionNumber: "INV-2026-0041",
    customerId: "CUS-004",
    customerName: "Alamo Restaurant Group",
    customerAddress: "318 Alamo Plaza, San Antonio, TX 78205",
    customerEmail: "sdelgado@alamorg.com",
    date: "Mar 9, 2026",
    dueDate: "Apr 8, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Corn Tortilla Chips", sku: "SNK-005", qty: 5, unitPrice: 11.99 },
      { description: "Commercial Degreaser", sku: "CLN-001", qty: 1, unitPrice: 22.99 },
    ],
    payments: [],
    status: "UNPAID",
  },
  {
    id: "TXN-002",
    transactionNumber: "INV-2026-0040",
    customerId: "CUS-005",
    customerName: "Pecos River Distributors",
    customerAddress: "3401 Industrial Blvd, Midland, TX 79701",
    customerEmail: "frank@pecosriver.com",
    date: "Mar 8, 2026",
    dueDate: "Mar 23, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Mop Bucket with Wringer", sku: "CLN-004", qty: 2, unitPrice: 54.99 },
      { description: "Commercial Degreaser", sku: "CLN-001", qty: 3, unitPrice: 22.99 },
      { description: "Sanitizer Concentrate", sku: "CLN-003", qty: 2, unitPrice: 31.99 },
      { description: "Microfiber Towel Pack", sku: "CLN-005", qty: 4, unitPrice: 27.99 },
    ],
    payments: [
      { id: "PMT-001", date: "Mar 9, 2026", method: "ACH", amount: 200.00, reference: "ACH-774892" },
    ],
    status: "PARTIAL",
  },
  {
    id: "TXN-003",
    transactionNumber: "INV-2026-0039",
    customerId: "CUS-006",
    customerName: "Bluebonnet Bakery Supply",
    customerAddress: "611 S Congress Ave, Austin, TX 78704",
    customerEmail: "tracy@bluebonnetbakery.com",
    date: "Mar 8, 2026",
    dueDate: "Apr 7, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Sparkling Water Case", sku: "BEV-005", qty: 3, unitPrice: 21.99 },
      { description: "Pecan Pralines", sku: "SNK-004", qty: 2, unitPrice: 14.99 },
    ],
    payments: [
      { id: "PMT-002", date: "Mar 8, 2026", method: "Check", amount: 418.25, reference: "CHK-3812" },
    ],
    status: "PAID",
  },
  {
    id: "TXN-004",
    transactionNumber: "INV-2026-0038",
    customerId: "CUS-001",
    customerName: "Big Tex BBQ Supply Co.",
    customerAddress: "4821 S Lamar Blvd, Austin, TX 78745",
    customerEmail: "roy@bigtexbbq.com",
    date: "Mar 5, 2026",
    dueDate: "Apr 4, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Dr Pepper", sku: "BEV-003", qty: 3, unitPrice: 17.99 },
      { description: "Jalapeño Peanuts", sku: "SNK-002", qty: 5, unitPrice: 5.99 },
    ],
    payments: [],
    status: "UNPAID",
  },
  {
    id: "TXN-005",
    transactionNumber: "INV-2026-0037",
    customerId: "CUS-007",
    customerName: "Texas Pride Meat Market",
    customerAddress: "8900 Westheimer Rd, Houston, TX 77063",
    customerEmail: "bobby@texpridemeat.com",
    date: "Mar 3, 2026",
    dueDate: "Mar 18, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Beef Jerky Strips", sku: "SNK-003", qty: 4, unitPrice: 9.99 },
    ],
    payments: [
      { id: "PMT-003", date: "Mar 5, 2026", method: "Cash", amount: 39.96, reference: undefined },
    ],
    status: "PAID",
  },
  {
    id: "TXN-006",
    transactionNumber: "INV-2026-0036",
    customerId: "CUS-004",
    customerName: "Alamo Restaurant Group",
    customerAddress: "318 Alamo Plaza, San Antonio, TX 78205",
    customerEmail: "sdelgado@alamorg.com",
    date: "Mar 3, 2026",
    dueDate: "Apr 2, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Corn Tortilla Chips", sku: "SNK-005", qty: 10, unitPrice: 11.99 },
      { description: "Industrial Hand Soap", sku: "CLN-002", qty: 2, unitPrice: 39.99 },
      { description: "Sanitizer Concentrate", sku: "CLN-003", qty: 1, unitPrice: 31.99 },
    ],
    payments: [
      { id: "PMT-004", date: "Mar 7, 2026", method: "ACH", amount: 100.00, reference: "ACH-779021" },
    ],
    status: "PARTIAL",
  },
  {
    id: "TXN-007",
    transactionNumber: "INV-2026-0035",
    customerId: "CUS-010",
    customerName: "Rio Grande Provisions",
    customerAddress: "3800 N Cage Blvd, Pharr, TX 78577",
    customerEmail: "arturo@riograndeprov.com",
    date: "Mar 2, 2026",
    dueDate: "Apr 1, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Big Red Soda", sku: "BEV-001", qty: 6, unitPrice: 18.99 },
      { description: "Lone Star Beer", sku: "BEV-002", qty: 4, unitPrice: 13.49 },
    ],
    payments: [
      { id: "PMT-005", date: "Mar 4, 2026", method: "ACH", amount: 167.90, reference: "ACH-781044" },
    ],
    status: "PAID",
  },
  {
    id: "TXN-008",
    transactionNumber: "INV-2026-0031",
    customerId: "CUS-008",
    customerName: "Capitol City Catering",
    customerAddress: "1000 E 6th St, Austin, TX 78702",
    customerEmail: "melissa@capitolcitycatering.com",
    date: "Feb 10, 2026",
    dueDate: "Feb 25, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Corn Tortilla Chips", sku: "SNK-005", qty: 12, unitPrice: 11.99 },
      { description: "BBQ Kettle Chips", sku: "SNK-001", qty: 8, unitPrice: 6.49 },
      { description: "Pecan Pralines", sku: "SNK-004", qty: 5, unitPrice: 14.99 },
    ],
    payments: [],
    status: "OVERDUE",
  },
  {
    id: "TXN-009",
    transactionNumber: "INV-2026-0028",
    customerId: "CUS-002",
    customerName: "Lone Star Foodservice",
    customerAddress: "1100 W Commerce St, San Antonio, TX 78207",
    customerEmail: "carmen@lonestarfs.com",
    date: "Feb 2, 2026",
    dueDate: "Mar 4, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Dr Pepper", sku: "BEV-003", qty: 4, unitPrice: 17.99 },
      { description: "BBQ Kettle Chips", sku: "SNK-001", qty: 3, unitPrice: 6.49 },
    ],
    payments: [
      { id: "PMT-006", date: "Mar 5, 2026", method: "Check", amount: 91.43, reference: "CHK-3844" },
    ],
    status: "PAID",
  },
  {
    id: "TXN-010",
    transactionNumber: "INV-2026-0025",
    customerId: "CUS-003",
    customerName: "Hill Country Fresh Produce",
    customerAddress: "9240 FM 967, Buda, TX 78610",
    customerEmail: "dale@hcfreshproduce.com",
    date: "Jan 28, 2026",
    dueDate: "Jan 28, 2026",
    taxRate: 8.25,
    lineItems: [
      { description: "Sparkling Water Case", sku: "BEV-005", qty: 5, unitPrice: 21.99 },
      { description: "Sweet Tea Gallon Jug", sku: "BEV-004", qty: 10, unitPrice: 4.99 },
    ],
    payments: [
      { id: "PMT-007", date: "Jan 28, 2026", method: "Cash", amount: 159.85, reference: undefined },
    ],
    status: "PAID",
  },
];

// ─── KPI helpers ──────────────────────────────────────────────────────────────

export function getBookkeepingKPIs() {
  const monthRevenue = transactions
    .filter((t) => t.date.startsWith("Mar"))
    .reduce((s, t) => s + grandTotal(t), 0);

  const outstanding = transactions
    .filter((t) => t.status === "UNPAID" || t.status === "PARTIAL" || t.status === "OVERDUE")
    .reduce((s, t) => s + balance(t), 0);

  const weekPayments = transactions
    .flatMap((t) => t.payments)
    .filter((p) => p.date.startsWith("Mar"))
    .reduce((s, p) => s + p.amount, 0);

  const overdueCount = transactions.filter((t) => t.status === "OVERDUE").length;

  return { monthRevenue, outstanding, weekPayments, overdueCount };
}

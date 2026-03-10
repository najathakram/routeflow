// ─── Product ──────────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  name: string;
  category: string;
  description: string;
  price: number;
  unit: string;
  lowStock?: boolean;
}

export const MOCK_PRODUCTS: Product[] = [
  {
    id: "p1",
    name: "Cherry Tomatoes",
    category: "Produce",
    description: "Sweet and juicy cherry tomatoes, locally sourced and picked fresh daily.",
    price: 4.99,
    unit: "per punnet (250g)",
    lowStock: true,
  },
  {
    id: "p2",
    name: "Baby Spinach",
    category: "Produce",
    description: "Tender baby spinach leaves, triple-washed and ready to use.",
    price: 3.49,
    unit: "per bag (200g)",
  },
  {
    id: "p3",
    name: "Carrots",
    category: "Produce",
    description: "Fresh whole carrots, perfect for cooking, roasting or snacking.",
    price: 1.99,
    unit: "per kg",
  },
  {
    id: "p4",
    name: "Full Cream Milk",
    category: "Dairy",
    description: "Farm-fresh full cream milk, pasteurised and homogenised.",
    price: 3.29,
    unit: "per 2L",
  },
  {
    id: "p5",
    name: "Tasty Cheddar",
    category: "Dairy",
    description: "Aged cheddar with a sharp, nutty flavour. Great for cooking and snacking.",
    price: 9.99,
    unit: "per 500g block",
    lowStock: true,
  },
  {
    id: "p6",
    name: "Greek Yoghurt",
    category: "Dairy",
    description: "Thick and creamy Greek-style yoghurt with no added sugar.",
    price: 5.49,
    unit: "per 900g tub",
  },
  {
    id: "p7",
    name: "Sourdough Loaf",
    category: "Bakery",
    description: "Hand-crafted sourdough with a crispy crust and chewy interior.",
    price: 6.99,
    unit: "per loaf",
    lowStock: true,
  },
  {
    id: "p8",
    name: "Butter Croissants",
    category: "Bakery",
    description: "Flaky, buttery croissants baked fresh daily from scratch.",
    price: 7.49,
    unit: "pack of 4",
  },
  {
    id: "p9",
    name: "Fresh Orange Juice",
    category: "Beverages",
    description: "Cold-pressed OJ from Valencia oranges. No added sugar or preservatives.",
    price: 5.99,
    unit: "per 2L bottle",
  },
  {
    id: "p10",
    name: "Sparkling Water",
    category: "Beverages",
    description: "Naturally carbonated mineral water sourced from an Alpine spring.",
    price: 4.99,
    unit: "6-pack (500mL each)",
  },
  {
    id: "p11",
    name: "Basmati Rice",
    category: "Dry Goods",
    description: "Premium long-grain basmati rice with a fragrant, nutty aroma.",
    price: 4.49,
    unit: "per 1kg bag",
  },
  {
    id: "p12",
    name: "Penne Pasta",
    category: "Dry Goods",
    description: "Classic Italian penne pasta, bronze-die cut for a rougher texture.",
    price: 2.99,
    unit: "per 500g pack",
  },
];

// ─── Order History ─────────────────────────────────────────────────────────────

export type ItemStatus = "DELIVERED" | "CANCELLED" | "PENDING";
export type HistoryStatus = "DELIVERED" | "IN_TRANSIT" | "PENDING" | "CANCELLED";

export interface HistoryOrderItem {
  name: string;
  qty: number;
  unitPrice: number;
  status: ItemStatus;
}

export interface HistoryOrder {
  id: string;
  date: string; // ISO date string
  items: HistoryOrderItem[];
  total: number;
  status: HistoryStatus;
  driverNote?: string;
}

export const MOCK_HISTORY: HistoryOrder[] = [
  {
    id: "RF-1891",
    date: "2024-11-28T09:30:00Z",
    status: "DELIVERED",
    total: 28.04,
    driverNote: "Left at front door as requested. All items in good condition.",
    items: [
      { name: "Cherry Tomatoes", qty: 2, unitPrice: 4.99, status: "DELIVERED" },
      { name: "Sourdough Loaf", qty: 1, unitPrice: 6.99, status: "DELIVERED" },
      { name: "Full Cream Milk", qty: 2, unitPrice: 3.29, status: "DELIVERED" },
      { name: "Basmati Rice", qty: 1, unitPrice: 4.49, status: "DELIVERED" },
    ],
  },
  {
    id: "RF-1892",
    date: "2024-12-05T11:15:00Z",
    status: "DELIVERED",
    total: 17.45,
    items: [
      { name: "Baby Spinach", qty: 2, unitPrice: 3.49, status: "DELIVERED" },
      { name: "Greek Yoghurt", qty: 1, unitPrice: 5.49, status: "DELIVERED" },
      { name: "Penne Pasta", qty: 1, unitPrice: 2.99, status: "DELIVERED" },
      { name: "Carrots", qty: 1, unitPrice: 1.99, status: "DELIVERED" },
    ],
  },
  {
    id: "RF-1893",
    date: "2024-12-12T14:00:00Z",
    status: "IN_TRANSIT",
    total: 45.94,
    items: [
      { name: "Tasty Cheddar", qty: 2, unitPrice: 9.99, status: "PENDING" },
      { name: "Butter Croissants", qty: 2, unitPrice: 7.49, status: "PENDING" },
      { name: "Sparkling Water", qty: 1, unitPrice: 4.99, status: "PENDING" },
      { name: "Fresh Orange Juice", qty: 1, unitPrice: 5.99, status: "PENDING" },
    ],
  },
];
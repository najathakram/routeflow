import type { BadgeStatus } from "@routeflow/ui/web";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CustomerStatus = Extract<BadgeStatus, "ACTIVE" | "INACTIVE" | "SUSPENDED">;
export type OrderStatus = Extract<
  BadgeStatus,
  "PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "COMPLETED" | "CANCELLED"
>;

export interface DeliveryAddress {
  id: string;
  label: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  isPrimary: boolean;
}

export interface Customer {
  id: string;
  businessName: string;
  contactName: string;
  phone: string;
  email: string;
  status: CustomerStatus;
  assignedRoutes: string[];
  creditTerms: "Net 15" | "Net 30" | "Net 60" | "COD";
  notes: string;
  addresses: DeliveryAddress[];
  createdAt: string;
}

export interface CustomerOrder {
  id: string;
  orderNumber: string;
  items: number;
  total: number;
  status: OrderStatus;
  date: string;
}

// ─── Available routes ─────────────────────────────────────────────────────────

export const availableRoutes = [
  { id: "RTE-201", name: "North Austin Loop" },
  { id: "RTE-202", name: "San Marcos Express" },
  { id: "RTE-203", name: "Round Rock Commercial" },
  { id: "RTE-204", name: "South Austin Circuit" },
  { id: "RTE-205", name: "Georgetown Corridor" },
] as const;

// ─── Customer mock data ───────────────────────────────────────────────────────

export const customers: Customer[] = [
  {
    id: "CUS-001",
    businessName: "Big Tex BBQ Supply Co.",
    contactName: "Roy Hutchins",
    phone: "(512) 555-0142",
    email: "roy@bigtexbbq.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-201", "RTE-203"],
    creditTerms: "Net 30",
    notes: "Prefers early morning deliveries. Loading dock on south side.",
    addresses: [
      {
        id: "ADDR-001a",
        label: "Main Warehouse",
        street: "4821 S Lamar Blvd",
        city: "Austin",
        state: "TX",
        zip: "78745",
        isPrimary: true,
      },
      {
        id: "ADDR-001b",
        label: "Retail Store",
        street: "208 W 6th St",
        city: "Austin",
        state: "TX",
        zip: "78701",
        isPrimary: false,
      },
    ],
    createdAt: "Jan 12, 2024",
  },
  {
    id: "CUS-002",
    businessName: "Lone Star Foodservice",
    contactName: "Carmen Ruiz",
    phone: "(210) 555-0387",
    email: "carmen@lonestarfs.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-202"],
    creditTerms: "Net 60",
    notes: "Allergic to latex — drivers should not wear latex gloves.",
    addresses: [
      {
        id: "ADDR-002a",
        label: "Distribution Center",
        street: "1100 W Commerce St",
        city: "San Antonio",
        state: "TX",
        zip: "78207",
        isPrimary: true,
      },
      {
        id: "ADDR-002b",
        label: "Kitchen",
        street: "535 McCullough Ave",
        city: "San Antonio",
        state: "TX",
        zip: "78215",
        isPrimary: false,
      },
    ],
    createdAt: "Mar 3, 2024",
  },
  {
    id: "CUS-003",
    businessName: "Hill Country Fresh Produce",
    contactName: "Dale Winstead",
    phone: "(512) 555-0219",
    email: "dale@hcfreshproduce.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-201"],
    creditTerms: "COD",
    notes: "Refrigerated truck required. Call 30 min before arrival.",
    addresses: [
      {
        id: "ADDR-003a",
        label: "Farm Gate",
        street: "9240 FM 967",
        city: "Buda",
        state: "TX",
        zip: "78610",
        isPrimary: true,
      },
    ],
    createdAt: "May 20, 2024",
  },
  {
    id: "CUS-004",
    businessName: "Alamo Restaurant Group",
    contactName: "Sandra Delgado",
    phone: "(210) 555-0451",
    email: "sdelgado@alamorg.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-203", "RTE-204"],
    creditTerms: "Net 30",
    notes: "Multiple locations. Coordinate with Sandra for split deliveries.",
    addresses: [
      {
        id: "ADDR-004a",
        label: "Flagship Restaurant",
        street: "318 Alamo Plaza",
        city: "San Antonio",
        state: "TX",
        zip: "78205",
        isPrimary: true,
      },
      {
        id: "ADDR-004b",
        label: "North Location",
        street: "15900 La Cantera Pkwy",
        city: "San Antonio",
        state: "TX",
        zip: "78256",
        isPrimary: false,
      },
      {
        id: "ADDR-004c",
        label: "Commissary Kitchen",
        street: "7210 Blanco Rd",
        city: "San Antonio",
        state: "TX",
        zip: "78216",
        isPrimary: false,
      },
    ],
    createdAt: "Feb 8, 2024",
  },
  {
    id: "CUS-005",
    businessName: "Pecos River Distributors",
    contactName: "Frank Okonkwo",
    phone: "(432) 555-0073",
    email: "frank@pecosriver.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-205"],
    creditTerms: "Net 15",
    notes: "Large volume orders. Requires pallet jack on delivery.",
    addresses: [
      {
        id: "ADDR-005a",
        label: "Warehouse",
        street: "3401 Industrial Blvd",
        city: "Midland",
        state: "TX",
        zip: "79701",
        isPrimary: true,
      },
    ],
    createdAt: "Jun 1, 2024",
  },
  {
    id: "CUS-006",
    businessName: "Bluebonnet Bakery Supply",
    contactName: "Tracy Hoffmann",
    phone: "(512) 555-0308",
    email: "tracy@bluebonnetbakery.com",
    status: "INACTIVE",
    assignedRoutes: [],
    creditTerms: "Net 30",
    notes: "Account paused — awaiting updated tax certificate.",
    addresses: [
      {
        id: "ADDR-006a",
        label: "Shop",
        street: "611 S Congress Ave",
        city: "Austin",
        state: "TX",
        zip: "78704",
        isPrimary: true,
      },
    ],
    createdAt: "Sep 14, 2023",
  },
  {
    id: "CUS-007",
    businessName: "Texas Pride Meat Market",
    contactName: "Bobby Ramirez",
    phone: "(713) 555-0162",
    email: "bobby@texpridemeat.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-201", "RTE-202"],
    creditTerms: "COD",
    notes: "Temperature-sensitive products only. No dry goods.",
    addresses: [
      {
        id: "ADDR-007a",
        label: "Market",
        street: "8900 Westheimer Rd",
        city: "Houston",
        state: "TX",
        zip: "77063",
        isPrimary: true,
      },
      {
        id: "ADDR-007b",
        label: "Cold Storage",
        street: "4200 N Loop W",
        city: "Houston",
        state: "TX",
        zip: "77092",
        isPrimary: false,
      },
    ],
    createdAt: "Oct 30, 2023",
  },
  {
    id: "CUS-008",
    businessName: "Capitol City Catering",
    contactName: "Melissa Torres",
    phone: "(512) 555-0594",
    email: "melissa@capitolcitycatering.com",
    status: "SUSPENDED",
    assignedRoutes: ["RTE-204"],
    creditTerms: "Net 60",
    notes: "Account suspended — outstanding balance of $3,410.",
    addresses: [
      {
        id: "ADDR-008a",
        label: "Kitchen",
        street: "1000 E 6th St",
        city: "Austin",
        state: "TX",
        zip: "78702",
        isPrimary: true,
      },
    ],
    createdAt: "Jul 5, 2023",
  },
  {
    id: "CUS-009",
    businessName: "Cowboy Kitchen Supplies",
    contactName: "Glen Abernathy",
    phone: "(817) 555-0229",
    email: "glen@cowboykitchen.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-203"],
    creditTerms: "Net 30",
    notes: "Prefers afternoon slots after 2 PM.",
    addresses: [
      {
        id: "ADDR-009a",
        label: "Store",
        street: "2501 Ridgmar Blvd",
        city: "Fort Worth",
        state: "TX",
        zip: "76116",
        isPrimary: true,
      },
      {
        id: "ADDR-009b",
        label: "Storage Unit",
        street: "6200 Camp Bowie Blvd",
        city: "Fort Worth",
        state: "TX",
        zip: "76116",
        isPrimary: false,
      },
    ],
    createdAt: "Nov 17, 2023",
  },
  {
    id: "CUS-010",
    businessName: "Rio Grande Provisions",
    contactName: "Arturo Vega",
    phone: "(956) 555-0411",
    email: "arturo@riograndeprov.com",
    status: "ACTIVE",
    assignedRoutes: ["RTE-202", "RTE-205"],
    creditTerms: "Net 30",
    notes: "Bilingual delivery confirmation preferred.",
    addresses: [
      {
        id: "ADDR-010a",
        label: "Warehouse",
        street: "3800 N Cage Blvd",
        city: "Pharr",
        state: "TX",
        zip: "78577",
        isPrimary: true,
      },
    ],
    createdAt: "Dec 2, 2023",
  },
];

// ─── Customer orders ──────────────────────────────────────────────────────────

const customerOrdersMap: Record<string, CustomerOrder[]> = {
  "CUS-001": [
    { id: "o1", orderNumber: "ORD-1042", items: 12, total: 1284.5, status: "PENDING", date: "Mar 9, 2026" },
    { id: "o2", orderNumber: "ORD-1033", items: 8, total: 876.0, status: "COMPLETED", date: "Mar 2, 2026" },
    { id: "o3", orderNumber: "ORD-1021", items: 15, total: 1650.75, status: "COMPLETED", date: "Feb 23, 2026" },
    { id: "o4", orderNumber: "ORD-1009", items: 6, total: 540.0, status: "CANCELLED", date: "Feb 14, 2026" },
    { id: "o5", orderNumber: "ORD-0997", items: 20, total: 2100.5, status: "COMPLETED", date: "Feb 5, 2026" },
  ],
  "CUS-002": [
    { id: "o6", orderNumber: "ORD-1038", items: 6, total: 675.0, status: "PENDING", date: "Mar 7, 2026" },
    { id: "o7", orderNumber: "ORD-1025", items: 11, total: 1190.25, status: "OUT_FOR_DELIVERY", date: "Mar 3, 2026" },
    { id: "o8", orderNumber: "ORD-1014", items: 4, total: 320.0, status: "COMPLETED", date: "Feb 18, 2026" },
    { id: "o9", orderNumber: "ORD-1002", items: 9, total: 925.5, status: "COMPLETED", date: "Feb 9, 2026" },
  ],
  "CUS-004": [
    { id: "o10", orderNumber: "ORD-1041", items: 8, total: 972.0, status: "OUT_FOR_DELIVERY", date: "Mar 9, 2026" },
    { id: "o11", orderNumber: "ORD-1029", items: 18, total: 2340.0, status: "COMPLETED", date: "Mar 1, 2026" },
    { id: "o12", orderNumber: "ORD-1017", items: 3, total: 280.0, status: "COMPLETED", date: "Feb 20, 2026" },
    { id: "o13", orderNumber: "ORD-1006", items: 22, total: 2880.0, status: "COMPLETED", date: "Feb 11, 2026" },
    { id: "o14", orderNumber: "ORD-0994", items: 7, total: 714.5, status: "CANCELLED", date: "Feb 2, 2026" },
  ],
  "CUS-005": [
    { id: "o15", orderNumber: "ORD-1040", items: 31, total: 3410.75, status: "COMPLETED", date: "Mar 8, 2026" },
    { id: "o16", orderNumber: "ORD-1027", items: 14, total: 1540.0, status: "COMPLETED", date: "Feb 27, 2026" },
  ],
  "CUS-007": [
    { id: "o17", orderNumber: "ORD-1036", items: 9, total: 985.0, status: "CONFIRMED", date: "Mar 6, 2026" },
    { id: "o18", orderNumber: "ORD-1023", items: 5, total: 450.0, status: "COMPLETED", date: "Feb 25, 2026" },
    { id: "o19", orderNumber: "ORD-1011", items: 13, total: 1375.0, status: "COMPLETED", date: "Feb 16, 2026" },
  ],
};

export function getCustomerOrders(customerId: string): CustomerOrder[] {
  return customerOrdersMap[customerId] ?? [];
}

export function getCustomer(id: string): Customer | undefined {
  return customers.find((c) => c.id === id);
}

export function getRouteName(routeId: string): string {
  return availableRoutes.find((r) => r.id === routeId)?.name ?? routeId;
}

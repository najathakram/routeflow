// ─── Types ────────────────────────────────────────────────────────────────────

export type RunStatus = "IN_PROGRESS" | "COMPLETED" | "SCHEDULED" | "CANCELLED";
export type StopStatus = "COMPLETED" | "CURRENT" | "UPCOMING" | "SKIPPED";

export interface StopItem {
  name: string;
  qty: number;
  unit: string;
}

export interface Stop {
  id: string;
  order: number;
  customerId: string;
  customerName: string;
  address: string;
  status: StopStatus;
  items: StopItem[];
  driverNote?: string;
  completedAt?: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  label: string;
  type: "start" | "stop_complete" | "note" | "skip" | "end";
}

export interface RouteRun {
  id: string;
  templateId: string;
  routeName: string;
  driverId: string;
  driverName: string;
  status: RunStatus;
  date: string;
  startTime: string;
  endTime?: string;
  stops: Stop[];
  timeline: TimelineEvent[];
}

export interface RouteTemplate {
  id: string;
  name: string;
  defaultDriverId: string;
  defaultDriverName: string;
  stopCount: number;
  lastRunDate: string;
  customerIds: string[];
}

// ─── Today's route runs ───────────────────────────────────────────────────────

export const todayRuns: RouteRun[] = [
  {
    id: "RUN-2026-001",
    templateId: "RTE-201",
    routeName: "North Austin Loop",
    driverId: "DRV-001",
    driverName: "Marcus Webb",
    status: "IN_PROGRESS",
    date: "Mar 9, 2026",
    startTime: "6:30 AM",
    stops: [
      {
        id: "STP-001",
        order: 1,
        customerId: "CUS-001",
        customerName: "Big Tex BBQ Supply Co.",
        address: "4821 S Lamar Blvd, Austin, TX 78745",
        status: "COMPLETED",
        items: [
          { name: "Big Red Soda", qty: 4, unit: "Case/24" },
          { name: "BBQ Kettle Chips", qty: 6, unit: "1-lb Bag" },
        ],
        driverNote: "Side entrance was locked — used front door.",
        completedAt: "7:02 AM",
      },
      {
        id: "STP-002",
        order: 2,
        customerId: "CUS-007",
        customerName: "Texas Pride Meat Market",
        address: "8900 Westheimer Rd, Houston, TX 77063",
        status: "COMPLETED",
        items: [
          { name: "Commercial Degreaser", qty: 2, unit: "1-gal Jug" },
          { name: "Sanitizer Concentrate", qty: 1, unit: "2.5-gal" },
        ],
        completedAt: "7:48 AM",
      },
      {
        id: "STP-003",
        order: 3,
        customerId: "CUS-009",
        customerName: "Cowboy Kitchen Supplies",
        address: "2501 Ridgmar Blvd, Fort Worth, TX 76116",
        status: "COMPLETED",
        items: [
          { name: "Corn Tortilla Chips", qty: 3, unit: "5-lb Bag" },
          { name: "Jalapeño Peanuts", qty: 5, unit: "16-oz Jar" },
        ],
        completedAt: "8:31 AM",
      },
      {
        id: "STP-004",
        order: 4,
        customerId: "CUS-003",
        customerName: "Hill Country Fresh Produce",
        address: "9240 FM 967, Buda, TX 78610",
        status: "CURRENT",
        items: [
          { name: "Sparkling Water Case", qty: 10, unit: "Case/24" },
          { name: "Sweet Tea Gallon Jug", qty: 8, unit: "Gallon" },
          { name: "Dr Pepper", qty: 2, unit: "Case/24" },
        ],
      },
      {
        id: "STP-005",
        order: 5,
        customerId: "CUS-004",
        customerName: "Alamo Restaurant Group",
        address: "318 Alamo Plaza, San Antonio, TX 78205",
        status: "UPCOMING",
        items: [
          { name: "Beef Jerky Strips", qty: 4, unit: "10-oz Bag" },
          { name: "Pecan Pralines", qty: 2, unit: "Box/12" },
        ],
      },
      {
        id: "STP-006",
        order: 6,
        customerId: "CUS-010",
        customerName: "Rio Grande Provisions",
        address: "3800 N Cage Blvd, Pharr, TX 78577",
        status: "UPCOMING",
        items: [
          { name: "Big Red Soda", qty: 6, unit: "Case/24" },
          { name: "Lone Star Beer", qty: 4, unit: "12-Pack" },
        ],
      },
      {
        id: "STP-007",
        order: 7,
        customerId: "CUS-002",
        customerName: "Lone Star Foodservice",
        address: "1100 W Commerce St, San Antonio, TX 78207",
        status: "UPCOMING",
        items: [
          { name: "Industrial Hand Soap", qty: 1, unit: "5-gal Pail" },
          { name: "Microfiber Towel Pack", qty: 2, unit: "Pack/24" },
        ],
      },
      {
        id: "STP-008",
        order: 8,
        customerId: "CUS-005",
        customerName: "Pecos River Distributors",
        address: "3401 Industrial Blvd, Midland, TX 79701",
        status: "UPCOMING",
        items: [
          { name: "Mop Bucket with Wringer", qty: 2, unit: "Each" },
          { name: "Commercial Degreaser", qty: 3, unit: "1-gal Jug" },
        ],
      },
    ],
    timeline: [
      {
        id: "tl1",
        time: "6:30 AM",
        label: "Route started — Marcus Webb checked in",
        type: "start",
      },
      {
        id: "tl2",
        time: "7:02 AM",
        label: "Stop 1 completed — Big Tex BBQ Supply Co.",
        type: "stop_complete",
      },
      {
        id: "tl3",
        time: "7:05 AM",
        label: "Note added: Side entrance was locked — used front door.",
        type: "note",
      },
      {
        id: "tl4",
        time: "7:48 AM",
        label: "Stop 2 completed — Texas Pride Meat Market",
        type: "stop_complete",
      },
      {
        id: "tl5",
        time: "8:31 AM",
        label: "Stop 3 completed — Cowboy Kitchen Supplies",
        type: "stop_complete",
      },
      {
        id: "tl6",
        time: "8:45 AM",
        label: "Arrived at Stop 4 — Hill Country Fresh Produce",
        type: "note",
      },
    ],
  },
  {
    id: "RUN-2026-002",
    templateId: "RTE-202",
    routeName: "San Marcos Express",
    driverId: "DRV-002",
    driverName: "Darlene Trevino",
    status: "IN_PROGRESS",
    date: "Mar 9, 2026",
    startTime: "7:15 AM",
    stops: [
      {
        id: "STP-009",
        order: 1,
        customerId: "CUS-002",
        customerName: "Lone Star Foodservice",
        address: "535 McCullough Ave, San Antonio, TX 78215",
        status: "COMPLETED",
        items: [{ name: "Dr Pepper", qty: 3, unit: "Case/24" }],
        completedAt: "8:10 AM",
      },
      {
        id: "STP-010",
        order: 2,
        customerId: "CUS-004",
        customerName: "Alamo Restaurant Group",
        address: "7210 Blanco Rd, San Antonio, TX 78216",
        status: "CURRENT",
        items: [
          { name: "Corn Tortilla Chips", qty: 5, unit: "5-lb Bag" },
          { name: "Commercial Degreaser", qty: 1, unit: "1-gal Jug" },
        ],
      },
      {
        id: "STP-011",
        order: 3,
        customerId: "CUS-010",
        customerName: "Rio Grande Provisions",
        address: "3800 N Cage Blvd, Pharr, TX 78577",
        status: "UPCOMING",
        items: [{ name: "Sanitizer Concentrate", qty: 2, unit: "2.5-gal" }],
      },
      {
        id: "STP-012",
        order: 4,
        customerId: "CUS-003",
        customerName: "Hill Country Fresh Produce",
        address: "9240 FM 967, Buda, TX 78610",
        status: "UPCOMING",
        items: [{ name: "BBQ Kettle Chips", qty: 4, unit: "1-lb Bag" }],
      },
      {
        id: "STP-013",
        order: 5,
        customerId: "CUS-001",
        customerName: "Big Tex BBQ Supply Co.",
        address: "208 W 6th St, Austin, TX 78701",
        status: "UPCOMING",
        items: [{ name: "Big Red Soda", qty: 2, unit: "Case/24" }],
      },
      {
        id: "STP-014",
        order: 6,
        customerId: "CUS-007",
        customerName: "Texas Pride Meat Market",
        address: "4200 N Loop W, Houston, TX 77092",
        status: "UPCOMING",
        items: [{ name: "Beef Jerky Strips", qty: 6, unit: "10-oz Bag" }],
      },
    ],
    timeline: [
      {
        id: "tl7",
        time: "7:15 AM",
        label: "Route started — Darlene Trevino checked in",
        type: "start",
      },
      {
        id: "tl8",
        time: "8:10 AM",
        label: "Stop 1 completed — Lone Star Foodservice",
        type: "stop_complete",
      },
      {
        id: "tl9",
        time: "8:22 AM",
        label: "Arrived at Stop 2 — Alamo Restaurant Group",
        type: "note",
      },
    ],
  },
  {
    id: "RUN-2026-003",
    templateId: "RTE-203",
    routeName: "Round Rock Commercial",
    driverId: "DRV-003",
    driverName: "Jesse Gallegos",
    status: "COMPLETED",
    date: "Mar 9, 2026",
    startTime: "5:45 AM",
    endTime: "10:22 AM",
    stops: [
      {
        id: "STP-015",
        order: 1,
        customerId: "CUS-001",
        customerName: "Big Tex BBQ Supply Co.",
        address: "4821 S Lamar Blvd, Austin, TX 78745",
        status: "COMPLETED",
        items: [{ name: "Dr Pepper", qty: 2, unit: "Case/24" }],
        completedAt: "6:18 AM",
      },
      {
        id: "STP-016",
        order: 2,
        customerId: "CUS-004",
        customerName: "Alamo Restaurant Group",
        address: "318 Alamo Plaza, San Antonio, TX 78205",
        status: "COMPLETED",
        items: [{ name: "Pecan Pralines", qty: 3, unit: "Box/12" }],
        completedAt: "7:05 AM",
      },
      {
        id: "STP-017",
        order: 3,
        customerId: "CUS-009",
        customerName: "Cowboy Kitchen Supplies",
        address: "6200 Camp Bowie Blvd, Fort Worth, TX 76116",
        status: "COMPLETED",
        items: [{ name: "Mop Bucket with Wringer", qty: 1, unit: "Each" }],
        completedAt: "8:44 AM",
      },
      {
        id: "STP-018",
        order: 4,
        customerId: "CUS-005",
        customerName: "Pecos River Distributors",
        address: "3401 Industrial Blvd, Midland, TX 79701",
        status: "COMPLETED",
        items: [{ name: "Industrial Hand Soap", qty: 2, unit: "5-gal Pail" }],
        completedAt: "9:33 AM",
      },
      {
        id: "STP-019",
        order: 5,
        customerId: "CUS-006",
        customerName: "Bluebonnet Bakery Supply",
        address: "611 S Congress Ave, Austin, TX 78704",
        status: "COMPLETED",
        items: [{ name: "Sparkling Water Case", qty: 3, unit: "Case/24" }],
        completedAt: "10:22 AM",
      },
    ],
    timeline: [
      {
        id: "tl10",
        time: "5:45 AM",
        label: "Route started — Jesse Gallegos checked in",
        type: "start",
      },
      {
        id: "tl11",
        time: "6:18 AM",
        label: "Stop 1 completed — Big Tex BBQ Supply Co.",
        type: "stop_complete",
      },
      {
        id: "tl12",
        time: "7:05 AM",
        label: "Stop 2 completed — Alamo Restaurant Group",
        type: "stop_complete",
      },
      {
        id: "tl13",
        time: "8:44 AM",
        label: "Stop 3 completed — Cowboy Kitchen Supplies",
        type: "stop_complete",
      },
      {
        id: "tl14",
        time: "9:33 AM",
        label: "Stop 4 completed — Pecos River Distributors",
        type: "stop_complete",
      },
      {
        id: "tl15",
        time: "10:22 AM",
        label: "Stop 5 completed — Bluebonnet Bakery Supply",
        type: "stop_complete",
      },
      {
        id: "tl16",
        time: "10:22 AM",
        label: "Route completed — all 5 stops delivered",
        type: "end",
      },
    ],
  },
];

// ─── Route templates ──────────────────────────────────────────────────────────

export const routeTemplates: RouteTemplate[] = [
  {
    id: "RTE-201",
    name: "North Austin Loop",
    defaultDriverId: "DRV-001",
    defaultDriverName: "Marcus Webb",
    stopCount: 8,
    lastRunDate: "Mar 9, 2026",
    customerIds: [
      "CUS-001",
      "CUS-007",
      "CUS-009",
      "CUS-003",
      "CUS-004",
      "CUS-010",
      "CUS-002",
      "CUS-005",
    ],
  },
  {
    id: "RTE-202",
    name: "San Marcos Express",
    defaultDriverId: "DRV-002",
    defaultDriverName: "Darlene Trevino",
    stopCount: 6,
    lastRunDate: "Mar 9, 2026",
    customerIds: ["CUS-002", "CUS-004", "CUS-010", "CUS-003", "CUS-001", "CUS-007"],
  },
  {
    id: "RTE-203",
    name: "Round Rock Commercial",
    defaultDriverId: "DRV-003",
    defaultDriverName: "Jesse Gallegos",
    stopCount: 5,
    lastRunDate: "Mar 9, 2026",
    customerIds: ["CUS-001", "CUS-004", "CUS-009", "CUS-005", "CUS-006"],
  },
  {
    id: "RTE-204",
    name: "South Austin Circuit",
    defaultDriverId: "DRV-004",
    defaultDriverName: "Rodrigo Castillo",
    stopCount: 4,
    lastRunDate: "Mar 8, 2026",
    customerIds: ["CUS-004", "CUS-008", "CUS-006", "CUS-001"],
  },
  {
    id: "RTE-205",
    name: "Georgetown Corridor",
    defaultDriverId: "DRV-005",
    defaultDriverName: "Tamara Okafor",
    stopCount: 6,
    lastRunDate: "Mar 8, 2026",
    customerIds: ["CUS-005", "CUS-010", "CUS-002", "CUS-003", "CUS-007", "CUS-009"],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getRouteRun(id: string): RouteRun | undefined {
  return todayRuns.find((r) => r.id === id);
}

export function getTemplate(id: string): RouteTemplate | undefined {
  return routeTemplates.find((t) => t.id === id);
}

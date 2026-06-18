// ─── Types ────────────────────────────────────────────────────────────────────

export type DriverStatus = "ACTIVE" | "INACTIVE" | "IN_PROGRESS";

export interface Driver {
  id: string;
  name: string;
  phone: string;
  username: string;
  vehicle: string;
  status: DriverStatus;
  currentRouteId?: string;
  currentRouteName?: string;
  lastSeen: string;
  createdAt: string;
}

export interface RouteRun {
  id: string;
  date: string;
  routeName: string;
  stopsDone: number;
  stopsTotal: number;
  deliveriesCompleted: number;
  notesCount: number;
}

export interface DriverPerformance {
  routesCompleted: number;
  totalStops: number;
  onTimePercent: number;
  stopsSkipped: number;
}

// ─── Mock drivers ─────────────────────────────────────────────────────────────

export const drivers: Driver[] = [
  {
    id: "DRV-001",
    name: "Marcus Webb",
    phone: "(512) 555-0174",
    username: "mwebb",
    vehicle: "2022 Ford F-150 · Black · TX PLT-1138",
    status: "IN_PROGRESS",
    currentRouteId: "RTE-201",
    currentRouteName: "North Austin Loop",
    lastSeen: "2 min ago",
    createdAt: "Jan 15, 2024",
  },
  {
    id: "DRV-002",
    name: "Darlene Trevino",
    phone: "(512) 555-0287",
    username: "dtrevino",
    vehicle: "2021 Ram ProMaster · White · TX PLT-0924",
    status: "IN_PROGRESS",
    currentRouteId: "RTE-202",
    currentRouteName: "San Marcos Express",
    lastSeen: "5 min ago",
    createdAt: "Mar 3, 2024",
  },
  {
    id: "DRV-003",
    name: "Jesse Gallegos",
    phone: "(512) 555-0391",
    username: "jgallegos",
    vehicle: "2020 Chevy Express · Gray · TX PLT-2241",
    status: "INACTIVE",
    lastSeen: "1 hr ago",
    createdAt: "May 20, 2024",
  },
  {
    id: "DRV-004",
    name: "Rodrigo Castillo",
    phone: "(512) 555-0453",
    username: "rcastillo",
    vehicle: "2023 Isuzu NPR · White · TX PLT-3305",
    status: "ACTIVE",
    lastSeen: "14 min ago",
    createdAt: "Jun 1, 2024",
  },
  {
    id: "DRV-005",
    name: "Tamara Okafor",
    phone: "(512) 555-0562",
    username: "tokafor",
    vehicle: "2022 Mercedes Sprinter Reefer · White · TX PLT-4412",
    status: "ACTIVE",
    lastSeen: "22 min ago",
    createdAt: "Aug 10, 2024",
  },
];

// ─── Route runs ───────────────────────────────────────────────────────────────

const routeRunsMap: Record<string, RouteRun[]> = {
  "DRV-001": [
    {
      id: "rr01",
      date: "Mar 9, 2026",
      routeName: "North Austin Loop",
      stopsDone: 4,
      stopsTotal: 8,
      deliveriesCompleted: 4,
      notesCount: 1,
    },
    {
      id: "rr02",
      date: "Mar 8, 2026",
      routeName: "Round Rock Commercial",
      stopsDone: 5,
      stopsTotal: 5,
      deliveriesCompleted: 5,
      notesCount: 0,
    },
    {
      id: "rr03",
      date: "Mar 7, 2026",
      routeName: "North Austin Loop",
      stopsDone: 7,
      stopsTotal: 8,
      deliveriesCompleted: 7,
      notesCount: 2,
    },
    {
      id: "rr04",
      date: "Mar 6, 2026",
      routeName: "North Austin Loop",
      stopsDone: 8,
      stopsTotal: 8,
      deliveriesCompleted: 8,
      notesCount: 0,
    },
    {
      id: "rr05",
      date: "Mar 5, 2026",
      routeName: "Georgetown Corridor",
      stopsDone: 6,
      stopsTotal: 6,
      deliveriesCompleted: 6,
      notesCount: 0,
    },
    {
      id: "rr06",
      date: "Mar 4, 2026",
      routeName: "North Austin Loop",
      stopsDone: 8,
      stopsTotal: 8,
      deliveriesCompleted: 8,
      notesCount: 1,
    },
    {
      id: "rr07",
      date: "Mar 3, 2026",
      routeName: "Round Rock Commercial",
      stopsDone: 5,
      stopsTotal: 5,
      deliveriesCompleted: 5,
      notesCount: 0,
    },
    {
      id: "rr08",
      date: "Mar 2, 2026",
      routeName: "North Austin Loop",
      stopsDone: 8,
      stopsTotal: 8,
      deliveriesCompleted: 8,
      notesCount: 0,
    },
    {
      id: "rr09",
      date: "Mar 1, 2026",
      routeName: "North Austin Loop",
      stopsDone: 6,
      stopsTotal: 8,
      deliveriesCompleted: 6,
      notesCount: 3,
    },
    {
      id: "rr10",
      date: "Feb 28, 2026",
      routeName: "Georgetown Corridor",
      stopsDone: 6,
      stopsTotal: 6,
      deliveriesCompleted: 6,
      notesCount: 0,
    },
  ],
  "DRV-002": [
    {
      id: "rr11",
      date: "Mar 9, 2026",
      routeName: "San Marcos Express",
      stopsDone: 2,
      stopsTotal: 6,
      deliveriesCompleted: 2,
      notesCount: 1,
    },
    {
      id: "rr12",
      date: "Mar 8, 2026",
      routeName: "San Marcos Express",
      stopsDone: 6,
      stopsTotal: 6,
      deliveriesCompleted: 6,
      notesCount: 0,
    },
    {
      id: "rr13",
      date: "Mar 7, 2026",
      routeName: "South Austin Circuit",
      stopsDone: 4,
      stopsTotal: 4,
      deliveriesCompleted: 4,
      notesCount: 0,
    },
    {
      id: "rr14",
      date: "Mar 6, 2026",
      routeName: "San Marcos Express",
      stopsDone: 5,
      stopsTotal: 6,
      deliveriesCompleted: 5,
      notesCount: 1,
    },
    {
      id: "rr15",
      date: "Mar 5, 2026",
      routeName: "San Marcos Express",
      stopsDone: 6,
      stopsTotal: 6,
      deliveriesCompleted: 6,
      notesCount: 0,
    },
  ],
  "DRV-003": [
    {
      id: "rr16",
      date: "Mar 8, 2026",
      routeName: "Round Rock Commercial",
      stopsDone: 5,
      stopsTotal: 5,
      deliveriesCompleted: 5,
      notesCount: 0,
    },
    {
      id: "rr17",
      date: "Mar 7, 2026",
      routeName: "North Austin Loop",
      stopsDone: 8,
      stopsTotal: 8,
      deliveriesCompleted: 8,
      notesCount: 0,
    },
    {
      id: "rr18",
      date: "Mar 6, 2026",
      routeName: "Round Rock Commercial",
      stopsDone: 4,
      stopsTotal: 5,
      deliveriesCompleted: 4,
      notesCount: 1,
    },
  ],
  "DRV-004": [
    {
      id: "rr19",
      date: "Mar 9, 2026",
      routeName: "South Austin Circuit",
      stopsDone: 4,
      stopsTotal: 4,
      deliveriesCompleted: 4,
      notesCount: 0,
    },
    {
      id: "rr20",
      date: "Mar 8, 2026",
      routeName: "Georgetown Corridor",
      stopsDone: 6,
      stopsTotal: 6,
      deliveriesCompleted: 6,
      notesCount: 0,
    },
    {
      id: "rr21",
      date: "Mar 7, 2026",
      routeName: "South Austin Circuit",
      stopsDone: 4,
      stopsTotal: 4,
      deliveriesCompleted: 4,
      notesCount: 0,
    },
    {
      id: "rr22",
      date: "Mar 6, 2026",
      routeName: "Georgetown Corridor",
      stopsDone: 5,
      stopsTotal: 6,
      deliveriesCompleted: 5,
      notesCount: 1,
    },
  ],
  "DRV-005": [
    {
      id: "rr23",
      date: "Mar 9, 2026",
      routeName: "Georgetown Corridor",
      stopsDone: 6,
      stopsTotal: 6,
      deliveriesCompleted: 6,
      notesCount: 0,
    },
    {
      id: "rr24",
      date: "Mar 8, 2026",
      routeName: "North Austin Loop",
      stopsDone: 8,
      stopsTotal: 8,
      deliveriesCompleted: 8,
      notesCount: 0,
    },
    {
      id: "rr25",
      date: "Mar 7, 2026",
      routeName: "Georgetown Corridor",
      stopsDone: 6,
      stopsTotal: 6,
      deliveriesCompleted: 6,
      notesCount: 0,
    },
  ],
};

const performanceMap: Record<string, DriverPerformance> = {
  "DRV-001": { routesCompleted: 48, totalStops: 372, onTimePercent: 94, stopsSkipped: 3 },
  "DRV-002": { routesCompleted: 31, totalStops: 198, onTimePercent: 88, stopsSkipped: 7 },
  "DRV-003": { routesCompleted: 27, totalStops: 215, onTimePercent: 91, stopsSkipped: 2 },
  "DRV-004": { routesCompleted: 22, totalStops: 176, onTimePercent: 96, stopsSkipped: 1 },
  "DRV-005": { routesCompleted: 15, totalStops: 112, onTimePercent: 100, stopsSkipped: 0 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getDriver(id: string): Driver | undefined {
  return drivers.find((d) => d.id === id);
}

export function getDriverRouteRuns(id: string): RouteRun[] {
  return routeRunsMap[id] ?? [];
}

export function getDriverPerformance(id: string): DriverPerformance {
  return (
    performanceMap[id] ?? {
      routesCompleted: 0,
      totalStops: 0,
      onTimePercent: 0,
      stopsSkipped: 0,
    }
  );
}

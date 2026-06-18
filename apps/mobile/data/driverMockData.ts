export type StopStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";

export interface StopItem {
  id: string;
  name: string;
  unit: string;
  orderedQty: number;
}

export interface RouteStop {
  id: string;
  stopNumber: number;
  businessName: string;
  address: string; // full street address
  mapsQuery: string; // address string passed to Maps deeplink
  items: StopItem[];
  status: StopStatus;
}

export interface DriverRoute {
  id: string;
  name: string;
  status: "ACTIVE" | "COMPLETED" | "DRAFT";
  date: string; // ISO date
  stops: RouteStop[];
}

export const MOCK_ROUTE: DriverRoute = {
  id: "RT-482",
  name: "Route RF-12",
  status: "ACTIVE",
  date: "2024-12-12T07:00:00Z",
  stops: [
    {
      id: "s1",
      stopNumber: 1,
      businessName: "Sunrise Café",
      address: "14 Harbour St, Sydney NSW 2000",
      mapsQuery: "14 Harbour St Sydney NSW 2000",
      status: "COMPLETED",
      items: [
        { id: "i1", name: "Cherry Tomatoes", unit: "per punnet (250g)", orderedQty: 2 },
        { id: "i2", name: "Baby Spinach", unit: "per bag (200g)", orderedQty: 3 },
        { id: "i3", name: "Full Cream Milk", unit: "per 2L", orderedQty: 4 },
      ],
    },
    {
      id: "s2",
      stopNumber: 2,
      businessName: "The Golden Spoon",
      address: "72 King St, Sydney NSW 2000",
      mapsQuery: "72 King St Sydney NSW 2000",
      status: "COMPLETED",
      items: [
        { id: "i4", name: "Basmati Rice", unit: "per 1kg bag", orderedQty: 2 },
        { id: "i5", name: "Penne Pasta", unit: "per 500g pack", orderedQty: 3 },
      ],
    },
    {
      id: "s3",
      stopNumber: 3,
      businessName: "Ocean Breeze Restaurant",
      address: "8 Marine Parade, Manly NSW 2095",
      mapsQuery: "8 Marine Parade Manly NSW 2095",
      status: "IN_PROGRESS",
      items: [
        { id: "i6", name: "Tasty Cheddar", unit: "per 500g block", orderedQty: 1 },
        { id: "i7", name: "Butter Croissants", unit: "pack of 4", orderedQty: 2 },
        { id: "i8", name: "Sparkling Water", unit: "6-pack (500mL each)", orderedQty: 3 },
        { id: "i9", name: "Sourdough Loaf", unit: "per loaf", orderedQty: 2 },
      ],
    },
    {
      id: "s4",
      stopNumber: 4,
      businessName: "Blue Hills Bakery",
      address: "35 Victoria Rd, Parramatta NSW 2150",
      mapsQuery: "35 Victoria Rd Parramatta NSW 2150",
      status: "PENDING",
      items: [
        { id: "i10", name: "Greek Yoghurt", unit: "per 900g tub", orderedQty: 4 },
        { id: "i11", name: "Carrots", unit: "per kg", orderedQty: 2 },
      ],
    },
    {
      id: "s5",
      stopNumber: 5,
      businessName: "Garden Terrace",
      address: "120 Pacific Hwy, North Sydney NSW 2060",
      mapsQuery: "120 Pacific Hwy North Sydney NSW 2060",
      status: "PENDING",
      items: [
        { id: "i12", name: "Fresh Orange Juice", unit: "per 2L bottle", orderedQty: 2 },
        { id: "i13", name: "Full Cream Milk", unit: "per 2L", orderedQty: 3 },
        { id: "i14", name: "Baby Spinach", unit: "per bag (200g)", orderedQty: 2 },
      ],
    },
  ],
};

// ─── Driver Profile ────────────────────────────────────────────────────────────

export const MOCK_DRIVER = {
  name: "Sam Mitchell",
  vehicleMake: "Ford Transit",
  vehicleColour: "White",
  vehiclePlate: "XYZ 123",
};

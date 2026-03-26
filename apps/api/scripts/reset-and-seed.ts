/**
 * Reset database (keep operator user) and seed fresh demo data.
 * Run: cd apps/api && npx ts-node --project tsconfig.json scripts/reset-and-seed.ts
 */

import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("🗑  Clearing existing data (keeping operator users)...");

  // Delete in dependency order
  await prisma.message.deleteMany();
  await prisma.routeRunStopItem.deleteMany();
  await prisma.routeRunStop.deleteMany();
  await prisma.mileageEntry.deleteMany();
  await prisma.routeRun.deleteMany();
  await prisma.route.deleteMany();
  await prisma.returnItem.deleteMany();
  await prisma.return.deleteMany();
  await prisma.creditNote.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoiceLineItem.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.orderTemplateItem.deleteMany();
  await prisma.orderTemplate.deleteMany();
  await prisma.inventoryPurchase.deleteMany();
  await prisma.inventoryAdjustment.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.driver.deleteMany();
  // Delete non-operator users
  await prisma.user.deleteMany({ where: { role: { not: "OPERATOR" } } });
  await prisma.product.deleteMany();
  await prisma.supplier.deleteMany();

  console.log("✅ Data cleared.\n");

  // ─── Suppliers ──────────────────────────────────────────────────────────────
  console.log("📦 Creating suppliers...");
  const suppliers = await Promise.all([
    prisma.supplier.create({ data: { name: "FreshFarm Co.", contactName: "Alice Martin", email: "alice@freshfarm.com", phone: "555-0101", address: "12 Farm Lane, Fresno CA" } }),
    prisma.supplier.create({ data: { name: "Metro Beverages Ltd.", contactName: "Bob Chen", email: "bob@metrobev.com", phone: "555-0102", address: "45 Drink St, Chicago IL" } }),
    prisma.supplier.create({ data: { name: "CleanPro Supply", contactName: "Carol White", email: "carol@cleanpro.com", phone: "555-0103", address: "8 Wash Ave, Seattle WA" } }),
    prisma.supplier.create({ data: { name: "Snack Nation Inc.", contactName: "Dave Kim", email: "dave@snacknation.com", phone: "555-0104", address: "99 Crunch Blvd, Austin TX" } }),
    prisma.supplier.create({ data: { name: "Pacific Waters", contactName: "Emma Lopez", email: "emma@pacwaters.com", phone: "555-0105", address: "1 Ocean Dr, Portland OR" } }),
    prisma.supplier.create({ data: { name: "GreenLeaf Organics", contactName: "Frank Nguyen", email: "frank@greenleaf.com", phone: "555-0106", address: "33 Organic Way, Denver CO" } }),
    prisma.supplier.create({ data: { name: "TechPack Solutions", contactName: "Grace Park", email: "grace@techpack.com", phone: "555-0107", address: "77 Pack Rd, Nashville TN" } }),
    prisma.supplier.create({ data: { name: "Dairy Direct", contactName: "Henry Liu", email: "henry@dairydirect.com", phone: "555-0108", address: "5 Milk Lane, Madison WI" } }),
    prisma.supplier.create({ data: { name: "Bakery Wholesale", contactName: "Isla Turner", email: "isla@bakerywholesale.com", phone: "555-0109", address: "22 Dough St, Boston MA" } }),
    prisma.supplier.create({ data: { name: "Continental Goods", contactName: "Jack Morris", email: "jack@contgoods.com", phone: "555-0110", address: "15 Import Blvd, Miami FL" } }),
  ]);
  console.log(`  ✓ ${suppliers.length} suppliers`);

  // ─── Products ───────────────────────────────────────────────────────────────
  console.log("🛒 Creating products...");
  const products = await Promise.all([
    prisma.product.create({ data: { name: "Whole Milk 1gal", sku: "MILK-001", barcode: "1234567890001", unit: "jug", pricePerUnit: 4.99, stockQuantity: 120, category: "Dairy", supplierId: suppliers[7].id, isActive: true } }),
    prisma.product.create({ data: { name: "Orange Juice 2L", sku: "OJ-002", barcode: "1234567890002", unit: "bottle", pricePerUnit: 5.49, stockQuantity: 80, category: "Beverages", supplierId: suppliers[1].id, isActive: true } }),
    prisma.product.create({ data: { name: "Sparkling Water 12pk", sku: "WATER-003", barcode: "1234567890003", unit: "case", pricePerUnit: 8.99, stockQuantity: 60, category: "Beverages", supplierId: suppliers[4].id, isActive: true } }),
    prisma.product.create({ data: { name: "Sourdough Bread Loaf", sku: "BREAD-004", barcode: "1234567890004", unit: "loaf", pricePerUnit: 6.50, stockQuantity: 45, category: "Bakery", supplierId: suppliers[8].id, isActive: true } }),
    prisma.product.create({ data: { name: "Mixed Salad Greens 5oz", sku: "SALAD-005", barcode: "1234567890005", unit: "bag", pricePerUnit: 3.99, stockQuantity: 90, category: "Produce", supplierId: suppliers[5].id, isActive: true } }),
    prisma.product.create({ data: { name: "Cheddar Cheese 16oz", sku: "CHSE-006", barcode: "1234567890006", unit: "block", pricePerUnit: 7.99, stockQuantity: 55, category: "Dairy", supplierId: suppliers[7].id, isActive: true } }),
    prisma.product.create({ data: { name: "Trail Mix 20oz", sku: "TRAIL-007", barcode: "1234567890007", unit: "bag", pricePerUnit: 9.49, stockQuantity: 70, category: "Snacks", supplierId: suppliers[3].id, isActive: true } }),
    prisma.product.create({ data: { name: "All-Purpose Cleaner 32oz", sku: "CLEAN-008", barcode: "1234567890008", unit: "bottle", pricePerUnit: 3.49, stockQuantity: 200, category: "Cleaning", supplierId: suppliers[2].id, isActive: true } }),
    prisma.product.create({ data: { name: "Paper Towels 6-roll", sku: "PTOWEL-009", barcode: "1234567890009", unit: "pack", pricePerUnit: 11.99, stockQuantity: 110, category: "Cleaning", supplierId: suppliers[6].id, isActive: true } }),
    prisma.product.create({ data: { name: "Granola Bars 12pk", sku: "GRAN-010", barcode: "1234567890010", unit: "box", pricePerUnit: 8.49, stockQuantity: 85, category: "Snacks", supplierId: suppliers[3].id, isActive: true } }),
    prisma.product.create({ data: { name: "Greek Yogurt 32oz", sku: "YOGURT-011", barcode: "1234567890011", unit: "tub", pricePerUnit: 6.99, stockQuantity: 65, category: "Dairy", supplierId: suppliers[7].id, isActive: true } }),
    prisma.product.create({ data: { name: "Cold Brew Coffee 32oz", sku: "CBREW-012", barcode: "1234567890012", unit: "bottle", pricePerUnit: 6.99, stockQuantity: 4, category: "Beverages", supplierId: suppliers[1].id, isActive: true } }),
  ]);
  console.log(`  ✓ ${products.length} products`);

  // ─── Users + Customers ──────────────────────────────────────────────────────
  console.log("👥 Creating customers...");
  const passwordHash = await bcrypt.hash("Customer1!", 10);
  const customerData = [
    { email: "bright@cafe.com",    name: "Bright Star Cafe",     contact: "Sara Bright",   phone: "555-1001", address: "101 Main St, Denver CO" },
    { email: "metro@deli.com",     name: "Metro Deli",           contact: "Tom Metro",     phone: "555-1002", address: "202 Oak Ave, Chicago IL" },
    { email: "sunrise@bistro.com", name: "Sunrise Bistro",       contact: "Lily Sun",      phone: "555-1003", address: "303 Elm Rd, Austin TX" },
    { email: "harbor@grill.com",   name: "Harbor Grill",         contact: "Mark Harbor",   phone: "555-1004", address: "404 Pine Blvd, Seattle WA" },
    { email: "corner@kitchen.com", name: "Corner Kitchen",       contact: "Nora Corner",   phone: "555-1005", address: "505 Maple Dr, Portland OR" },
    { email: "peak@bakery.com",    name: "Peak Bakery",          contact: "Oscar Peak",    phone: "555-1006", address: "606 Cedar Ln, Boston MA" },
    { email: "valley@foods.com",   name: "Valley Fresh Foods",   contact: "Pat Valley",    phone: "555-1007", address: "707 Birch Way, Nashville TN" },
    { email: "summit@catering.com",name: "Summit Catering",      contact: "Quinn Summit",  phone: "555-1008", address: "808 Walnut Ct, Miami FL" },
    { email: "grove@market.com",   name: "Grove Market",         contact: "Rita Grove",    phone: "555-1009", address: "909 Spruce St, Denver CO" },
    { email: "tide@restaurant.com",name: "Tide Restaurant",      contact: "Sam Tide",      phone: "555-1010", address: "1010 Ash Ave, Madison WI" },
  ];

  const customers = [];
  for (const d of customerData) {
    const user = await prisma.user.create({
      data: { email: d.email, passwordHash, name: d.contact, role: "CUSTOMER", status: "ACTIVE" },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: d.name, contactName: d.contact, email: d.email, phone: d.phone, address: d.address, creditLimit: 5000, outstandingBalance: 0 },
    });
    customers.push(customer);
  }
  console.log(`  ✓ ${customers.length} customers`);

  // ─── Drivers ────────────────────────────────────────────────────────────────
  console.log("🚚 Creating drivers...");
  const driverPasswordHash = await bcrypt.hash("Driver1!", 10);
  const driverData = [
    { email: "alex.driver@routeflow.com",  name: "Alex Johnson",  phone: "555-2001", license: "DL-A1001" },
    { email: "brian.driver@routeflow.com", name: "Brian Smith",   phone: "555-2002", license: "DL-B1002" },
    { email: "claire.driver@routeflow.com",name: "Claire Davis",  phone: "555-2003", license: "DL-C1003" },
    { email: "derek.driver@routeflow.com", name: "Derek Wilson",  phone: "555-2004", license: "DL-D1004" },
    { email: "elena.driver@routeflow.com", name: "Elena Brown",   phone: "555-2005", license: "DL-E1005" },
    { email: "frank.driver@routeflow.com", name: "Frank Miller",  phone: "555-2006", license: "DL-F1006" },
    { email: "gina.driver@routeflow.com",  name: "Gina Taylor",   phone: "555-2007", license: "DL-G1007" },
    { email: "hank.driver@routeflow.com",  name: "Hank Anderson", phone: "555-2008", license: "DL-H1008" },
    { email: "iris.driver@routeflow.com",  name: "Iris Thomas",   phone: "555-2009", license: "DL-I1009" },
    { email: "jake.driver@routeflow.com",  name: "Jake Martinez", phone: "555-2010", license: "DL-J1010" },
  ];

  const drivers = [];
  for (const d of driverData) {
    const user = await prisma.user.create({
      data: { email: d.email, passwordHash: driverPasswordHash, name: d.name, role: "DRIVER", status: "ACTIVE" },
    });
    const driver = await prisma.driver.create({
      data: { userId: user.id, name: d.name, email: d.email, phone: d.phone, licenseNumber: d.license, isActive: true },
    });
    drivers.push(driver);
  }
  console.log(`  ✓ ${drivers.length} drivers`);

  // ─── Orders ─────────────────────────────────────────────────────────────────
  console.log("📋 Creating orders...");
  const orderStatuses: Array<"PENDING" | "CONFIRMED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED"> = [
    "DELIVERED", "DELIVERED", "DELIVERED", "DELIVERED",
    "CONFIRMED", "CONFIRMED",
    "OUT_FOR_DELIVERY",
    "PENDING", "PENDING",
    "CANCELLED",
  ];

  const orders = [];
  for (let i = 0; i < 10; i++) {
    const customer = customers[i];
    const status = orderStatuses[i];
    const p1 = products[i % products.length];
    const p2 = products[(i + 1) % products.length];
    const qty1 = 3 + (i % 4);
    const qty2 = 2 + (i % 3);
    const unitPrice1 = Number(p1.pricePerUnit);
    const unitPrice2 = Number(p2.pricePerUnit);
    const subtotal = qty1 * unitPrice1 + qty2 * unitPrice2;
    const tax = subtotal * 0.1;
    const total = subtotal + tax;
    const orderNumber = `ORD-2026-${String(i + 1).padStart(4, "0")}`;
    const createdAt = new Date(2026, 2, 15 + i); // Mar 15–24, 2026

    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        orderNumber,
        status,
        subtotal,
        tax,
        total,
        createdAt,
        lineItems: {
          create: [
            { productId: p1.id, qty: qty1, unitPrice: unitPrice1, subtotal: qty1 * unitPrice1, status: status === "DELIVERED" ? "DELIVERED" : status === "CANCELLED" ? "CANCELLED" : "PENDING" },
            { productId: p2.id, qty: qty2, unitPrice: unitPrice2, subtotal: qty2 * unitPrice2, status: status === "DELIVERED" ? "DELIVERED" : status === "CANCELLED" ? "CANCELLED" : "PENDING" },
          ],
        },
      },
    });
    orders.push(order);
  }
  console.log(`  ✓ ${orders.length} orders`);

  // ─── Routes ─────────────────────────────────────────────────────────────────
  console.log("🗺  Creating routes...");
  const routeStatuses: Array<"SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED"> = [
    "COMPLETED", "COMPLETED", "COMPLETED",
    "IN_PROGRESS",
    "SCHEDULED", "SCHEDULED", "SCHEDULED",
    "COMPLETED",
    "SCHEDULED",
    "CANCELLED",
  ];

  const routes = [];
  for (let i = 0; i < 10; i++) {
    const driver = drivers[i];
    const routeStatus = routeStatuses[i];
    const scheduledDate = new Date(2026, 2, 20 + i);

    const run = await prisma.routeRun.create({
      data: {
        driverId: driver.id,
        name: `Route ${String.fromCharCode(65 + i)} — March ${20 + i}`,
        status: routeStatus,
        scheduledDate,
        stops: {
          create: orders.slice(i % 5, (i % 5) + 2).map((order, si) => ({
            orderId: order.id,
            stopNumber: si + 1,
            address: customers[(i + si) % customers.length].address ?? "",
            status: routeStatus === "COMPLETED" ? "COMPLETED" : "PENDING",
            lat: 39.7 + si * 0.01,
            lng: -104.9 + si * 0.01,
          })),
        },
      },
    });
    routes.push(run);
  }
  console.log(`  ✓ ${routes.length} routes`);

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log("\n🎉 Seed complete!");
  console.log(`   ${suppliers.length} suppliers`);
  console.log(`   ${products.length} products (with barcodes)`);
  console.log(`   ${customers.length} customers`);
  console.log(`   ${drivers.length} drivers`);
  console.log(`   ${orders.length} orders`);
  console.log(`   ${routes.length} routes`);
  console.log("\n📱 Customer logins: <email> / Customer1!");
  console.log("🚚 Driver logins:   <email> / Driver1!");
  console.log("   e.g. alex.driver@routeflow.com / Driver1!");
  console.log("   e.g. bright@cafe.com / Customer1!");
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

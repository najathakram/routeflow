// @ts-nocheck
"use strict";

const { PrismaClient } = require("../../../node_modules/@prisma/client");
const { PrismaPg } = require("../../../node_modules/@prisma/adapter-pg");
const { Pool } = require("../../../node_modules/pg");
const fs = require("fs");
const { parse } = require("../../../node_modules/csv-parse/lib/sync");
const crypto = require("crypto");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL not set. Point it at the target database explicitly before importing.",
  );
  process.exit(1);
}
if (!process.argv.includes("--execute")) {
  console.error(
    "This importer writes directly to the target database. Re-run with --execute to proceed.",
  );
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const DOWNLOADS = process.env.ZOHO_CSV_DIR || "C:/Users/nakram/Downloads";

function readCsv(filename) {
  const content = fs.readFileSync(`${DOWNLOADS}/${filename}`, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });
}

function mapPaymentMethod(method) {
  const m = (method || "").toLowerCase().trim();
  if (m === "cash") return "CASH";
  if (m === "check" || m === "cheque") return "CHECK";
  if (m === "zelle" || m === "ach" || m === "wire") return "ACH";
  return "OTHER";
}

function mapInvoiceStatus(zohoStatus) {
  const s = (zohoStatus || "").toLowerCase().trim();
  if (s === "closed" || s === "paid") return "PAID";
  if (s === "overdue") return "OVERDUE";
  if (s === "draft") return "DRAFT";
  if (s.includes("partial")) return "PARTIAL";
  if (s === "void" || s === "voided") return "VOID";
  return "SENT";
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function parseDate(str) {
  if (!str || str.trim() === "") return null;
  try {
    const d = new Date(str.trim());
    if (isNaN(d.getTime())) return null;
    return d;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log("Reading CSV files...");
  const contacts = readCsv("Contacts.csv");
  const payments = readCsv("Customer_Payment.csv");
  const expenses = readCsv("Expense.csv");

  console.log(
    `Contacts: ${contacts.length}, Payments: ${payments.length}, Expenses: ${expenses.length}`,
  );

  let invoiceCsv = [];
  try {
    invoiceCsv = readCsv("Invoice.csv");
    console.log(`Invoice rows (line items): ${invoiceCsv.length}`);
  } catch (e) {
    console.error("Invoice CSV parse error:", e.message);
  }

  // ── STEP 1: CLEAR EXISTING DATA ───────────────────────────────────────────
  console.log("\nClearing existing data...");

  // Order matters: children before parents
  await prisma.invoicePayment.deleteMany({});
  console.log("  ✓ Invoice payments cleared");

  await prisma.invoiceItem.deleteMany({});
  console.log("  ✓ Invoice items cleared");

  await prisma.invoice.deleteMany({});
  console.log("  ✓ Invoices cleared");

  // Clear estimates
  try {
    await prisma.estimateItem.deleteMany({});
  } catch (e) {}
  try {
    await prisma.estimate.deleteMany({});
  } catch (e) {}

  // Credit notes
  try {
    await prisma.creditNote.deleteMany({});
  } catch (e) {}

  // Recurring invoices
  try {
    await prisma.recurringInvoiceItem.deleteMany({});
  } catch (e) {}
  try {
    await prisma.recurringInvoice.deleteMany({});
  } catch (e) {}

  // Advance payments
  try {
    await prisma.advancePayment.deleteMany({});
  } catch (e) {}

  // Orders and routes
  try {
    await prisma.deliveryMutation.deleteMany({});
  } catch (e) {}
  try {
    await prisma.transactionItem.deleteMany({});
  } catch (e) {}
  try {
    await prisma.payment.deleteMany({});
  } catch (e) {}
  try {
    await prisma.transaction.deleteMany({});
  } catch (e) {}
  try {
    await prisma.orderItem.deleteMany({});
  } catch (e) {}
  try {
    await prisma.returnItem.deleteMany({});
  } catch (e) {}
  try {
    await prisma.return.deleteMany({});
  } catch (e) {}
  try {
    await prisma.order.deleteMany({});
  } catch (e) {}
  try {
    await prisma.routeRunStop.deleteMany({});
  } catch (e) {}
  try {
    await prisma.routeRun.deleteMany({});
  } catch (e) {}
  try {
    await prisma.routeStop.deleteMany({});
  } catch (e) {}
  try {
    await prisma.routeCustomer.deleteMany({});
  } catch (e) {}
  try {
    await prisma.route.deleteMany({});
  } catch (e) {}
  try {
    await prisma.orderTemplateItem.deleteMany({});
  } catch (e) {}
  try {
    await prisma.orderTemplate.deleteMany({});
  } catch (e) {}
  console.log("  ✓ Orders, routes, and templates cleared");

  // Expenses
  await prisma.expense.deleteMany({});
  console.log("  ✓ Expenses cleared");

  // Clear customer addresses then customers (and their linked CUSTOMER users)
  await prisma.customerAddress.deleteMany({});
  await prisma.customer.deleteMany({});

  // Delete User records that were created for customers (role = CUSTOMER)
  await prisma.refreshToken.deleteMany({ where: { user: { role: "CUSTOMER" } } });
  await prisma.deviceToken.deleteMany({ where: { user: { role: "CUSTOMER" } } });
  await prisma.user.deleteMany({ where: { role: "CUSTOMER" } });
  console.log("  ✓ Customers (and linked users) cleared");

  // ── STEP 2: ENSURE EXPENSE CATEGORIES EXIST ──────────────────────────────
  console.log("\nEnsuring expense categories...");
  const catMap = {};

  const expenseCategoryNames = [
    ...new Set(expenses.map((e) => e["Expense Category"]).filter(Boolean)),
  ];
  for (const catName of expenseCategoryNames) {
    let code = catName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 20);
    let cat = await prisma.expenseCategory.findFirst({ where: { name: catName } });
    if (!cat) {
      // Ensure unique code
      let attempt = code;
      let suffix = 1;
      while (true) {
        try {
          cat = await prisma.expenseCategory.create({
            data: { name: catName, code: attempt, isCustom: true },
          });
          break;
        } catch (e) {
          if (e.code === "P2002") {
            attempt = code.slice(0, 17) + "_" + suffix++;
          } else {
            throw e;
          }
        }
      }
    }
    catMap[catName] = cat.id;
    console.log(`  ✓ Category: ${catName} (${cat.id})`);
  }

  // ── STEP 3: IMPORT CUSTOMERS ──────────────────────────────────────────────
  console.log("\nImporting customers...");

  // zohoContactId -> routeflow Customer.id
  const zohoIdToCustomerId = {};
  // zohoContactId -> routeflow Customer.id (also keyed by Customer Name for invoice matching)
  const customerNameToId = {};

  let customerCount = 0;
  const usedUsernames = new Set();

  for (const contact of contacts) {
    const zohoId = contact["Customer ID"] || contact["Primary Contact ID"];
    const businessName =
      contact["Customer Name"] || contact["Display Name"] || contact["Company Name"];

    if (!businessName || businessName.trim() === "") continue;
    const name = businessName.trim();

    // Build username: slugified business name, guaranteed unique
    let baseUsername = "cust_" + slugify(name);
    let username = baseUsername;
    let uSuffix = 1;
    while (usedUsernames.has(username)) {
      username = baseUsername + "_" + uSuffix++;
    }
    usedUsernames.add(username);

    // Address fields from billing info
    const line1 = (contact["Billing Address"] || "").trim();
    const line2 = (contact["Billing Street2"] || "").trim() || null;
    const city = (contact["Billing City"] || "").trim();
    const state = (contact["Billing State"] || "").trim();
    const zip = (contact["Billing Code"] || "").trim();

    // Phone: prefer Billing Phone, then MobilePhone, then Phone field
    const phone =
      (contact["Billing Phone"] || contact["MobilePhone"] || contact["Phone"] || "")
        .replace(/['+]/g, "")
        .trim() || null;

    const email = (contact["EmailID"] || "").trim() || null;
    const contactName =
      [contact["First Name"], contact["Last Name"]].filter(Boolean).join(" ").trim() ||
      contact["Billing Attention"]?.trim() ||
      name;

    const notes = (contact["Notes"] || "").trim() || null;

    try {
      // Create the User record first (required FK)
      const randomPw = crypto.randomBytes(16).toString("hex"); // not a real login password

      // Try original email first, fall back to generated one if already taken
      let user = null;
      const emailsToTry = email
        ? [email, `${username}@import.local`]
        : [`${username}@import.local`];

      for (const tryEmail of emailsToTry) {
        try {
          user = await prisma.user.create({
            data: {
              email: tryEmail,
              username,
              password: randomPw,
              role: "CUSTOMER",
              status: "ACTIVE",
            },
          });
          break;
        } catch (ue) {
          if (ue.code === "P2002") continue; // unique constraint — try next email
          throw ue;
        }
      }

      if (!user) {
        // Last resort: use a fully random email
        user = await prisma.user.create({
          data: {
            email: `${username}_${crypto.randomBytes(4).toString("hex")}@import.local`,
            username: `${username}_${crypto.randomBytes(4).toString("hex")}`,
            password: randomPw,
            role: "CUSTOMER",
            status: "ACTIVE",
          },
        });
      }

      const customer = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: name,
          contactName: contactName || name,
          phone,
          notes,
          zohoContactId: zohoId || null,
        },
      });

      // Create default CustomerAddress if we have enough info
      if (line1 || city) {
        await prisma.customerAddress.create({
          data: {
            customerId: customer.id,
            label: "default",
            line1: line1 || city || "N/A",
            line2,
            city: city || "",
            state: state || "",
            zip: zip || "",
            isDefault: true,
          },
        });
      }

      if (zohoId) zohoIdToCustomerId[zohoId] = customer.id;
      customerNameToId[name.toLowerCase()] = customer.id;
      customerCount++;
    } catch (e) {
      console.error(`  Failed to create customer "${name}": ${e.message}`);
    }
  }
  console.log(`  ✓ Imported ${customerCount} customers`);

  // ── STEP 4: IMPORT INVOICES FROM Invoice.csv ──────────────────────────────
  console.log("\nImporting invoices...");

  const invoiceNumberToId = {};
  let invoiceCount = 0;
  let invoiceSeq = 1;
  const year = new Date().getFullYear();

  if (invoiceCsv.length > 0) {
    // Group line-item rows by Zoho Invoice ID
    const invoiceGroups = {};
    for (const row of invoiceCsv) {
      const invId = row["Invoice ID"];
      if (!invId || invId.trim() === "") continue;
      if (!invoiceGroups[invId]) invoiceGroups[invId] = [];
      invoiceGroups[invId].push(row);
    }

    console.log(`  Grouped into ${Object.keys(invoiceGroups).length} unique invoices`);

    for (const [zohoInvId, rows] of Object.entries(invoiceGroups)) {
      const first = rows[0];
      const zohoCustomerId = first["Customer ID"];
      const customerName = (first["Customer Name"] || "").trim();

      // Resolve customer
      let customerId = zohoIdToCustomerId[zohoCustomerId];
      if (!customerId && customerName) {
        customerId = customerNameToId[customerName.toLowerCase()];
      }
      if (!customerId) {
        console.warn(
          `  Skipping invoice ${first["Invoice Number"]} — customer not found (${customerName})`,
        );
        continue;
      }

      const zohoInvNumber = (first["Invoice Number"] || "").trim();
      const invoiceNumber = zohoInvNumber || `INV-${year}-${String(invoiceSeq).padStart(4, "0")}`;
      invoiceSeq++;

      // Financials
      const total = parseFloat(first["Total"] || "0") || 0;
      const subtotal = parseFloat(first["SubTotal"] || "0") || total;
      const discount = parseFloat(first["Entity Discount Amount"] || "0") || 0;
      const shippingFee = parseFloat(first["Shipping Charge"] || "0") || 0;

      // Dates
      const issueDate = parseDate(first["Invoice Date"] || first["Issued Date"]) || new Date();
      const dueDate = parseDate(first["Due Date"]);

      const status = mapInvoiceStatus(first["Invoice Status"]);
      const paidAt =
        status === "PAID" ? parseDate(first["Last Payment Date"]) || dueDate || issueDate : null;

      const notes = (first["Notes"] || "").replace(/\n/g, " ").trim() || null;
      const terms = (first["Terms & Conditions"] || "").replace(/\n/g, " ").trim() || null;

      // Build line items
      const itemsData = rows
        .map((row) => {
          const itemName = (row["Item Name"] || "").replace(/[\n\r]/g, " ").trim();
          const qty = parseFloat(row["Quantity"] || "1") || 1;
          const unitPrice = parseFloat(row["Item Price"] || "0") || 0;
          const itemDiscount = parseFloat(row["Discount Amount"] || "0") || 0;
          const itemTotal = parseFloat(row["Item Total"] || "0") || qty * unitPrice - itemDiscount;
          return {
            description: itemName || "Item",
            qty,
            unitPrice,
            discount: itemDiscount,
            taxRate: 0,
            subtotal: itemTotal,
          };
        })
        .filter((item) => item.qty > 0);

      if (itemsData.length === 0) {
        itemsData.push({
          description: "Services",
          qty: 1,
          unitPrice: total,
          discount: 0,
          taxRate: 0,
          subtotal: total,
        });
      }

      try {
        const invoice = await prisma.invoice.create({
          data: {
            invoiceNumber,
            customerId,
            status,
            subtotal,
            taxAmount: 0,
            discount,
            shippingFee,
            total,
            issueDate,
            dueDate,
            paidAt,
            notes,
            terms,
            items: { create: itemsData },
          },
        });

        invoiceNumberToId[invoiceNumber] = invoice.id;
        if (zohoInvNumber && zohoInvNumber !== invoiceNumber) {
          invoiceNumberToId[zohoInvNumber] = invoice.id;
        }
        invoiceCount++;
      } catch (e) {
        if (e.code === "P2002") {
          // Duplicate invoice number — add suffix and retry
          const fallbackNumber = `${invoiceNumber}-${invoiceSeq}`;
          try {
            const invoice = await prisma.invoice.create({
              data: {
                invoiceNumber: fallbackNumber,
                customerId,
                status,
                subtotal,
                taxAmount: 0,
                discount,
                shippingFee,
                total,
                issueDate,
                dueDate,
                paidAt,
                notes,
                terms,
                items: { create: itemsData },
              },
            });
            invoiceNumberToId[fallbackNumber] = invoice.id;
            if (zohoInvNumber) invoiceNumberToId[zohoInvNumber] = invoice.id;
            invoiceCount++;
          } catch (e2) {
            console.error(`  Failed invoice ${invoiceNumber} (retry): ${e2.message}`);
          }
        } else {
          console.error(`  Failed invoice ${invoiceNumber}: ${e.message}`);
        }
      }
    }
  }
  console.log(`  ✓ Imported ${invoiceCount} invoices`);

  // ── STEP 5: IMPORT PAYMENTS ───────────────────────────────────────────────
  console.log("\nImporting payments...");
  let paymentCount = 0;

  for (const p of payments) {
    const zohoInvNumber = (p["Invoice Number"] || "").trim();
    const invoiceId = invoiceNumberToId[zohoInvNumber];
    if (!invoiceId) continue;

    const amount = parseFloat(p["Amount Applied to Invoice"] || p["Amount"] || "0");
    if (amount <= 0) continue;

    const method = mapPaymentMethod(p["Mode"]);
    const reference = (p["Reference Number"] || "").trim() || null;
    const paidAt = parseDate(p["Date"] || p["Invoice Payment Applied Date"]) || new Date();

    try {
      await prisma.invoicePayment.create({
        data: {
          invoiceId,
          amount,
          method,
          reference,
          paidAt,
        },
      });
      paymentCount++;
    } catch (e) {
      // Skip duplicates or validation errors silently
    }
  }
  console.log(`  ✓ Imported ${paymentCount} payments`);

  // ── STEP 6: RECONCILE INVOICE STATUSES ───────────────────────────────────
  console.log("\nReconciling invoice statuses based on actual payments...");
  const allInvoices = await prisma.invoice.findMany({ include: { payments: true } });
  const now = new Date();
  let statusUpdates = 0;

  for (const inv of allInvoices) {
    const totalPaid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    const total = Number(inv.total);
    let newStatus = inv.status;

    if (totalPaid >= total - 0.01 && total > 0) {
      newStatus = "PAID";
    } else if (totalPaid > 0) {
      newStatus = "PARTIAL";
    } else if (inv.dueDate && inv.dueDate < now && inv.status === "SENT") {
      newStatus = "OVERDUE";
    }

    if (newStatus !== inv.status) {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          status: newStatus,
          paidAt: newStatus === "PAID" ? inv.paidAt || now : inv.paidAt,
        },
      });
      statusUpdates++;
    }
  }
  console.log(`  ✓ Updated ${statusUpdates} invoice statuses`);

  // ── STEP 7: IMPORT EXPENSES ───────────────────────────────────────────────
  console.log("\nImporting expenses...");
  let expenseCount = 0;

  for (const e of expenses) {
    const catName = e["Expense Category"];
    const categoryId = catMap[catName];
    if (!categoryId) {
      console.warn(`  Skipping expense — unknown category: "${catName}"`);
      continue;
    }

    const amount = parseFloat(e["Total"] || e["Expense Amount"] || "0");
    if (amount <= 0) continue;

    const date = parseDate(e["Expense Date"]) || new Date();
    const description = (e["Expense Description"] || "").trim() || null;
    const reference = (e["Reference#"] || "").trim() || null;
    const paymentMethod = (e["Payment Mode"] || "").trim() || null;

    try {
      await prisma.expense.create({
        data: {
          categoryId,
          amount,
          date,
          description,
          paymentMethod,
          notes: reference || null,
          performedById: null,
        },
      });
      expenseCount++;
    } catch (e2) {
      console.error(`  Failed expense "${description}": ${e2.message}`);
    }
  }
  console.log(`  ✓ Imported ${expenseCount} expenses`);

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log("\n=== IMPORT COMPLETE ===");
  const [custCount, invCount, payCount, expCount] = await Promise.all([
    prisma.customer.count(),
    prisma.invoice.count(),
    prisma.invoicePayment.count(),
    prisma.expense.count(),
  ]);
  console.log(`Customers:  ${custCount}`);
  console.log(`Invoices:   ${invCount}`);
  console.log(`Payments:   ${payCount}`);
  console.log(`Expenses:   ${expCount}`);

  // Sample output
  const sampleCustomers = await prisma.customer.findMany({
    take: 5,
    select: { businessName: true, phone: true, zohoContactId: true },
  });
  console.log("\nSample customers:");
  sampleCustomers.forEach((c) =>
    console.log(`  ${c.businessName}  phone=${c.phone}  zohoId=${c.zohoContactId}`),
  );

  const sampleInvoices = await prisma.invoice.findMany({
    take: 5,
    include: { customer: { select: { businessName: true } } },
    orderBy: { createdAt: "desc" },
  });
  console.log("\nSample invoices:");
  sampleInvoices.forEach((i) =>
    console.log(`  ${i.invoiceNumber}  ${i.customer.businessName}  ${i.status}  $${i.total}`),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
